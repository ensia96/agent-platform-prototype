import type { RefObject } from "react";
import type { ProviderProfile, ProviderResolution, Session } from "../shared/types";

export function ChatHeader({
  session,
  provider,
  modelOverride,
  activeRunId,
  waitingForApproval,
  lastProviderResolution,
  lastUnsupportedRunOptions,
  inspectorOpen,
  inspectorModal,
  pendingPermissionCount,
  inspectorToggleRef,
  onToggleInspector
}: {
  session: Session | null;
  provider: ProviderProfile | null;
  modelOverride: string;
  activeRunId: string | null;
  waitingForApproval: boolean;
  lastProviderResolution: ProviderResolution | null;
  lastUnsupportedRunOptions: string[];
  inspectorOpen: boolean;
  inspectorModal: boolean;
  pendingPermissionCount: number;
  inspectorToggleRef: RefObject<HTMLButtonElement>;
  onToggleInspector: () => void;
}) {
  const resolved = lastProviderResolution;
  const providerName = resolved?.providerProfileName ?? provider?.name ?? "Provider not loaded";
  const model = resolved?.model ?? (modelOverride.trim() || provider?.model || "provider default");
  const status = waitingForApproval ? "waiting for approval" : activeRunId ? "running" : session ? "ready" : "no session";
  const statusTone = waitingForApproval ? "waiting" : activeRunId ? "running" : "idle";
  const runtimeLabel = resolved ? (activeRunId ? "Resolved" : "Last run") : "Selected";

  return (
    <header className="chatHeader">
      <div className="chatHeaderIdentity">
        <div className="chatTitleRow">
          <h2>{session?.title ?? "No session"}</h2>
          <span className={`workspaceStatus ${statusTone}`}>{status}</span>
        </div>
        <p className="chatRuntimeSummary">
          <span className="runtimeContextLabel">{runtimeLabel}</span>
          <span title={resolved ? `Resolved profile: ${resolved.providerProfileId}` : undefined}>{providerName}</span>
          {resolved && (
            <>
              <span aria-hidden="true">·</span>
              <span>{resolved.providerType}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="monospace">{model}</span>
          {!resolved && provider && (
            <>
              <span aria-hidden="true">·</span>
              <span>{provider.status.state}</span>
            </>
          )}
          {resolved?.fallback && (
            <span className="runtimeWarningBadge" aria-label={`Provider fallback: ${resolved.fallback.message}`} title={resolved.fallback.message}>
              Fallback
            </span>
          )}
          {lastUnsupportedRunOptions.length > 0 && (
            <span
              className="runtimeWarningBadge"
              aria-label={`Unsupported run options, metadata only: ${lastUnsupportedRunOptions.join(", ")}`}
              title={`Metadata-only options: ${lastUnsupportedRunOptions.join(", ")}`}
            >
              {lastUnsupportedRunOptions.length} metadata-only {lastUnsupportedRunOptions.length === 1 ? "option" : "options"}
            </span>
          )}
        </p>
      </div>
      <button
        ref={inspectorToggleRef}
        type="button"
        className="inspectorToggle"
        aria-expanded={inspectorOpen}
        aria-controls="run-inspector"
        aria-haspopup={inspectorModal ? "dialog" : undefined}
        onClick={onToggleInspector}
      >
        {inspectorOpen ? "Hide inspector" : "Run inspector"}
        {pendingPermissionCount > 0 && (
          <span className="permissionCountBadge" aria-label={`${pendingPermissionCount} pending permissions`}>
            {pendingPermissionCount}
          </span>
        )}
      </button>
    </header>
  );
}
