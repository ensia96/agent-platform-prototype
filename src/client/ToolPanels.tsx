import type { InvokeToolResponse, PermissionRequest, ToolDefinition } from "../shared/types";

export type ShellToolState = "idle" | "running" | "pending_permission" | "completed" | "failed" | "denied";

export function PendingPermissionsPanel({
  permissions,
  busyRequestId,
  onRefresh,
  onApprove,
  onDeny
}: {
  permissions: PermissionRequest[];
  busyRequestId: string | null;
  onRefresh: () => void;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
}) {
  return (
    <details className="permissionsPanel" open={permissions.length > 0}>
      <summary>Pending Permissions · {permissions.length}</summary>
      <p className="muted">
        shell.exec approvals for manual and model-requested tool calls. This is an experimental policy/approval layer, not a security sandbox.
      </p>
      <div className="permissionActionsHeader">
        <button type="button" onClick={onRefresh}>
          Refresh permissions
        </button>
      </div>
      {permissions.length === 0 ? (
        <p className="muted">No pending tool permissions.</p>
      ) : (
        <div className="permissionList">
          {permissions.map((permission) => {
            const busy = busyRequestId === permission.id;
            return (
              <article className={`permissionCard risk-${permission.riskLevel}`} key={permission.id}>
                <div className="permissionCardHeader">
                  <strong>{permission.toolName}</strong>
                  <span>{permission.riskLevel} risk</span>
                </div>
                <pre>{permission.inputSummary}</pre>
                <p>{permission.reason}</p>
                <dl className="partDetails">
                  <dt>Status</dt>
                  <dd>{permission.status}</dd>
                  <dt>Created</dt>
                  <dd>{new Date(permission.createdAt).toLocaleString()}</dd>
                  {permission.runId && (
                    <>
                      <dt>Run</dt>
                      <dd className="monospace">{permission.runId}</dd>
                    </>
                  )}
                </dl>
                <div className="permissionButtons">
                  <button type="button" onClick={() => onApprove(permission.id)} disabled={busy}>
                    {busy ? "Resolving..." : "Approve and run"}
                  </button>
                  <button type="button" className="dangerButton" onClick={() => onDeny(permission.id)} disabled={busy}>
                    Deny
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </details>
  );
}

export function ShellToolPanel({
  tool,
  sessionWorkingDirectory,
  command,
  cwd,
  timeoutMs,
  state,
  lastResponse,
  disabled,
  onCommandChange,
  onCwdChange,
  onTimeoutChange,
  onRun
}: {
  tool: ToolDefinition | null;
  sessionWorkingDirectory: string | null;
  command: string;
  cwd: string;
  timeoutMs: string;
  state: ShellToolState;
  lastResponse: InvokeToolResponse | null;
  disabled: boolean;
  onCommandChange: (value: string) => void;
  onCwdChange: (value: string) => void;
  onTimeoutChange: (value: string) => void;
  onRun: () => void;
}) {
  const busy = state === "running";
  const result = lastResponse?.result;
  const permission = lastResponse?.permissionRequest;
  return (
    <details className="shellToolPanel" open>
      <summary>
        Shell Tool · {tool?.id ?? "shell.exec"} · {state}
      </summary>
      <p className="muted">
        Debug/manual local shell invocation. Agent model tool calls use the same shell.exec registry entry and Tool Settings allow / ask / deny regex policy.
      </p>
      <form
        className="shellToolForm"
        onSubmit={(event) => {
          event.preventDefault();
          onRun();
        }}
      >
        <label>
          Command
          <input value={command} onChange={(event) => onCommandChange(event.target.value)} placeholder="echo hello" disabled={disabled || busy} />
        </label>
        <label>
          cwd
          <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} placeholder="session workingDirectory" disabled={disabled || busy} />
        </label>
        <label>
          Timeout (ms)
          <input value={timeoutMs} onChange={(event) => onTimeoutChange(event.target.value)} placeholder="Tool Settings default" disabled={disabled || busy} />
        </label>
        <button type="submit" disabled={disabled || busy || !command.trim() || !tool}>
          {busy ? "Running..." : "Run shell.exec"}
        </button>
      </form>
      <p className="muted shellToolMeta">
        {tool
          ? `Registered built-in tool. Empty cwd uses the session workingDirectory${sessionWorkingDirectory ? ` (${sessionWorkingDirectory})` : ""}; relative cwd resolves from that directory and absolute cwd is used as-is. Default timeout comes from Tool Settings.`
          : "Tool registry has not loaded shell.exec yet."}
      </p>
      {permission && lastResponse?.state === "pending_permission" && (
        <div className="shellToolResult pending">
          <strong>Approval pending</strong>
          <span>
            {permission.riskLevel} risk · {permission.reason}
          </span>
        </div>
      )}
      {result && (
        <div className={result.status === "completed" ? "shellToolResult success" : "shellToolResult failure"}>
          <strong>{result.status}</strong>
          <span>{summarizeShellResponse(lastResponse)}</span>
          {result.error && <pre>{result.error}</pre>}
        </div>
      )}
    </details>
  );
}

export function shellToolStateFromResponse(response: InvokeToolResponse): ShellToolState {
  if (response.state === "pending_permission") {
    return "pending_permission";
  }
  if (response.state === "denied") {
    return "denied";
  }
  return response.result?.status === "completed" ? "completed" : "failed";
}

function summarizeShellResponse(response: InvokeToolResponse | null): string {
  if (!response?.result) {
    return "";
  }
  const output = response.result.output;
  const exitCode = typeof output.exitCode === "number" ? `exit ${output.exitCode}` : "exit unknown";
  const duration = typeof output.durationMs === "number" ? `${output.durationMs}ms` : "duration unknown";
  const timedOut = output.timedOut === true ? " · timed out" : "";
  const truncated = output.stdoutTruncated === true || output.stderrTruncated === true ? " · output truncated" : "";
  return `${exitCode} · ${duration}${timedOut}${truncated}`;
}
