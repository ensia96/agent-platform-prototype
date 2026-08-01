import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import type {
  AgentDefinition,
  ContextPreviewResponse,
  InvokeToolResponse,
  PermissionRequest,
  ProviderProfile,
  ProviderResolution,
  ReasoningEffort,
  RunOptions,
  RunUsage,
  Session,
  ToolDefinition
} from "../shared/types";
import { formatUsage } from "./MessageBody";
import { agentToolIds, formatRunOptions } from "./SettingsPanel";
import { PendingPermissionsPanel, ShellToolPanel, type ShellToolState } from "./ToolPanels";

type LoadState = "idle" | "loading" | "error";
type SaveState = "idle" | "saving" | "saved";

export interface RunInspectorProps {
  onClose: () => void;
  modal: boolean;
  returnFocusRef: RefObject<HTMLButtonElement>;
  setup: {
    agents: AgentDefinition[];
    agentId: string;
    providers: ProviderProfile[];
    providerProfileId: string;
    modelOverride: string;
    reasoningEffort: ReasoningEffort | "";
    temperature: string;
    disabled: boolean;
    onAgentChange: (value: string) => void;
    onProviderChange: (value: string) => void;
    onModelOverrideChange: (value: string) => void;
    onReasoningEffortChange: (value: ReasoningEffort | "") => void;
    onTemperatureChange: (value: string) => void;
  };
  sessionContext: {
    session: Session | null;
    workingDirectoryDraft: string;
    saveState: SaveState;
    error: string | null;
    disabled: boolean;
    onWorkingDirectoryChange: (value: string) => void;
    onSaveWorkingDirectory: () => void;
  };
  runStatus: {
    activeRunId: string | null;
    waitingForApproval: boolean;
    providerNotice: string | null;
    lastProviderResolution: ProviderResolution | null;
    lastRunOptions: RunOptions | null;
    lastRunUsage: RunUsage | null;
    lastUnsupportedRunOptions: string[];
  };
  permissions: {
    items: PermissionRequest[];
    busyRequestId: string | null;
    onRefresh: () => void;
    onApprove: (requestId: string) => void;
    onDeny: (requestId: string) => void;
  };
  advanced: {
    contextPreview: ContextPreviewResponse | null;
    contextPreviewState: LoadState;
    onPreviewContext: () => void;
    shellTool: ToolDefinition | null;
    sessionWorkingDirectory: string | null;
    shellCommand: string;
    shellCwd: string;
    shellTimeoutMs: string;
    shellToolState: ShellToolState;
    lastShellResponse: InvokeToolResponse | null;
    shellDisabled: boolean;
    onShellCommandChange: (value: string) => void;
    onShellCwdChange: (value: string) => void;
    onShellTimeoutChange: (value: string) => void;
    onRunShell: () => void;
  };
}

export function RunInspector({ onClose, modal, returnFocusRef, setup, sessionContext, runStatus, permissions, advanced }: RunInspectorProps) {
  const inspectorRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const selectedAgent = setup.agents.find((agent) => agent.id === setup.agentId) ?? null;
  const selectedProvider = setup.providers.find((provider) => provider.id === setup.providerProfileId) ?? null;
  const runState = runStatus.waitingForApproval
    ? "waiting for approval"
    : runStatus.activeRunId
      ? "running"
      : runStatus.lastProviderResolution
        ? "last run"
        : "idle";
  const runStateTone = runStatus.waitingForApproval ? "waiting" : runStatus.activeRunId ? "running" : "idle";

  useEffect(() => {
    if (!modal) {
      return;
    }

    closeButtonRef.current?.focus();
    return () => {
      if (returnFocusRef.current?.isConnected) {
        returnFocusRef.current.focus();
      }
    };
  }, [modal, returnFocusRef]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!modal) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const inspector = inspectorRef.current;
    if (!inspector) {
      return;
    }
    const focusableElements = getFocusableElements(inspector);
    if (focusableElements.length === 0) {
      event.preventDefault();
      inspector.focus();
      return;
    }

    const activeElement = document.activeElement;
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    if (!focusableElements.includes(activeElement as HTMLElement)) {
      event.preventDefault();
      (event.shiftKey ? lastElement : firstElement).focus();
    } else if (event.shiftKey && activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  }

  return (
    <aside
      ref={inspectorRef}
      className="runInspector"
      id="run-inspector"
      role={modal ? "dialog" : undefined}
      aria-modal={modal ? true : undefined}
      aria-labelledby={modal ? "run-inspector-title" : undefined}
      aria-label={modal ? undefined : "Run inspector"}
      tabIndex={modal ? -1 : undefined}
      onKeyDown={modal ? handleKeyDown : undefined}
    >
      <header className="runInspectorHeader">
        <div>
          <span className="eyebrow">Workspace controls</span>
          <h2 id="run-inspector-title">Run Inspector</h2>
        </div>
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close run inspector">
          Close
        </button>
      </header>

      <div className="runInspectorBody">
        <details className="inspectorSection" open>
          <summary>Run setup</summary>
          <div className="inspectorSectionBody inspectorFormGrid">
            <label>
              Agent
              <select value={setup.agentId || "main"} onChange={(event) => setup.onAgentChange(event.target.value)} disabled={setup.disabled}>
                {setup.agents.length > 0 ? (
                  setup.agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} ({agent.id})
                    </option>
                  ))
                ) : (
                  <option value="main">Mango (main)</option>
                )}
              </select>
            </label>
            {selectedAgent && (
              <p className="inspectorHint">
                {selectedAgent.systemPrompt.slice(0, 90)}{selectedAgent.systemPrompt.length > 90 ? "…" : ""}
                <br />
                Tools: {agentToolIds(selectedAgent).join(", ") || "none"}
              </p>
            )}

            <label>
              Provider
              <select
                value={setup.providerProfileId || "mock"}
                onChange={(event) => setup.onProviderChange(event.target.value)}
                disabled={setup.disabled}
              >
                {setup.providers.length > 0 ? (
                  setup.providers.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {providerOptionLabel(profile)}
                    </option>
                  ))
                ) : (
                  <>
                    <option value="mock">mock</option>
                    <option value="openai-compatible">openai-compatible</option>
                  </>
                )}
              </select>
            </label>
            {selectedProvider && (
              <p className="inspectorHint">
                {selectedProvider.type} · default {selectedProvider.model ?? "provider model"} · {selectedProvider.status.state}
              </p>
            )}

            <label>
              Model override
              <input
                value={setup.modelOverride}
                onChange={(event) => setup.onModelOverrideChange(event.target.value)}
                placeholder={selectedProvider?.model ?? "provider default"}
                disabled={setup.disabled}
              />
            </label>
            <div className="inspectorFormRow">
              <label>
                Reasoning effort
                <select
                  value={setup.reasoningEffort}
                  onChange={(event) => setup.onReasoningEffortChange(event.target.value as ReasoningEffort | "")}
                  disabled={setup.disabled}
                >
                  <option value="">provider/default</option>
                  <option value="minimal">minimal</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                </select>
              </label>
              <label>
                Temperature
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={setup.temperature}
                  onChange={(event) => setup.onTemperatureChange(event.target.value)}
                  placeholder="default"
                  disabled={setup.disabled}
                />
              </label>
            </div>
            <p className="inspectorHint">Unsupported options remain metadata-only.</p>
          </div>
        </details>

        <details className="inspectorSection" open>
          <summary>Session context</summary>
          <div className="inspectorSectionBody">
            <SessionWorkingDirectoryPanel {...sessionContext} />
          </div>
        </details>

        <details className="inspectorSection" open>
          <summary>Run status & usage</summary>
          <div className="inspectorSectionBody">
            <div className="runStateRow">
              <span className={`workspaceStatus ${runStateTone}`}>{runState}</span>
              {runStatus.activeRunId && <span className="monospace inspectorRunId">{runStatus.activeRunId}</span>}
            </div>
            {runStatus.providerNotice && <div className="providerNotice">{runStatus.providerNotice}</div>}
            {runStatus.lastProviderResolution ? (
              <dl className="inspectorDetails">
                <dt>Provider</dt>
                <dd>{runStatus.lastProviderResolution.providerProfileName}</dd>
                <dt>Runtime</dt>
                <dd>{runStatus.lastProviderResolution.providerType}</dd>
                <dt>Model</dt>
                <dd>{runStatus.lastProviderResolution.model ?? "provider default"}</dd>
                <dt>Options</dt>
                <dd>{formatRunOptions(runStatus.lastRunOptions) || "default"}</dd>
                <dt>Usage</dt>
                <dd>{formatUsage(runStatus.lastRunUsage) || "not reported"}</dd>
                {runStatus.lastUnsupportedRunOptions.length > 0 && (
                  <>
                    <dt>Metadata-only</dt>
                    <dd>{runStatus.lastUnsupportedRunOptions.join(", ")}</dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="inspectorHint">Run metadata will appear after the first request.</p>
            )}
          </div>
        </details>

        <PendingPermissionsPanel
          permissions={permissions.items}
          busyRequestId={permissions.busyRequestId}
          onRefresh={permissions.onRefresh}
          onApprove={permissions.onApprove}
          onDeny={permissions.onDeny}
        />

        <details className="inspectorSection inspectorAdvanced">
          <summary>Developer / Advanced</summary>
          <div className="inspectorSectionBody advancedStack">
            <section className="advancedBlock">
              <div className="advancedBlockHeader">
                <div>
                  <strong>Context Preview</strong>
                  <p className="inspectorHint">Inspect the exact provider-neutral context for the current draft.</p>
                </div>
                <button type="button" onClick={advanced.onPreviewContext} disabled={setup.disabled || advanced.contextPreviewState === "loading"}>
                  {advanced.contextPreviewState === "loading" ? "Previewing..." : "Preview"}
                </button>
              </div>
              {advanced.contextPreview && <ContextPreviewPanel preview={advanced.contextPreview} />}
            </section>

            <ShellToolPanel
              tool={advanced.shellTool}
              sessionWorkingDirectory={advanced.sessionWorkingDirectory}
              command={advanced.shellCommand}
              cwd={advanced.shellCwd}
              timeoutMs={advanced.shellTimeoutMs}
              state={advanced.shellToolState}
              lastResponse={advanced.lastShellResponse}
              disabled={advanced.shellDisabled}
              onCommandChange={advanced.onShellCommandChange}
              onCwdChange={advanced.onShellCwdChange}
              onTimeoutChange={advanced.onShellTimeoutChange}
              onRun={advanced.onRunShell}
            />
          </div>
        </details>
      </div>
    </aside>
  );
}

function SessionWorkingDirectoryPanel({
  session,
  workingDirectoryDraft,
  saveState,
  error,
  disabled,
  onWorkingDirectoryChange,
  onSaveWorkingDirectory
}: RunInspectorProps["sessionContext"]) {
  const saving = saveState === "saving";
  const changed = Boolean(session) && workingDirectoryDraft.trim() !== session?.workingDirectory;

  return (
    <div className="workingDirectoryPanel">
      <p className="currentWorkingDirectory monospace" title={session?.workingDirectory}>
        {session?.workingDirectory ?? "No session selected"}
      </p>
      <form
        className="workingDirectoryForm"
        onSubmit={(event) => {
          event.preventDefault();
          onSaveWorkingDirectory();
        }}
      >
        <label>
          Working directory
          <input
            value={workingDirectoryDraft}
            onChange={(event) => onWorkingDirectoryChange(event.target.value)}
            placeholder="/absolute/project/path"
            disabled={!session || disabled || saving}
          />
        </label>
        <button type="submit" disabled={!session || disabled || saving || !workingDirectoryDraft.trim() || !changed}>
          {saving ? "Saving..." : "Save"}
        </button>
      </form>
      <p className="inspectorHint">Used as the default cwd for shell.exec and relative shell paths.</p>
      {error && <div className="inlineError">{error}</div>}
      {saveState === "saved" && !error && <div className="inlineSuccess">Saved.</div>}
    </div>
  );
}

function ContextPreviewPanel({ preview }: { preview: ContextPreviewResponse }) {
  return (
    <div className="contextPreview">
      <p className="contextPreviewSummary">
        {preview.context.agent.name} · {preview.context.messages.length} messages · {preview.providerResolution.providerProfileName}
      </p>
      <div className="contextPreviewGrid">
        <section>
          <h4>System prompt</h4>
          <pre>{preview.context.systemPrompt}</pre>
        </section>
        <section>
          <h4>Run options</h4>
          <pre>{JSON.stringify(preview.context.runOptions, null, 2)}</pre>
        </section>
        <section>
          <h4>Working directory</h4>
          <pre>{preview.context.workingDirectory}</pre>
        </section>
        <section>
          <h4>Available tools</h4>
          {preview.context.availableTools.length === 0 ? (
            <p className="inspectorHint">No model tools available.</p>
          ) : (
            <ul className="contextToolList">
              {preview.context.availableTools.map((tool) => (
                <li key={tool.id}>
                  <strong>{tool.id}</strong> <span className="inspectorHint">as {tool.providerName}</span>
                  <p>{tool.description}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="contextMessagesPreview">
          <h4>Messages</h4>
          {preview.context.messages.length === 0 ? (
            <p className="inspectorHint">No text messages in context.</p>
          ) : (
            preview.context.messages.map((message, index) => (
              <div className="contextMessage" key={`${message.messageId ?? "current"}-${index}`}>
                <strong>
                  {index + 1}. {message.role}
                  {message.source ? ` · ${message.source}` : ""}
                </strong>
                {message.parts && message.parts.length > 0 && (
                  <span className="contextPartTypes">parts: {message.parts.map((part) => part.type).join(", ")}</span>
                )}
                <pre>{message.content}</pre>
              </div>
            ))
          )}
        </section>
      </div>
      {preview.warnings.length > 0 && <p className="inspectorHint">Warnings: {preview.warnings.join(" ")}</p>}
    </div>
  );
}

function providerOptionLabel(profile: ProviderProfile): string {
  const model = profile.model ? ` · ${profile.model}` : "";
  return `${profile.name}${model} · ${profile.status.state}`;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "summary",
    "[contenteditable='true']",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0
  );
}
