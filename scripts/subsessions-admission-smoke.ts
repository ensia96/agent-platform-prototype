import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { Kernel } from "../src/kernel/kernel";
import { RunEventBus } from "../src/kernel/event-bus";
import { agentRunSnapshotToJson } from "../src/kernel/kernel-metadata";
import { SQLiteStore } from "../src/store/sqlite";
import { SubsessionAdmissionError } from "../src/store/subsessions";
import { ToolRegistry } from "../src/tools/registry";
import type { ProviderRegistry } from "../src/providers/registry";
import type { ProviderAdapter, ProviderRunInput, ProviderRunContext } from "../src/providers/types";
import type { ProviderProfile, ProviderTestResponse } from "../src/shared/types";
import { registerApiRoutes } from "../src/server/routes";
import { defaultToolSettings } from "../src/shared/tool-settings";
import { updateRunFromEvent } from "../src/client/run-recovery";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release=resolve; });
  return {promise,release};
}
class AdmissionProvider implements ProviderAdapter {
  id="mock";
  label="Fake root-only provider";
  worker="";
  width=4;
  extra=0;
  childShell=false;
  forgedChild=false;
  hold=true;
  uncooperative=false;
  gates=new Map<string,ReturnType<typeof latch>>();
  calls=new Map<string,number>();
  inputs: ProviderRunInput[]=[];
  private next=0;
  private handledResults=0;
  async test(profile:ProviderProfile):Promise<ProviderTestResponse> {
    return {ok:true,profile,status:profile.status,message:"fake",checkedAt:new Date().toISOString()};
  }
  async run(input:ProviderRunInput, context:ProviderRunContext) {
    this.inputs.push(input);
    const runId=String(input.context.metadata.runId);
    const turn=(this.calls.get(runId)??0)+1; this.calls.set(runId,turn);
    if (!input.session.parentSessionId) {
      const results=input.context.messages.filter((m)=>m.content.includes("[child result handoff]")).length;
      const count=turn===1 ? this.width : this.extra>0 && results>this.handledResults ? 1 : 0;
      if (count) {
        if (turn>1) {this.extra--; this.handledResults=results;}
        return {toolCalls:Array.from({length:count},() => ({id:`spawn-${this.next++}`,name:"subsession_start",arguments:{agentId:this.worker,task:"Independent child"}}))};
      }
    } else {
      if (turn===1 && this.forgedChild) return {toolCalls:[{id:"forged-child-spawn",name:"subsession_start",arguments:{agentId:this.worker,task:"Forbidden grandchild"}}]};
      if (turn===1 && this.childShell) return {toolCalls:[{id:"shell-once",name:"shell_exec",arguments:{command:"fake"}}]};
      if (this.hold) {
        const gate=latch(); this.gates.set(runId,gate);
        if (this.uncooperative) await gate.promise;
        else await new Promise<void>((resolve,reject) => {
          const abort=() => reject(context.signal.reason);
          if (context.signal.aborted) {reject(context.signal.reason); return;}
          context.signal.addEventListener("abort",abort,{once:true});
          void gate.promise.then(() => {context.signal.removeEventListener("abort",abort); resolve();});
        });
      }
    }
    await context.writer.writeDelta(`RESULT_${runId}`);
    return {toolCalls:[]};
  }
}
function providers(provider:AdmissionProvider):ProviderRegistry {
  const profile:ProviderProfile={id:"mock",name:"Fake",type:"mock",enabled:true,source:"builtin",status:{state:"available",message:"fake",credentialStatus:"not_required"}};
  const resolve=() => ({adapter:provider,profile,credential:{},providerResolution:{requestedProvider:null,requestedProviderProfileId:null,providerProfileId:"mock",providerProfileName:"Fake",providerType:"mock",fallback:null}});
  return {list:() => ({providers:[profile],defaultProviderProfileId:"mock"}),resolveRun:resolve,resolveRunExact:resolve,
    resolveModelContextCapability:async () => ({windowTokens:32768,source:"adapter"})} as unknown as ProviderRegistry;
}
function db(store:SQLiteStore) { return (store as unknown as {db:Database.Database}).db; }
function create(directory:string) {
  const store=new SQLiteStore({dbPath:join(directory,"test.db"),defaultWorkingDirectory:directory});
  const provider=new AdmissionProvider(), registry=providers(provider), tools=new ToolRegistry();
  const toolContexts:{runId:string;cwd:string}[]=[];
  tools.register({definition:{id:"shell.exec",name:"Fake shell",description:"No process",source:"builtin",inputSchema:{},outputSchema:{},metadata:{}},executor:{execute:async (_input,context) => {
    toolContexts.push({runId:context.invocation.runId,cwd:context.cwd}); return {exitCode:0,stdout:"fake"};
  }}});
  const kernel=new Kernel({store,providers:registry,tools,eventBus:new RunEventBus(),toolExecutionCwd:directory});
  const worker=kernel.createAgentDefinition({name:"Worker",systemPrompt:"Fake worker",modelProfileId:"mock",toolIds:["shell.exec","subsession.start"],contextPolicy:{automaticCompaction:false}});
  provider.worker=worker.id;
  const session=kernel.createSession({title:"Root",agentId:worker.id,workingDirectory:directory});
  return {store,provider,registry,tools,kernel,worker,session,directory,toolContexts};
}
type Fixture=ReturnType<typeof create>;
async function fixture(test:(f:Fixture)=>Promise<void>) {
  const directory=mkdtempSync(join(tmpdir(),"subsessions-admission-")), f=create(directory);
  try {await test(f);} finally {
    f.provider.hold=false; for (const gate of f.provider.gates.values()) gate.release();
    await f.kernel.shutdown(1000); db(f.store).close(); rmSync(directory,{recursive:true,force:true});
  }
}
async function until(check:()=>boolean, label="condition") {
  const deadline=Date.now()+6000;
  while(Date.now()<deadline) {if(check())return; await new Promise((resolve)=>setTimeout(resolve,3));}
  assert.fail(`admission timeout: ${label}`);
}
async function approveDelegations(f:Fixture, done:()=>boolean) {
  const deadline=Date.now()+6000;
  while(!done()&&Date.now()<deadline) {
    for(const request of f.kernel.listPermissionRequests("pending")) if(request.toolId==="subsession.start") await f.kernel.approvePermissionRequest(request.id);
    await new Promise((resolve)=>setTimeout(resolve,3));
  }
  assert.ok(done(),"delegation approvals did not reach desired state");
}
function counts(f:Fixture) {
  return {sessions:f.store.listSessions().length,runs:f.store.listRuns().length,delegations:f.store.subsessions.list().length};
}
function admission(f:Fixture,parentRunId:string,invocationId:string) {
  return {parentRunId,invocationId,agentId:f.worker.id,agentRevision:f.worker.revision,cwd:f.directory,title:"child",task:"Independent child",agentSnapshot:agentRunSnapshotToJson(f.worker,new Date().toISOString())};
}

async function capacityAndReuseScenario(permissionWait:boolean) {
  await fixture(async (f)=>{
    f.provider.width=5; f.provider.childShell=permissionWait;
    if(permissionWait) f.store.setSetting("toolSettings",{...defaultToolSettings,defaultAction:"ask"} as never,new Date().toISOString());
    const root=await f.kernel.startRun(f.session.id,"capacity test");
    await approveDelegations(f,()=>f.kernel.getRun(root.run.id).status==="waiting_children");
    const children=f.store.subsessions.list(root.run.id);
    assert.equal(children.length,4);
    assert.deepEqual(counts(f),{sessions:5,runs:5,delegations:4},"fifth rejection allocated child rows");
    assert.equal(db(f.store).prepare("SELECT 1 FROM sqlite_master WHERE name='subsession_work'").get(),undefined,"fresh schema created an execution queue");
    const capacity=f.store.subsessions.capacity(root.run.id);
    assert.equal(capacity.active,4); assert.equal(capacity.available,0);
    const failure=f.store.listMessages(f.session.id).flatMap((m)=>m.parts).find((p)=>p.type==="tool_result"&&p.text.includes("subsession_capacity_exhausted"))!;
    const payload=JSON.parse(failure.text);
    assert.equal(payload.limit,4); assert.equal(payload.active,4); assert.equal(payload.available,0); assert.equal(payload.activeChildren.length,4);
    assert.ok(f.provider.inputs.filter((input)=>input.session.id===f.session.id).some((input)=>input.context.messages.some((m)=>m.content.includes("subsession_capacity_exhausted"))),"capacity error absent from actual model context");
    if(permissionWait) {
      await until(()=>children.every((child)=>f.store.getRun(child.childRunId)?.status==="waiting_permission"));
      assert.equal(f.store.subsessions.capacity(root.run.id).active,4,"approval wait freed an admission slot");
      assert.equal(f.toolContexts.length,0);
      f.provider.hold=false;
      const childPermission=f.kernel.listPermissionRequests("pending").find((p)=>p.runId===children[0].childRunId)!;
      assert.equal((await f.kernel.approvePermissionRequest(childPermission.id)).state,"executed");
      await until(()=>f.store.getRun(children[0].childRunId)?.status==="completed");
      assert.equal(f.store.subsessions.capacity(root.run.id).available,1);
      f.kernel.cancelRun(root.run.id);
      return;
    }
    await until(()=>f.provider.gates.size===4);
    f.provider.extra=2;
    f.provider.gates.get(children[0].childRunId)!.release();
    await approveDelegations(f,()=>f.store.subsessions.list(root.run.id).length===5);
    await until(()=>f.provider.gates.size===5);
    assert.equal(f.store.subsessions.capacity(root.run.id).active,4);
    f.provider.gates.get(children[1].childRunId)!.release();
    await approveDelegations(f,()=>f.store.subsessions.list(root.run.id).length===6);
    await until(()=>f.provider.gates.size===6);
    assert.equal(f.store.subsessions.capacity(root.run.id).active,4);
    f.provider.hold=false; for(const gate of f.provider.gates.values())gate.release();
    await until(()=>f.kernel.getRun(root.run.id).status==="completed");
    assert.equal(f.store.subsessions.capacity(root.run.id).available,4);
    assert.ok(f.store.subsessions.list(root.run.id).every((item)=>item.acknowledged));
    f.provider.width=1;
    const later=await f.kernel.startRun(f.session.id,"later root run in the same Session");
    await approveDelegations(f,()=>f.kernel.getRun(later.run.id).status==="completed");
    assert.equal(f.store.subsessions.list(later.run.id).length,1,"Session lifetime child count blocked a later Run");
  });
}

async function rootOnlyScenario() {
  await fixture(async (f)=>{
    f.provider.width=1; f.provider.forgedChild=true; f.provider.hold=false; f.provider.worker="main";
    const root=await f.kernel.startRun(f.session.id,"child with main profile must not delegate");
    await approveDelegations(f,()=>f.kernel.getRun(root.run.id).status==="completed");
    const child=f.store.subsessions.list(root.run.id)[0];
    assert.equal(child.agentId,"main");
    assert.ok(f.kernel.getAgentDefinition("main").toolIds.includes("subsession.start"));
    const approvedTarget=f.store.listPermissionRequests({sessionId:f.session.id}).find((request)=>request.toolId==="subsession.start")!;
    assert.equal((approvedTarget.publicInput.targetTools as string[]).includes("subsession.start"),false,"approval advertised a child-only forbidden capability");
    const inputs=f.provider.inputs.filter((input)=>input.session.id===child.childSessionId);
    assert.ok(inputs.length>=2);
    assert.ok(inputs.every((input)=>!input.context.availableTools.some((tool)=>tool.id==="subsession.start")),"child schema exposed delegation");
    const preview=await f.kernel.previewContext(child.childSessionId,{text:"preview child"});
    assert.equal(preview.context.availableTools.some((tool)=>tool.id==="subsession.start"),false);
    assert.ok(inputs.some((input)=>input.context.messages.some((m)=>m.content.includes("subsession_root_only"))),"forged native child call was not rejected in model context");
    assert.equal(f.store.subsessions.list(child.childRunId).length,0);
    assert.equal(f.store.listPermissionRequests({sessionId:child.childSessionId}).length,0,"forged call reached approval");
    const before=counts(f);
    assert.throws(()=>f.store.subsessions.admit(admission(f,child.childRunId,"forged-store")),(error:unknown)=>error instanceof SubsessionAdmissionError&&error.code==="subsession_root_only");
    assert.deepEqual(counts(f),before);
  });
}

async function cancellationReservationScenario(uncooperative:boolean) {
  await fixture(async (f)=>{
    f.provider.uncooperative=uncooperative;
    const root=await f.kernel.startRun(f.session.id,"cancel does not free before terminal");
    await approveDelegations(f,()=>f.provider.gates.size===4&&f.kernel.getRun(root.run.id).status==="waiting_children");
    const child=f.store.subsessions.list(root.run.id)[0];
    const siblings=f.store.subsessions.list(root.run.id).slice(1);
    f.kernel.cancelRun(child.childRunId);
    if(uncooperative) {
      await new Promise((resolve)=>setTimeout(resolve,30));
      assert.equal(f.store.getRun(child.childRunId)?.status,"cancelling");
      assert.equal(f.store.subsessions.capacity(root.run.id).available,0);
      const before=counts(f);
      // Exercise admission under a running owner, without invoking another provider.
      f.store.transitionRunStatus(root.run.id,["waiting_children"],"running",null,new Date().toISOString());
      assert.throws(()=>f.store.subsessions.admit(admission(f,root.run.id,"cancel-race")),(error:unknown)=>error instanceof SubsessionAdmissionError&&error.code==="subsession_capacity_exhausted");
      f.store.transitionRunStatus(root.run.id,["running"],"waiting_children",null,new Date().toISOString());
      assert.deepEqual(counts(f),before);
      f.provider.gates.get(child.childRunId)!.release();
    }
    await until(()=>f.store.getRun(child.childRunId)?.status==="cancelled");
    assert.equal(f.store.subsessions.capacity(root.run.id).available,1);
    assert.ok(siblings.every((item)=>f.store.getRun(item.childRunId)?.status==="running"));
    f.provider.hold=false; for(const gate of f.provider.gates.values())gate.release();
    await until(()=>f.kernel.getRun(root.run.id).status==="completed");
    assert.match(f.store.subsessions.list(root.run.id)[0].result!,/cancelled|RESULT_/);
  });
}

async function pendingAdmissionCwdScenario(legacyMissing=false) {
  await fixture(async (f)=>{
    f.provider.childShell=true; f.provider.hold=false;
    const now=new Date().toISOString();
    const parent=f.store.createRun({id:"pending-parent",sessionId:f.session.id,provider:"mock",status:"running",createdAt:now,updatedAt:now});
    const child=f.store.subsessions.admit(admission(f,parent.id,"pending-cwd"));
    assert.equal(f.store.subsessions.capacity(parent.id).active,1,"admission in progress did not reserve capacity");
    if(legacyMissing) db(f.store).prepare("UPDATE runs SET metadata_json=json_remove(metadata_json,'$.workingDirectory') WHERE id=?").run(child.childRunId);
    const edited=mkdtempSync(join(f.directory,"edited-cwd-"));
    const app=express(); app.use(express.json());
    registerApiRoutes(app,{kernel:f.kernel,providers:f.registry,store:f.store,dbPath:join(f.directory,"test.db"),openAIChatGPTAuth:{} as never,getToolSettings:()=>defaultToolSettings,
      getDaemonStatus:()=>({status:"ok",version:"fake",pid:process.pid,startedAt:now,uptimeSeconds:0,mode:"test",port:0,dbPath:"fixture"})});
    const server=app.listen(0,"127.0.0.1"); await new Promise<void>((resolve)=>server.once("listening",resolve));
    const address=server.address(); assert.ok(address&&typeof address==="object");
    try {
      const response=await fetch(`http://127.0.0.1:${address.port}/api/sessions/${child.childSessionId}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({workingDirectory:edited})});
      assert.equal(response.status,200);
    } finally {await new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}
    // Simulate the boundary between atomic admission and its immediate asynchronous launch (not an execution queue).
    await (f.kernel as unknown as {executeAdmittedSubsession(runId:string):Promise<void>}).executeAdmittedSubsession(child.childRunId);
    await until(()=>f.kernel.getRun(child.childRunId).status==="completed");
    const expected=legacyMissing?edited:f.directory;
    const inputs=f.provider.inputs.filter((input)=>input.session.id===child.childSessionId);
    assert.equal(inputs.length,2);
    for(const input of inputs) {
      assert.equal(input.session.workingDirectory,expected); assert.equal(input.context.workingDirectory,expected);
      assert.ok(input.context.systemPrompt.includes(`Session working directory: ${expected}`));
    }
    assert.equal(f.kernel.getRun(child.childRunId).metadata.workingDirectory,expected);
    assert.deepEqual(f.toolContexts,[{runId:child.childRunId,cwd:expected}]);
    assert.equal(f.kernel.getSession(child.childSessionId).workingDirectory,edited);
    assert.equal(f.store.subsessions.admit(admission(f,parent.id,"pending-cwd")).id,child.id,"duplicate invocation admitted twice");
  });
}

async function legacyUpgradeScenario() {
  await fixture(async (f)=>{
    await f.kernel.shutdown(100);
    const now=new Date().toISOString();
    const root=f.store.createRun({id:"legacy-root-run",sessionId:f.session.id,provider:"mock",status:"running",createdAt:now,updatedAt:now});
    const child=f.store.subsessions.admit(admission(f,root.id,"legacy-admit"));
    const approvedMessage=f.store.createMessage({id:"legacy-approved-message",sessionId:child.childSessionId,runId:child.childRunId,role:"assistant",status:"streaming",createdAt:now,updatedAt:now});
    const approvedCall=f.store.addMessagePart({id:"legacy-approved-call",messageId:approvedMessage.id,seq:1,type:"tool_call",text:"old approved operation",content:{callId:"legacy-invocation",toolId:"shell.exec",status:"pending_permission"},createdAt:now,updatedAt:now});
    const permission=f.store.createPermissionRequest({id:"old-approval",sessionId:child.childSessionId,runId:child.childRunId,messageId:approvedMessage.id,invocationId:"legacy-invocation",toolId:"shell.exec",toolName:"Fake shell",caller:"model",permissionDecision:"requires_approval",inputSummary:"old approved operation",publicInput:{command:"fake"},executionInput:{command:"fake"},riskLevel:"medium",reason:"fixture",status:"pending",toolCallPartId:approvedCall.id,createdAt:now,updatedAt:now});
    assert.ok(f.store.resolvePermissionRequest(permission.id,"approved",now));
    const nestedSession=f.store.createSession({id:"legacy-nested-session",title:"Legacy nested",workingDirectory:f.directory,agentId:f.worker.id,createdAt:now,updatedAt:now});
    const nestedRun=f.store.createRun({id:"legacy-nested-run",sessionId:nestedSession.id,provider:"mock",status:"running",createdAt:now,updatedAt:now});
    const nestedMessage=f.store.createMessage({id:"legacy-nested-message",sessionId:nestedSession.id,runId:nestedRun.id,role:"assistant",status:"streaming",createdAt:now,updatedAt:now});
    f.store.addMessagePart({id:"legacy-original-part",messageId:nestedMessage.id,seq:0,text:"LEGACY_RAW_PROGRESS",createdAt:now,updatedAt:now});
    const v1Session=f.store.createSession({id:"legacy-v1-session",title:"Legacy admission without Run",workingDirectory:f.directory,agentId:f.worker.id,createdAt:now,updatedAt:now});
    const sql=db(f.store);
    sql.prepare("UPDATE sessions SET parent_session_id=? WHERE id=?").run(f.session.id,v1Session.id);
    sql.prepare(`INSERT INTO subsession_delegations(id,parent_session_id,parent_run_id,invocation_id,child_session_id,child_run_id,agent_id,agent_revision,status,created_at)
      VALUES ('legacy-v1',?,?,'v1-start',?,'v1-missing-run',?,?,'starting',?)`).run(f.session.id,root.id,v1Session.id,f.worker.id,f.worker.revision,now);
    const oldEvent=f.store.appendEvent({id:"legacy-queued-event",runId:child.childRunId,sessionId:child.childSessionId,type:"run_queued" as never,createdAt:now,payload:{status:"queued"}});
    sql.prepare("UPDATE sessions SET parent_session_id=? WHERE id=?").run(child.childSessionId,nestedSession.id);
    sql.prepare("UPDATE runs SET status='queued' WHERE id=?").run(child.childRunId);
    sql.prepare("UPDATE subsession_delegations SET status='queued' WHERE id=?").run(child.id);
    sql.prepare(`INSERT INTO subsession_delegations(id,parent_session_id,parent_run_id,invocation_id,child_session_id,child_run_id,agent_id,agent_revision,status,created_at,root_run_id,task)
      VALUES ('legacy-nested',?,?,'legacy-nested-call',?,?,?,?,'running',?,?,?)`).run(child.childSessionId,child.childRunId,nestedSession.id,nestedRun.id,f.worker.id,f.worker.revision,now,root.id,"legacy task");
    sql.exec("CREATE TABLE subsession_work(seq INTEGER PRIMARY KEY,run_id TEXT,kind TEXT,permission_id TEXT)");
    sql.prepare("INSERT INTO subsession_work VALUES (1,?,'permission','old-approval')").run(child.childRunId);
    sql.prepare("DELETE FROM schema_migrations WHERE name IN ('subsessions-root-only-v3','subsessions-root-only-schema-v3')").run();
    sql.close();
    f.store=new SQLiteStore({dbPath:join(f.directory,"test.db"),defaultWorkingDirectory:f.directory});
    f.kernel=new Kernel({store:f.store,providers:f.registry,tools:f.tools,eventBus:new RunEventBus(),toolExecutionCwd:f.directory});
    f.kernel.reconcileStartupState();
    for(const id of [child.childRunId,nestedRun.id]) assert.equal(f.store.getRun(id)?.status,"interrupted");
    assert.equal(f.store.listSessions().length,4);
    assert.equal(f.store.subsessions.list().length,3);
    assert.equal(f.store.subsessions.list().find((item)=>item.id==="legacy-v1")?.status,"interrupted");
    assert.equal(f.store.getRun("v1-missing-run"),null,"upgrade executed a v1 admission instead of preserving interrupted audit");
    assert.equal(f.store.getMessage(nestedMessage.id)?.parts[0].text,"LEGACY_RAW_PROGRESS");
    assert.equal(f.store.getPermissionRequest(permission.id)?.status,"approved","upgrade erased approval audit");
    assert.equal(f.store.getMessage(approvedMessage.id)?.parts[0].content.status,"cancelled");
    assert.deepEqual(f.store.listEvents(child.childRunId)[0],oldEvent,"upgrade rewrote immutable queued event");
    const interrupted=f.kernel.getPublicRun(child.childRunId);
    assert.equal(updateRunFromEvent(interrupted,oldEvent),interrupted,"legacy queued event revived an interrupted run in UI");
    assert.equal(f.store.listEvents(child.childRunId).filter((event)=>event.type==="run_interrupted").length,1);
    assert.equal((db(f.store).prepare("SELECT COUNT(*) AS count FROM subsession_work").get() as {count:number}).count,1,"upgrade erased legacy ownership/work audit");
    assert.equal(f.provider.inputs.length,0,"upgrade executed legacy queued or nested work");
    assert.equal(f.toolContexts.length,0,"upgrade replayed an approved queued side-effect tool");
    assert.ok(f.store.subsessions.list().every((item)=>item.result!==null));
    db(f.store).close();
    f.store=new SQLiteStore({dbPath:join(f.directory,"test.db"),defaultWorkingDirectory:f.directory});
    f.kernel=new Kernel({store:f.store,providers:f.registry,tools:f.tools,eventBus:new RunEventBus(),toolExecutionCwd:f.directory});
    assert.equal(f.store.listEvents(child.childRunId).filter((event)=>event.type==="run_interrupted").length,1,"upgrade was not idempotent");
  });
}

function defaultMigrationScenario() {
  for(const tools of [["shell.exec"],[],["subsession.start"],["shell.exec","subsession.start"]]) {
    const directory=mkdtempSync(join(tmpdir(),"root-default-migration-")),path=join(directory,"test.db");
    try {
      let store=new SQLiteStore({dbPath:path,defaultWorkingDirectory:directory});
      assert.deepEqual(store.getAgentDefinition("main")!.toolIds,["shell.exec","subsession.start"]);
      store.createAgentDefinition({...store.getAgentDefinition("main")!,id:"other",name:"Other",toolIds:["shell.exec"]});
      db(store).prepare("UPDATE agent_definitions SET tool_ids_json=?,revision=7 WHERE id='main'").run(JSON.stringify(tools));
      db(store).prepare("DELETE FROM schema_migrations WHERE name='main_subsession_default_v1'").run(); db(store).close();
      store=new SQLiteStore({dbPath:path,defaultWorkingDirectory:directory});
      assert.deepEqual(store.getAgentDefinition("main")!.toolIds,tools.length===1&&tools[0]==="shell.exec"?["shell.exec","subsession.start"]:tools);
      assert.deepEqual(store.getAgentDefinition("other")!.toolIds,["shell.exec"]);
      db(store).prepare("UPDATE agent_definitions SET tool_ids_json='[]',revision=revision+1 WHERE id='main'").run(); db(store).close();
      store=new SQLiteStore({dbPath:path,defaultWorkingDirectory:directory});
      assert.deepEqual(store.getAgentDefinition("main")!.toolIds,[]); db(store).close();
    } finally {rmSync(directory,{recursive:true,force:true});}
  }
}

export async function admissionScenarios() {
  defaultMigrationScenario();
  await capacityAndReuseScenario(false);
  await capacityAndReuseScenario(true);
  await rootOnlyScenario();
  await cancellationReservationScenario(false);
  await cancellationReservationScenario(true);
  await pendingAdmissionCwdScenario();
  await pendingAdmissionCwdScenario(true);
  await legacyUpgradeScenario();
  console.log("Root-only admission passed: four unfinished reservations, no queued rows, terminal reuse (5th/6th), forged child deny/schema omission, approval/cancel accounting, cwd snapshots, non-replaying legacy upgrade.");
}
