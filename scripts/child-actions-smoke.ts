import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChildActionsController, scopeChildPermissions } from "../src/client/child-actions";
import { SubsessionLinks } from "../src/client/SubsessionPanel";
import { ApiRequestError, type requestJson } from "../src/client/api";
import type { PermissionRequest, SubsessionDelegation } from "../src/shared/types";

const child:SubsessionDelegation={id:"delegation",rootRunId:"parent-run",parentSessionId:"parent-session",parentRunId:"parent-run",invocationId:"spawn",childSessionId:"child-session",childRunId:"child-run",agentId:"main",agentName:"Worker",taskPreview:"bounded task",agentRevision:1,status:"waiting_permission",result:null,deliveredPartId:null,acknowledged:false,createdAt:"2026-01-01T00:00:00.000Z"};
const permission:PermissionRequest={id:"permission",sessionId:child.childSessionId,runId:child.childRunId,invocationId:"call",toolName:"Shell",toolId:"shell.exec",inputSummary:"$ pwd",input:{command:"pwd"},riskLevel:"medium",reason:"Explicit child approval",status:"pending",createdAt:child.createdAt,resolvedAt:null};
const other={...child,id:"other",parentRunId:"unrelated-run",childRunId:"other-run",childSessionId:"other-session"};
const otherPermission={...permission,id:"other-permission",runId:other.childRunId,sessionId:other.childSessionId};
const wrongSessionPermission={...permission,id:"wrong-session",sessionId:"not-child-session"};
function deferred<T>() { let resolve!:(value:T)=>void; let reject!:(error:Error)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }

export async function childActionScenarios() {
  assert.deepEqual(scopeChildPermissions("parent-session","parent-run",[child,other],[permission,otherPermission,wrongSessionPermission]).permissions,[permission]);
  assert.equal(scopeChildPermissions("parent-session","new-parent-run",[child,other],[permission]).children.length,0);
  const latest={...other,createdAt:"2026-01-02T00:00:00.000Z"};
  assert.deepEqual(scopeChildPermissions("parent-session",null,[child,latest],[permission,otherPermission]).permissions,[otherPermission]);
  const parentState={activeRun:{id:"parent-run"},eventSource:{runId:"parent-run"},messages:[{id:"parent-message"}],provider:"parent-provider",model:"parent-model",context:"parent-context"};
  const before=JSON.stringify(parentState);
  for(const action of ["approve","deny","cancel"] as const) {
    const urls:string[]=[];
    let pending=true;
    const post=deferred<unknown>();
    let stale=false;
    const oldPoll=deferred<unknown>();
    const request=(async (url:string,init?:RequestInit)=>{
      urls.push(url);
      if(init?.method==="POST") return post.promise;
      if(url.includes("/subsessions")) return [child,other];
      if(stale) {stale=false;return oldPoll.promise;}
      return {permissions:pending?[permission,otherPermission,wrongSessionPermission]:[otherPermission]};
    }) as typeof requestJson;
    let current=true;
    const controller=new ChildActionsController("parent-session","parent-run",()=>current,()=>undefined,request);
    await controller.refresh();
    stale=true;
    const polling=controller.refresh();
    const acting=action==="cancel"?controller.cancel(child.childRunId):controller.permission(permission.id,action);
    assert.equal(controller.view.busy[action==="cancel"?`cancel:${child.childRunId}`:`permission:${permission.id}`],true);
    pending=false;
    post.resolve(action==="cancel"?{id:child.childRunId,sessionId:child.childSessionId,status:"cancelling"}:{permissionRequest:{id:permission.id},run:{id:child.childRunId,sessionId:child.childSessionId,status:"running"}});
    await acting;
    oldPoll.resolve({permissions:[permission]}); await polling;
    assert.equal(controller.view.permissions.length,0,"stale GET resurrected an already handled permission");
    assert.equal(JSON.stringify(parentState),before,"child action mutated parent tracking/messages/options");
    assert.ok(urls.some((url)=>url=== (action==="cancel"?`/api/runs/${child.childRunId}/cancel`:`/api/permissions/${permission.id}/${action}`)));
    const prior=urls.length;
    await controller.permission(otherPermission.id,"approve"); await controller.cancel(other.childRunId);
    assert.equal(urls.length,prior,"unrelated child action reached the API");
    current=false; controller.dispose();
  }

  for(const staleKind of ["resolve","reject","conflict"] as const) {
    let current=true, publications=0, gets=0;
    const post=deferred<unknown>();
    const request=(async (_url:string,init?:RequestInit)=>{
      if(init?.method==="POST") return post.promise;
      gets++; return _url.includes("/subsessions")?[child]:{permissions:[permission]};
    }) as typeof requestJson;
    const controller=new ChildActionsController("parent-session","parent-run",()=>current,()=>{publications++;},request);
    await controller.refresh();
    const action=controller.permission(permission.id,"approve");
    if(staleKind!=="conflict") current=false;
    const count=publications;
    if(staleKind==="resolve") post.resolve({permissionRequest:{id:permission.id},run:{id:child.childRunId,sessionId:child.childSessionId}});
    else post.reject(staleKind==="conflict"?new ApiRequestError("already resolved",409,null,null):new Error("late previous-session error"));
    await action;
    if(staleKind==="conflict") {
      assert.ok(gets>=4,"409 did not requery canonical state");
      assert.equal(controller.view.permissions.length,0,"409 stale permission reappeared");
      assert.equal(Object.keys(controller.view.errors).length,0);
    } else assert.equal(publications,count,"late action response changed current-session state");
    controller.dispose();
  }
  const mismatchedRequest=(async (url:string,init?:RequestInit)=> {
    if(init?.method==="POST") return {permissionRequest:{id:permission.id},run:{id:"wrong-child-run",sessionId:child.childSessionId}};
    return url.includes("/subsessions")?[child]:{permissions:[permission]};
  }) as typeof requestJson;
  const mismatch=new ChildActionsController("parent-session","parent-run",()=>true,()=>undefined,mismatchedRequest);
  await mismatch.refresh(); await mismatch.permission(permission.id,"approve");
  assert.match(mismatch.view.errors[`permission:${permission.id}`],/ownership mismatch/);
  assert.equal(mismatch.view.permissions[0]?.id,permission.id,"mismatched response falsely consumed the permission");
  mismatch.dispose();
  const html=renderToStaticMarkup(createElement(SubsessionLinks,{parentSessionId:null,children:[child],permissions:[permission],onOpen:()=>undefined,onApprove:()=>undefined,onDeny:()=>undefined,onCancel:()=>undefined}));
  assert.match(html,/자식 승인 대기 1개/); assert.match(html,/자식 실행 승인/); assert.match(html,/자식 실행 거부/); assert.match(html,/이 자식만 취소/);
  assert.match(html,/Explicit child approval/); assert.match(html,/\$ pwd/); assert.match(html,/aria-expanded="true"/);
  const collapsed=renderToStaticMarkup(createElement(SubsessionLinks,{parentSessionId:null,children:[child],onOpen:()=>undefined}));
  assert.match(collapsed,/자식 승인 대기 0개/);
  const source=readFileSync(new URL("../src/client/App.tsx",import.meta.url),"utf8");
  assert.ok(source.indexOf("<SubsessionPanel")<source.indexOf('<div className="messages"'),"child controls are inside the scrolling transcript instead of adjacent to header");
  console.log("Child action guards passed: exact delegation ownership; isolated parent state; approve/deny/cancel; stale polls/session responses/409; persistent pending SSR and App placement.");
}
