import type { InvokeToolResponse, PermissionListResponse, PermissionRequest, PublicRunSummary, SubsessionDelegation } from "../shared/types";
import { RunVO } from "@/kernel/run/vo";
import { PermissionRequestVO } from "@/kernel/permission-request/vo";
import { ApiRequestError, requestJson, toErrorMessage } from "./api";

export interface ChildActionView {
  ownerRunId: string | null;
  children: SubsessionDelegation[];
  permissions: PermissionRequest[];
  busy: Record<string, boolean>;
  errors: Record<string, string>;
  reconnecting: boolean;
}

export function scopeChildPermissions(sessionId: string, parentRunId: string | null, children: SubsessionDelegation[], permissions: PermissionRequest[]) {
  const related = children.filter((child) => child.parentSessionId === sessionId);
  const ownerRunId = parentRunId ?? [...related].sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]?.parentRunId ?? null;
  const owned = related.filter((child) => child.parentRunId === ownerRunId);
  return {ownerRunId,children:owned,permissions:permissions.filter((p) => new PermissionRequestVO.Status(p.status).isPending() &&
    owned.some((child) => child.childSessionId === p.sessionId && child.childRunId === p.runId))};
}

/** Child actions never receive or mutate parent messages, EventSource, provider/model, or activeRun setters. */
export class ChildActionsController {
  view: ChildActionView = {ownerRunId:null,children:[],permissions:[],busy:{},errors:{},reconnecting:false};
  private version = 0;
  private loadingVersion: number | null = null;
  private disposed = false;
  private readonly resolved = new Set<string>();
  constructor(private readonly sessionId: string, private readonly parentRunId: string | null,
    private readonly isCurrent: () => boolean, private readonly publish: (view: ChildActionView) => void,
    private readonly request: typeof requestJson = requestJson) {}

  dispose(): void { this.disposed = true; this.version++; }
  private current(): boolean { return !this.disposed && this.isCurrent(); }
  private update(patch: Partial<ChildActionView>): void {
    if (!this.current()) return;
    this.view = {...this.view,...patch}; this.publish(this.view);
  }

  async refresh(): Promise<void> {
    if (!this.current() || this.loadingVersion === this.version) return;
    const version = ++this.version;
    this.loadingVersion = version;
    try {
      const [children,permissions] = await Promise.all([
        this.request<SubsessionDelegation[]>(`/api/sessions/${encodeURIComponent(this.sessionId)}/subsessions`),
        this.request<PermissionListResponse>("/api/permissions?status=pending")
      ]);
      if (!this.current() || version !== this.version) return;
      const scoped = scopeChildPermissions(this.sessionId,this.parentRunId,children,permissions.permissions);
      this.update({...scoped,permissions:scoped.permissions.filter((p) => !this.resolved.has(p.id)),reconnecting:false,
        ...(scoped.ownerRunId !== this.view.ownerRunId ? {busy:{},errors:{}} : {})});
    } catch {
      if (version === this.version) this.update({reconnecting:true});
    } finally {
      if (this.loadingVersion === version) this.loadingVersion = null;
    }
  }

  async permission(permissionId: string, action: "approve" | "deny"): Promise<void> {
    const permission = this.view.permissions.find((p) => p.id === permissionId);
    const child = permission && this.view.children.find((c) => c.childRunId === permission.runId && c.childSessionId === permission.sessionId);
    if (!permission || !child) return;
    await this.act(`permission:${permissionId}`,child,async () => {
      const response = await this.request<InvokeToolResponse>(`/api/permissions/${encodeURIComponent(permissionId)}/${action}`,{method:"POST"});
      if (response.permissionRequest?.id !== permissionId || response.run.id !== child.childRunId || response.run.sessionId !== child.childSessionId) {
        throw new Error("Child permission response ownership mismatch.");
      }
    },permissionId);
  }

  async cancel(childRunId: string): Promise<void> {
    const child = this.view.children.find((c) => c.childRunId === childRunId);
    if (!child || child.status !== "starting" && new RunVO.Status(child.status).isTerminal()) return;
    await this.act(`cancel:${childRunId}`,child,async () => {
      const response = await this.request<PublicRunSummary>(`/api/runs/${encodeURIComponent(childRunId)}/cancel`,{method:"POST"});
      if (response.id !== childRunId || response.sessionId !== child.childSessionId) throw new Error("Child cancellation response ownership mismatch.");
    });
  }

  private async act(key: string, child: SubsessionDelegation, operation: () => Promise<void>, permissionId?: string): Promise<void> {
    if (!this.current() || this.view.busy[key]) return;
    const owner = this.view.ownerRunId;
    const owns = () => this.current() && this.view.ownerRunId === owner && child.parentRunId === owner &&
      this.view.children.some((c) => c.id === child.id && c.childRunId === child.childRunId && c.childSessionId === child.childSessionId);
    if (!owns()) return;
    this.version++; // invalidate any GET begun before this action
    const errors = {...this.view.errors}; delete errors[key];
    this.update({busy:{...this.view.busy,[key]:true},errors});
    try {
      await operation();
      if (!owns()) return;
      if (permissionId) this.resolved.add(permissionId);
    } catch (error) {
      if (!owns()) return;
      if (error instanceof ApiRequestError && error.status === 409) {
        if (permissionId) this.resolved.add(permissionId);
      } else this.update({errors:{...this.view.errors,[key]:toErrorMessage(error)}});
    } finally {
      if (owns()) {
        this.version++;
        const busy = {...this.view.busy}; delete busy[key];
        this.update({busy,permissions:this.view.permissions.filter((p) => !this.resolved.has(p.id))});
        await this.refresh();
      }
    }
  }
}
