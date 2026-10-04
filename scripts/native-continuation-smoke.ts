import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBody } from "../src/client/MessageBody";
import { toPublicMessage } from "../src/kernel/public-projection";
import { Kernel } from "../src/kernel/kernel";
import { RunEventBus } from "../src/kernel/event-bus";
import { SQLiteStore } from "../src/store/sqlite";
import { ToolRegistry } from "../src/tools/registry";
import { OpenAIChatGPTProvider, buildCodexRequestPayload } from "../src/providers/openai-chatgpt";
import { OpenAICompatibleProvider, buildOpenAICompatibleRequestMessages } from "../src/providers/openai-compatible";
import type { ProviderRegistry } from "../src/providers/registry";
import type { Message, MessagePart, ProviderProfile } from "../src/shared/types";
import { defaultToolSettings } from "../src/shared/tool-settings";
import { currentRunToolTranscript, NativeTranscriptError } from "../src/kernel/tool-transcript";
import { planContext, resolveContextBudget, estimateTextTokens, estimateJsonTokens } from "../src/kernel/context-budget";

type NativeCall = {id:string; name:string; arguments:string};
type Flavor = "codex" | "compatible";
const sentinel = "ACTUAL_FAKE_TOOL_STDOUT_UNIQUE_4721";
const preToolText = "ASSISTANT_PRE_TOOL_TEXT_7250";
const batchABText = `${preToolText}_BATCH_AB`;
const batchCText = `${preToolText}_BATCH_C`;
const verifyText = "ASSISTANT_VERIFY_AFTER_CHILD_INPUT";

function wireItems(body:any,flavor:Flavor): any[] { return flavor==="codex"?body.input:body.messages; }
function wireCallIndex(items:any[],flavor:Flavor,id:string):number {
  return items.findIndex((item)=>flavor==="codex"?item.type==="function_call"&&item.call_id===id:item.role==="assistant"&&item.tool_calls?.some((call:any)=>call.id===id));
}
function wireResultIndex(items:any[],flavor:Flavor,id:string):number {
  return items.findIndex((item)=>flavor==="codex"?item.type==="function_call_output"&&item.call_id===id:item.role==="tool"&&item.tool_call_id===id);
}

function nativeBatch(body: any, flavor: Flavor) {
  if (flavor === "codex") return {
    calls:body.input.filter((item:any) => item.type === "function_call").map((item:any) => ({id:item.call_id,name:item.name,arguments:item.arguments})),
    outputs:body.input.filter((item:any) => item.type === "function_call_output").map((item:any) => ({id:item.call_id,text:item.output})),
    ordinary:body.input.filter((item:any) => item.role).map((item:any) => ({role:item.role,content:item.content}))
  };
  return {
    calls:body.messages.flatMap((item:any) => (item.tool_calls??[]).map((call:any) => ({id:call.id,name:call.function.name,arguments:call.function.arguments}))),
    outputs:body.messages.filter((item:any) => item.role === "tool").map((item:any) => ({id:item.tool_call_id,text:item.content})),
    ordinary:body.messages.filter((item:any) => item.role !== "tool").map((item:any) => ({role:item.role,content:item.content??""}))
  };
}

function sendSse(res: express.Response, flavor: Flavor, calls: NativeCall[], text: string) {
  res.setHeader("Content-Type","text/event-stream");
  if (flavor === "codex") {
    if (text) res.write(`data: ${JSON.stringify({type:"response.output_text.delta",delta:text})}\n\n`);
    for (const [index,call] of [...calls.entries()].reverse()) res.write(`data: ${JSON.stringify({type:"response.output_item.done",output_index:index,item:{type:"function_call",id:`fc_${index}_${call.id.slice(-12)}`,call_id:call.id,name:call.name,arguments:call.arguments}})}\n\n`);
    res.end(`data: ${JSON.stringify({type:"response.completed",response:{status:"completed"}})}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({choices:[{delta:{content:text,tool_calls:calls.map((call,index) => ({index,id:call.id,type:"function",function:{name:call.name,arguments:call.arguments}})).reverse()}}]})}\n\n`);
    res.end("data: [DONE]\n\n");
  }
}

async function until(check:()=>boolean, message:string) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) { if(check()) return; await new Promise((resolve)=>setTimeout(resolve,5)); }
  assert.fail(`Timeout: ${message}`);
}

type Mode = "allow"|"ask"|"deny"|"error"|"batch"|"batch-restart"|"iterations"|"restart"|"invalid"|"subsession"|"duplicate"|"missing-id"
  | "mixed-allow"|"mixed-deny"|"mixed-allow-restart"|"mixed-deny-restart"|"mixed-allow-late-restart"|"mixed-deny-late-restart"
  | "subsession-verify"|"subsession-verify-restart";

async function scenario(flavor:Flavor, mode:Mode) {
  const mixed=mode.startsWith("mixed-");
  const denyB=mixed&&mode.includes("deny");
  const subsession=mode.startsWith("subsession");
  const verify=mode.startsWith("subsession-verify");
  const directory=mkdtempSync(join(tmpdir(),"native-continuation-"));
  const calls:NativeCall[]=[{id:`call_${"long_prefix_".repeat(18)}a`,name:"shell_exec",arguments:mode==="invalid"?"{malformed-json":'{ "command" : "pwd", "timeoutMs": 1000 }'}];
  if(mode==="batch"||mode==="batch-restart"||mode==="iterations") calls.push({id:`call_${"long_prefix_".repeat(18)}b`,name:"shell_exec",arguments:'{ "command": "pwd", "timeoutMs" : 2000 }'});
  if(mode==="duplicate") calls.push({...calls[0]});
  if(mode==="missing-id") calls[0].id="";
  if(mixed) {
    calls[0].arguments='{ "command" : "A" }';
    calls.push({id:"call_mixed_B",name:"shell_exec",arguments:'{ "command" : "B" }'},
      {id:"call_mixed_C",name:"shell_exec",arguments:'{ "command" : "C" }'});
  }
  const bodies:any[]=[]; const failures:unknown[]=[]; let sent=0;
  let workerId="", parentCall:NativeCall|null=null, childRequested=false, childFinal=false, parentFinal=false;
  const verifyCall:NativeCall={id:"call_parent_verify",name:"shell_exec",arguments:'{ "command" : "verify" }'};
  let verifyIssued=false;
  const app=express(); app.use(express.json());
  app.post("/responses",(req,res)=>{
    try {
      const body=req.body; bodies.push(body);
      const batch=nativeBatch(body,flavor);
      if(subsession) {
        const instructions=flavor==="codex"?body.instructions:body.messages.filter((m:any)=>m.role==="system").map((m:any)=>m.content).join("\n");
        const isChild=instructions.includes("CHILD_NATIVE_PROFILE");
        assert.equal(batch.ordinary.some((item:any)=>item.role==="user"&&item.content.includes("[tool call")),false);
        if(isChild) {
          if(!childRequested) {childRequested=true;sendSse(res,flavor,calls,preToolText);return;}
          assert.deepEqual(batch.calls,calls);
          assert.equal(batch.outputs.length,1); assert.equal(batch.outputs[0].id,calls[0].id);
          assert.ok(batch.outputs[0].text.includes(sentinel));
          childFinal=true; sendSse(res,flavor,[],"CHILD_NATIVE_ANSWER_SENTINEL"); return;
        }
        if(!parentCall) {
          parentCall={id:"call_parent_spawn",name:"subsession_start",arguments:JSON.stringify({agentId:workerId,task:"Run fake pwd once and answer."})};
          sendSse(res,flavor,[parentCall],preToolText); return;
        }
        assert.deepEqual(batch.calls,verifyIssued?[parentCall,verifyCall]:[parentCall]);
        assert.equal(batch.outputs.length,verifyIssued?2:1,"async child handoff was encoded as a second tool output for the start call");
        assert.equal(batch.outputs.filter((item:any)=>item.id===parentCall!.id).length,1);
        assert.equal(batch.outputs[0].id,parentCall.id);
        assert.ok(batch.outputs[0].text.includes("childSessionId"));
        const handoff=batch.ordinary.find((item:any)=>item.role==="user"&&item.content.includes("[child result handoff]"));
        if(handoff) {
          assert.ok(childFinal); assert.ok(handoff.content.includes("CHILD_NATIVE_ANSWER_SENTINEL"));
          assert.ok(handoff.content.includes("completed=1")); assert.ok(handoff.content.includes(sentinel));
          if(verify&&!verifyIssued) {verifyIssued=true;sendSse(res,flavor,[verifyCall],verifyText);return;}
          if(verifyIssued) {
            const items=wireItems(body,flavor);
            const notification=items.findIndex((item)=>item.role==="user"&&item.content?.includes("[child result handoff]"));
            const responseText=items.findIndex((item)=>item.role==="assistant"&&item.content?.includes(verifyText));
            assert.ok(notification>=0&&notification<responseText,"child input notification replayed after the assistant response that consumed it");
            assert.ok(responseText<=wireCallIndex(items,flavor,verifyCall.id));
            assert.ok(wireCallIndex(items,flavor,verifyCall.id)<wireResultIndex(items,flavor,verifyCall.id));
            assert.ok(batch.outputs[1].text.includes(sentinel));
          }
          parentFinal=true; sendSse(res,flavor,[],"PARENT_FINAL_FROM_CHILD_NOTIFICATION");
        } else sendSse(res,flavor,[],"Parent is waiting for child result.");
        return;
      }
      if(sent>0) {
        assert.deepEqual(batch.calls,calls.slice(0,sent),"native call IDs/names/raw argument JSON were not replayed exactly");
        assert.deepEqual(batch.outputs.map((output:any)=>output.id),calls.slice(0,sent).map((call)=>call.id),"missing or mismatched native tool outputs");
        assert.ok(batch.ordinary.some((item:any)=>item.role==="assistant"&&item.content.includes(preToolText)),"pre-tool assistant text was lost");
        assert.equal(batch.ordinary.some((item:any)=>item.role==="user"&&item.content.includes("[tool call")),false,"native result duplicated as a synthetic user message");
        for(const output of batch.outputs) {
          if(mode==="deny"||mode==="error"||mode==="invalid"||denyB&&output.id===calls[1].id) assert.match(output.text,/failed|denied|Invalid|invalid|fixture error/);
          else assert.ok(output.text.includes(sentinel),"actual tool stdout never reached native result");
        }
        if(mixed) {
          const items=wireItems(body,flavor);
          const ab=items.findIndex((item)=>item.role==="assistant"&&item.content?.includes(batchABText));
          assert.ok(ab>=0&&ab<=wireCallIndex(items,flavor,calls[0].id));
          assert.equal(items[ab].content.includes(batchCText),false,"next provider text was attributed to the pending batch");
          if(sent===3) {
            const c=items.findIndex((item)=>item.role==="assistant"&&item.content?.includes(batchCText));
            assert.ok(wireResultIndex(items,flavor,calls[1].id)<c,"batch C assistant text was replayed before batch A/B completed");
            assert.ok(c<=wireCallIndex(items,flavor,calls[2].id));
            assert.ok(wireCallIndex(items,flavor,calls[2].id)<wireResultIndex(items,flavor,calls[2].id));
          }
        }
      }
      if(sent===calls.length) {sendSse(res,flavor,[],"FINAL_ANSWER_AFTER_NATIVE_OUTPUT"); return;}
      const next=mixed?(sent===0?calls.slice(0,2):calls.slice(2)):mode==="batch"||mode==="batch-restart"?calls:calls.slice(sent,sent+1);
      const text=mixed?(sent===0?batchABText:batchCText):preToolText;
      sent+=next.length;
      sendSse(res,flavor,next,text);
    } catch(error) {failures.push(error); res.status(500).json({error:"Fake transport rejected invalid native continuation"});}
  });
  const server=app.listen(0,"127.0.0.1"); await new Promise<void>((resolve)=>server.once("listening",resolve));
  const address=server.address(); assert.ok(address&&typeof address==="object");
  const endpoint=`http://127.0.0.1:${address.port}/responses`;
  // Chat Completions uses /chat/completions; redirect within this localhost-only fake app.
  app.post("/chat/completions",(req,res)=>{
    req.url="/responses";
    app.handle(req,res);
  });
  const profile:ProviderProfile={id:"native-fixture",name:"Native fixture",type:flavor==="codex"?"openai-chatgpt":"openai-compatible",source:"builtin",enabled:true,
    model:"fixture-model",baseUrl:`http://127.0.0.1:${address.port}`,endpoint,status:{state:"available",message:"fake",credentialStatus:"not_required"}};
  const adapter=flavor==="codex"?new OpenAIChatGPTProvider({credentialStore:{write:async()=>undefined} as never,endpoint}):new OpenAICompatibleProvider();
  const resolved=()=>({adapter,profile,credential:flavor==="codex"?{oauth:{type:"oauth",access:"fake-local-access",expiresAt:Date.now()+3600000}}:{apiKey:"fake-local-key"},providerResolution:{requestedProvider:null,requestedProviderProfileId:null,providerProfileId:profile.id,providerProfileName:profile.name,providerType:profile.type,model:profile.model,fallback:null}});
  const providers={list:()=>({providers:[profile],defaultProviderProfileId:profile.id}),resolveRun:resolved,resolveRunExact:resolved,resolveModelContextCapability:async()=>({windowTokens:32768,source:"adapter"})} as unknown as ProviderRegistry;
  const dbPath=join(directory,"fixture.db");
  let store=new SQLiteStore({dbPath,defaultWorkingDirectory:directory});
  const tools=new ToolRegistry(); let executions=0;
  tools.register({definition:{id:"shell.exec",name:"Fixture shell",description:"No command is executed",source:"builtin",inputSchema:{type:"object",properties:{command:{type:"string"}}},outputSchema:{},metadata:{}},executor:{execute:async (_input,ctx)=>{
    executions++;
    if(mode==="error") throw new Error("fixture error");
    await ctx.emit({invocationId:ctx.invocation.id,toolId:"shell.exec",type:"tool.stdout.delta",createdAt:new Date().toISOString(),payload:{text:sentinel}});
    return {exitCode:0,stdout:sentinel};
  }}});
  let kernel=new Kernel({store,providers,tools,eventBus:new RunEventBus(),toolExecutionCwd:directory});
  try {
    store.setSetting("toolSettings",{...defaultToolSettings,defaultAction:["ask","deny","batch","batch-restart","restart","subsession"].includes(mode)?"ask":"allow"} as never,new Date().toISOString());
    if(mixed) store.setSetting("toolSettings",{...defaultToolSettings,defaultAction:"allow",askPatternsText:mode.includes("late-restart")?"^(A|C)$":"^A$",denyPatternsText:denyB?"^B$":""} as never,new Date().toISOString());
    if(verify) store.setSetting("toolSettings",{...defaultToolSettings,defaultAction:"allow",askPatternsText:mode.endsWith("restart")?"^(pwd|verify)$":"^pwd$"} as never,new Date().toISOString());
    if(subsession) workerId=kernel.createAgentDefinition({name:"Native child",systemPrompt:"CHILD_NATIVE_PROFILE. Use pwd once.",modelProfileId:profile.id,toolIds:["shell.exec"],contextPolicy:{automaticCompaction:false}}).id;
    const agent=kernel.createAgentDefinition({name:"Native fixture",systemPrompt:"Use the fake tool once, then answer.",modelProfileId:profile.id,toolIds:subsession?(verify?["subsession.start","shell.exec"]:["subsession.start"]):["shell.exec"],contextPolicy:{automaticCompaction:false}});
    const session=kernel.createSession({title:"Native fixture",workingDirectory:directory,agentId:agent.id});
    const started=await kernel.startRun(session.id,"Run fixture pwd once, then answer from its output.");
    if(mode==="restart"||mode==="batch-restart"||mixed&&mode.endsWith("restart")) {
      await until(()=>kernel.getRun(started.run.id).status==="waiting_permission","pending before restart");
      if(mode==="batch-restart"||mode.includes("late-restart")) {
        const first=kernel.listPermissionRequests("pending")[0];
        await kernel.approvePermissionRequest(first.id);
        await until(()=>kernel.listPermissionRequests("pending").some((p)=>p.id!==first.id),"second batch approval pending before restart");
      }
      await kernel.shutdown(1000); (store as unknown as {db:{close():void}}).db.close();
      store=new SQLiteStore({dbPath,defaultWorkingDirectory:directory});
      kernel=new Kernel({store,providers,tools,eventBus:new RunEventBus(),toolExecutionCwd:directory});
      kernel.reconcileStartupState();
    }
    const deadline=Date.now()+5000;
    let restartedVerify=false;
    while(!["completed","failed"].includes(kernel.getRun(started.run.id).status)&&Date.now()<deadline) {
      const request=kernel.listPermissionRequests("pending").find((p)=>subsession||p.runId===started.run.id);
      if(request) {
        if(mode==="subsession-verify-restart"&&!restartedVerify&&request.inputSummary.includes("verify")) {
          await kernel.shutdown(1000); (store as unknown as {db:{close():void}}).db.close();
          store=new SQLiteStore({dbPath,defaultWorkingDirectory:directory});
          kernel=new Kernel({store,providers,tools,eventBus:new RunEventBus(),toolExecutionCwd:directory});
          kernel.reconcileStartupState(); restartedVerify=true;
        }
        if(mode==="deny") kernel.denyPermissionRequest(request.id);
        else await kernel.approvePermissionRequest(request.id);
      }
      await new Promise((resolve)=>setTimeout(resolve,5));
    }
    assert.deepEqual(failures,[]);
    if(mode==="missing-id") {
      assert.equal(kernel.getRun(started.run.id).status,"failed");
      assert.match(kernel.getRun(started.run.id).error!,/missing its native/);
      assert.equal(executions,0); assert.equal(bodies.length,1);
      return;
    }
    if(mode==="duplicate") {
      assert.equal(kernel.getRun(started.run.id).status,"failed");
      assert.match(kernel.getRun(started.run.id).error!,/repeated a native tool call ID/);
      assert.equal(executions,1,"duplicate native call executed a side effect twice");
      return;
    }
    assert.equal(kernel.getRun(started.run.id).status,"completed");
    if(subsession) {
      assert.ok(childRequested&&childFinal&&parentFinal);
      assert.equal(executions,verify?2:1);
      assert.equal(store.listPermissionRequests().length,mode==="subsession-verify-restart"?3:2,"repeated approval after native child output");
      if(mode==="subsession-verify-restart") assert.ok(restartedVerify);
      const child=kernel.listSubsessions(session.id)[0]; assert.equal(child.acknowledged,true);
      assert.equal(kernel.getRun(child.childRunId).status,"completed");
      assert.ok(bodies.length<=(verify?6:5),"native child continuation repeated instead of completing");
      if(verify) {
        const responseMessage=store.listMessages(session.id).find((message)=>message.parts.some((part)=>part.type==="tool_call"&&(part.metadata.nativeToolCall as any)?.id===verifyCall.id))!;
        const original=JSON.stringify(responseMessage);
        const handoffParts=responseMessage.parts.filter((part)=>part.metadata.subsessionHandoff===true);
        assert.equal(handoffParts.length,1);
        assert.ok(handoffParts[0].seq>=1);
        assert.equal(responseMessage.parts.find((part)=>part.type==="text")?.seq,0);
        const html=renderToStaticMarkup(createElement(MessageBody,{message:toPublicMessage(responseMessage)}));
        assert.ok(html.indexOf("CHILD_NATIVE_ANSWER_SENTINEL")<html.indexOf(verifyText),"display placed response text before its child input notification");
        assert.equal(JSON.stringify(responseMessage),original,"display ordering mutated stored part seq/content");
      }
      return;
    }
    assert.equal(executions,mode==="deny"||mode==="invalid"?0:denyB?2:calls.length);
    assert.equal(bodies.length,mode==="iterations"||mixed?3:2,"unexpected repeated provider request");
    const expectedPermissions=mixed?(mode.includes("late-restart")?2:1)+(denyB?1:0):["ask","deny","batch","batch-restart","restart"].includes(mode)?calls.length:0;
    assert.equal(store.listPermissionRequests({sessionId:session.id}).length,expectedPermissions,"unexpected repeated approval");
    const assistant=store.listMessages(session.id).filter((m)=>m.role==="assistant");
    if(mixed) {
      assert.ok(assistant.every((message)=>message.parts.length>0),"pending-batch resume created empty orphan messages");
      for(const message of assistant) {
        const batches=new Set(message.parts.filter((part)=>part.type==="tool_call").map((part)=>(part.metadata.nativeToolCall as any).batchId));
        assert.ok(batches.size<=1,"new provider response reused a pending batch message");
      }
    }
    const transcript=currentRunToolTranscript(assistant);
    assert.equal(transcript.filter((m)=>m.toolExchange).reduce((n,m)=>n+m.toolExchange!.results.length,0),calls.length);
    const pending=assistant.map((m)=>({...m,parts:m.parts.filter((p)=>p.type!=="tool_result")}));
    assert.equal(currentRunToolTranscript(pending).some((m)=>m.toolExchange),false,"unmatched pending calls leaked into native request");
    const planned=planContext({systemPrompt:"fixture",messages:[{role:"user",source:"current",content:"current"},...transcript],availableTools:[],budget:resolveContextBudget({windowTokens:32768,source:"adapter"},null),providerOverhead:adapter.contextPlanning});
    assert.ok(planned.plan.providerNeutralTokens>=estimateTextTokens(sentinel));
    const transportContext={systemPrompt:"fixture",messages:planned.messages,availableTools:[],runOptions:{model:"fixture-model"}};
    const transport=flavor==="codex"?buildCodexRequestPayload({context:transportContext,profile,runOptions:transportContext.runOptions,requestedRunOptions:{}} as never).input
      :buildOpenAICompatibleRequestMessages(transportContext as never);
    assert.ok(planned.plan.estimatedInputTokens>=estimateJsonTokens(transport),"native message serialization exceeded the planner content/overhead estimate");
    const storedCalls=assistant.flatMap((m)=>m.parts).filter((p)=>p.type==="tool_call");
    assert.equal(new Set(storedCalls.map((p)=>p.content.callId)).size,calls.length,"long native IDs collided after canonical normalization");
    assert.deepEqual(storedCalls.map((p)=>(p.metadata.nativeToolCall as any).argumentsText),calls.map((c)=>c.arguments));
    assert.ok(!JSON.stringify(kernel.listMessages(session.id)).includes("nativeToolCall"),"internal continuation metadata exposed publicly");
    const narrativeChanged=planContext({systemPrompt:"fixture",messages:[{role:"user",source:"current",content:"current"},...transcript.map((m)=>m.toolExchange?{...m,content:"not sent".repeat(20000)}:m)],availableTools:[],budget:resolveContextBudget({windowTokens:32768,source:"adapter"},null),providerOverhead:adapter.contextPlanning});
    assert.equal(narrativeChanged.plan.estimatedInputTokens,planned.plan.estimatedInputTokens,"readable synthetic projection was double-counted alongside native payload");
    if(mode==="allow") {
      const owner=assistant.find((message)=>message.parts.some((part)=>part.type==="tool_call"))!;
      const foreign={...owner,id:"foreign-assistant",runId:"foreign-child-run",parts:owner.parts.filter((part)=>part.type==="tool_result").map((part)=>({...part,messageId:"foreign-assistant"}))};
      const pendingOwner={...owner,parts:owner.parts.filter((part)=>part.type!=="tool_result")};
      assert.equal(currentRunToolTranscript([pendingOwner,foreign]).some((message)=>message.toolExchange),false,"tool result paired across child Run/message ownership");
      const batchMessage=transcript.find((message)=>message.toolExchange)!;
      const originalParts=JSON.stringify(assistant);
      const large={...batchMessage,toolExchange:{...batchMessage.toolExchange!,results:batchMessage.toolExchange!.results.map((result)=>({...result,output:`HEAD_${sentinel}\n${"x".repeat(20000)}\nTAIL_${sentinel}`}))}};
      const history=Array.from({length:4},(_,index)=>[
        {role:"user" as const,source:"session" as const,messageId:`history-u-${index}`,content:`history-${index}-${"h".repeat(800)}`},
        {role:"assistant" as const,source:"session" as const,messageId:`history-a-${index}`,content:"answer",metadata:{status:"completed"}}
      ]).flat();
      const bounded=planContext({systemPrompt:"fixture",messages:[...history,{role:"user",source:"current",content:"current"},large],availableTools:[],budget:resolveContextBudget({windowTokens:1400,source:"adapter"},{reservedOutputTokens:128,safetyMarginRatio:0}),providerOverhead:adapter.contextPlanning});
      assert.ok(bounded.plan.estimatedInputTokens<=bounded.plan.inputBudgetTokens);
      const boundedNative=bounded.messages.find((m)=>m.toolExchange)!.toolExchange!;
      assert.deepEqual(boundedNative.calls,batchMessage.toolExchange!.calls,"budgeting modified native IDs/arguments instead of bounding only results");
      assert.ok(boundedNative.results[0].output.length<large.toolExchange.results[0].output.length);
      assert.ok(bounded.plan.omitted.length>0);
      assert.equal(JSON.stringify(assistant),originalParts,"context projection modified persisted source parts");
    }
  } finally {
    await kernel.shutdown(1000); (store as unknown as {db:{close():void}}).db.close();
    await new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));
    rmSync(directory,{recursive:true,force:true});
  }
}

function legacyMixedTranscriptScenario(flavor:Flavor) {
  const at="2026-01-01T00:00:00.000Z";
  const part=(id:string,messageId:string,seq:number,type:MessagePart["type"],content:any,metadata:any={}):MessagePart => ({
    id,messageId,seq,type,content,metadata,text:content.text??content.outputSummary??"",createdAt:at,updatedAt:at
  });
  const call=(id:string,messageId:string,seq:number,batch:number) => part(`part-${id}`,messageId,seq,"tool_call",{callId:id,toolId:"shell.exec"},
    {nativeToolCall:{id,name:"shell_exec",argumentsText:`{ "command": "${id}" }`,batchId:`legacy-run:${batch}`}});
  const result=(id:string,messageId:string,seq:number) => part(`result-${id}`,messageId,seq,"tool_result",{callId:id,status:"completed",outputSummary:`OUTPUT_${id}`});
  const message=(id:string,parts:MessagePart[],metadata:any={}):Message => ({id,sessionId:"legacy-session",runId:"legacy-run",segmentId:"segment",role:"assistant",status:"completed",error:null,metadata,model:null,runOptions:null,usage:null,createdAt:at,updatedAt:at,parts});
  const first=message("1-first",[part("text-ab","1-first",0,"text",{text:batchABText}),call("A","1-first",1,1),result("A","1-first",2)]);
  const mixed=message("2-mixed",[
    part("text-c","2-mixed",0,"text",{text:batchCText}),call("B","2-mixed",1,1),result("B","2-mixed",2),
    part("notification-z","2-mixed",3,"tool_result",{callId:"handoff-z",outputSummary:"CHILD_INPUT_ONE"},{subsessionHandoff:true}),
    part("notification-a","2-mixed",4,"tool_result",{callId:"handoff-a",outputSummary:"CHILD_INPUT_TWO"},{subsessionHandoff:true}),
    call("C","2-mixed",5,2),result("C","2-mixed",6)
  ],{providerResponseBatchId:"legacy-run:2"});
  const original=JSON.stringify([first,mixed]);
  const messages=currentRunToolTranscript([first,mixed]);
  const context={systemPrompt:"fixture",messages,availableTools:[],runOptions:{model:"fixture"}};
  const body=flavor==="codex"?buildCodexRequestPayload({context,profile:{model:"fixture"},runOptions:{model:"fixture"}} as never)
    :{messages:buildOpenAICompatibleRequestMessages(context as never)};
  const replay=nativeBatch(body,flavor);
  assert.deepEqual(replay.calls.map((item:any)=>item.id),["A","B","C"],"legacy mixed row silently lost a later batch");
  assert.deepEqual(replay.calls.map((item:any)=>item.arguments),['{ "command": "A" }','{ "command": "B" }','{ "command": "C" }']);
  assert.deepEqual(replay.outputs.map((item:any)=>item.id),["A","B","C"]);
  const exchanges=messages.filter((m)=>m.toolExchange).map((m)=>m.toolExchange!);
  assert.equal(exchanges[0].assistantText,batchABText);
  assert.equal(exchanges[1].assistantText,batchCText);
  const items=wireItems(body,flavor);
  const firstInput=items.findIndex((item)=>item.role==="user"&&item.content.includes("CHILD_INPUT_ONE"));
  const secondInput=items.findIndex((item)=>item.role==="user"&&item.content.includes("CHILD_INPUT_TWO"));
  const response=items.findIndex((item)=>item.role==="assistant"&&item.content?.includes(batchCText));
  assert.ok(wireResultIndex(items,flavor,"B")<firstInput);
  assert.ok(firstInput<secondInput&&secondInput<response,"multiple handoffs were not replayed in causal arrival order");
  assert.ok(response<=wireCallIndex(items,flavor,"C"));
  assert.equal(JSON.stringify([first,mixed]),original,"legacy replay mutated persisted sources");

  const noText={...mixed,metadata:{},parts:mixed.parts.filter((p)=>p.type!=="text")};
  assert.deepEqual(currentRunToolTranscript([first,noText]).flatMap((m)=>m.toolExchange?.calls.map((c)=>c.id)??[]),["A","B","C"]);
  const ambiguous={...mixed,metadata:{}};
  assert.throws(()=>currentRunToolTranscript([first,ambiguous]),(error:unknown)=>error instanceof NativeTranscriptError&&error.code==="ambiguous_native_tool_batches");
  const partial={...noText,parts:noText.parts.filter((p)=>p.id!=="result-C")};
  assert.throws(()=>currentRunToolTranscript([first,partial]),(error:unknown)=>error instanceof NativeTranscriptError);
  const lateText={...first,parts:first.parts.map((p)=>p.type==="text"?{...p,createdAt:"2026-01-01T00:00:01.000Z"}:p)};
  assert.throws(()=>currentRunToolTranscript([lateText]),(error:unknown)=>error instanceof NativeTranscriptError,"post-tool text without response identity was silently moved before calls");
}

for(const flavor of ["codex","compatible"] as const) {
  for(const mode of ["allow","ask","deny","error","batch","batch-restart","iterations","restart","invalid","subsession","duplicate","missing-id",
    "mixed-allow","mixed-deny","mixed-allow-restart","mixed-deny-restart","mixed-allow-late-restart","mixed-deny-late-restart","subsession-verify","subsession-verify-restart"] as const) await scenario(flavor,mode);
  legacyMixedTranscriptScenario(flavor);
}
console.log("Native continuation passed: real adapters + localhost SSE; mixed approval batches followed by new batches; batch-owned assistant text; causal child notification before verification; SQLite restart; recoverable legacy grouping/typed ambiguity; exact pairs and no duplicates.");
