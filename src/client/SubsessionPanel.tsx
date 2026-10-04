import { useEffect, useRef, useState } from "react";
import type { PermissionRequest, Session, SubsessionDelegation } from "../shared/types";
import { isTerminalRunStatus } from "../shared/types";
import { ChildActionsController, type ChildActionView } from "./child-actions";

export function SubsessionPanel({ session, onOpen, parentRunId = null, generation = 0, isCurrent = () => true }: {
  session: Session; onOpen: (id: string) => void; parentRunId?: string | null; generation?: number; isCurrent?: () => boolean;
}) {
  const [view, setView] = useState<ChildActionView>({ownerRunId:null,children:[],permissions:[],busy:{},errors:{},reconnecting:false});
  const controller = useRef<ChildActionsController | null>(null);
  const current = useRef(isCurrent); current.current = isCurrent;
  useEffect(() => {
    const next = new ChildActionsController(session.id,parentRunId,current.current,setView);
    controller.current = next; setView(next.view);
    void next.refresh();
    const timer = setInterval(() => void next.refresh(),1500);
    return () => { next.dispose(); clearInterval(timer); };
  }, [session.id,parentRunId,generation]);
  return <SubsessionLinks parentSessionId={session.parentSessionId ?? null} children={view.children} onOpen={onOpen}
    error={view.reconnecting} permissions={view.permissions} busy={view.busy} errors={view.errors}
    onApprove={(id) => void controller.current?.permission(id,"approve")}
    onDeny={(id) => void controller.current?.permission(id,"deny")}
    onCancel={(id) => void controller.current?.cancel(id)} />;
}

export function SubsessionLinks({ parentSessionId, children, onOpen, error = false, permissions = [], busy = {}, errors = {}, onApprove, onDeny, onCancel, initiallyExpanded = false }: {
  parentSessionId: string | null; children: SubsessionDelegation[]; onOpen: (id: string) => void; error?: boolean;
  permissions?: PermissionRequest[]; busy?: Record<string,boolean>; errors?: Record<string,string>;
  onApprove?: (id:string) => void; onDeny?: (id:string) => void; onCancel?: (id:string) => void;
  initiallyExpanded?: boolean;
}) {
  const [expanded,setExpanded] = useState(initiallyExpanded || permissions.length > 0);
  const previous = useRef(new Set<string>());
  const permissionKey = permissions.map((p) => p.id).join(",");
  useEffect(() => {
    const ids = permissionKey ? permissionKey.split(",") : [];
    if (ids.some((id) => !previous.current.has(id))) setExpanded(true);
    previous.current = new Set(ids);
  },[permissionKey]);
  return <section className="childStatusPanel" aria-label="Sub-sessions">
    {parentSessionId && <button type="button" onClick={() => onOpen(parentSessionId)}>부모 대화 열기</button>}
    <button className="childStatusToggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      자식 작업 {children.length}개 · <strong role="status">자식 승인 대기 {permissions.length}개</strong>
    </button>
    {error && <span role="status">자식 상태를 다시 연결하는 중입니다.</span>}
    {expanded && <div className="childStatusBody">
      <p className="muted">Root Session만 위임할 수 있습니다. 소유 Run별 미완료 자식 최대 4개이며 승인 대기·결과 대기·취소 정리도 포함합니다. 실행 대기열은 없고, 자식이 종료되면 다시 시작할 수 있습니다. Child 재위임은 금지됩니다. 작업 디렉터리는 파일 격리가 아닙니다.</p>
      {[...new Set(children.map((child) => child.parentRunId))].map((runId) => {
        const active = children.filter((child) => child.parentRunId === runId && ["starting","running","waiting_permission","waiting_children","cancelling"].includes(child.status)).length;
        return <p key={runId} className="muted">Run {runId.slice(0,8)} · 미완료 {active}/4 · 가용 {Math.max(0,4-active)}</p>;
      })}
      {children.map((child) => <article className="childStatusCard" key={child.id}>
        <button type="button" onClick={() => onOpen(child.childSessionId)}>자식 대화 열기 · {child.agentName ?? child.agentId}</button>
        <small> Run {child.childRunId.slice(0,8)}</small>
        <span> {child.status === "waiting_permission" ? "waiting approval" : child.status === "waiting_children" ? "waiting children" : child.status} · {child.acknowledged ? "결과 전달됨" : child.result === null ? "접수/진행 중" : "결과 대기"}</span>
        {child.taskPreview && <p>{child.taskPreview}</p>}
        {permissions.filter((p) => p.runId === child.childRunId && p.sessionId === child.childSessionId).map((p) => <div key={p.id} className="childPermission">
          <strong>{p.toolName} · {p.riskLevel}</strong>
          <pre>{p.inputSummary}</pre><p>{p.reason}</p>
          <button type="button" disabled={busy[`permission:${p.id}`]} aria-label={`${child.agentName ?? child.agentId} ${child.childRunId.slice(0,8)} ${p.toolName} 승인`} onClick={() => onApprove?.(p.id)}>자식 실행 승인</button>
          <button type="button" disabled={busy[`permission:${p.id}`]} aria-label={`${child.agentName ?? child.agentId} ${child.childRunId.slice(0,8)} ${p.toolName} 거부`} onClick={() => onDeny?.(p.id)}>자식 실행 거부</button>
          {errors[`permission:${p.id}`] && <p role="alert">{errors[`permission:${p.id}`]}</p>}
        </div>)}
        {(child.status === "starting" || !isTerminalRunStatus(child.status)) && <button type="button" disabled={busy[`cancel:${child.childRunId}`] || child.status === "cancelling"}
          aria-label={`${child.agentName ?? child.agentId} ${child.childRunId.slice(0,8)} 자식 작업 취소`} onClick={() => onCancel?.(child.childRunId)}>이 자식만 취소</button>}
        {errors[`cancel:${child.childRunId}`] && <p role="alert">{errors[`cancel:${child.childRunId}`]}</p>}
      </article>)}
    </div>}
  </section>;
}
