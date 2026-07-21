import { useEffect, useRef, useState } from "react";
import type {
  AgentDefinition,
  AgentListResponse,
  ContextPreviewResponse,
  CreateRunResponse,
  InvokeToolResponse,
  Message,
  MessagePart,
  PermissionListResponse,
  PermissionRequest,
  ProviderListResponse,
  ProviderProfile,
  ProviderResolution,
  ReasoningEffort,
  RunEvent,
  RunOptions,
  RunUsage,
  Session,
  ToolDefinition,
  ToolListResponse
} from "../shared/types";
import { requestJson, toErrorMessage } from "./api";
import { compareParts, formatUsage, MessageBody, partText } from "./MessageBody";
import { agentToolIds, formatRunOptions, SettingsPanel } from "./SettingsPanel";
import { PendingPermissionsPanel, ShellToolPanel, shellToolStateFromResponse, type ShellToolState } from "./ToolPanels";

type LoadState = "idle" | "loading" | "error";
type Tab = "chat" | "settings";
type SaveState = "idle" | "saving" | "saved";

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [agentId, setAgentId] = useState("main");
  const [providerProfileId, setProviderProfileId] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">("");
  const [temperature, setTemperature] = useState("");
  const [lastProviderResolution, setLastProviderResolution] = useState<ProviderResolution | null>(null);
  const [lastRunOptions, setLastRunOptions] = useState<RunOptions | null>(null);
  const [lastRunUsage, setLastRunUsage] = useState<RunUsage | null>(null);
  const [lastUnsupportedRunOptions, setLastUnsupportedRunOptions] = useState<string[]>([]);
  const [providerNotice, setProviderNotice] = useState<string | null>(null);
  const [contextPreview, setContextPreview] = useState<ContextPreviewResponse | null>(null);
  const [contextPreviewState, setContextPreviewState] = useState<LoadState>("idle");
  const [workingDirectoryDraft, setWorkingDirectoryDraft] = useState("");
  const [workingDirectorySaveState, setWorkingDirectorySaveState] = useState<SaveState>("idle");
  const [workingDirectoryError, setWorkingDirectoryError] = useState<string | null>(null);
  const [shellCommand, setShellCommand] = useState("");
  const [shellCwd, setShellCwd] = useState("");
  const [shellTimeoutMs, setShellTimeoutMs] = useState("");
  const [shellToolState, setShellToolState] = useState<ShellToolState>("idle");
  const [lastShellResponse, setLastShellResponse] = useState<InvokeToolResponse | null>(null);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [permissionActionId, setPermissionActionId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const eventsRef = useRef<EventSource | null>(null);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;

  useEffect(() => {
    void loadSessions();
    void loadProviders();
    void loadAgents();
    void loadTools();
    void loadPendingPermissions();
    return () => eventsRef.current?.close();
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      setMessages([]);
      return;
    }
    void loadMessages(selectedSessionId);
  }, [selectedSessionId]);

  useEffect(() => {
    setWorkingDirectoryDraft(selectedSession?.workingDirectory ?? "");
    setWorkingDirectorySaveState("idle");
    setWorkingDirectoryError(null);
  }, [selectedSessionId, selectedSession?.workingDirectory]);

  useEffect(() => {
    if (activeTab === "chat") {
      void loadProviders();
      void loadAgents();
      void loadTools();
      void loadPendingPermissions();
    }
  }, [activeTab]);

  async function loadSessions() {
    setLoadState("loading");
    setError(null);
    try {
      const nextSessions = await requestJson<Session[]>("/api/sessions");
      setSessions(nextSessions);
      setSelectedSessionId((current) => current ?? nextSessions[0]?.id ?? null);
      setLoadState("idle");
    } catch (requestError) {
      setLoadState("error");
      setError(toErrorMessage(requestError));
    }
  }

  async function loadMessages(sessionId: string) {
    setError(null);
    try {
      setMessages(await requestJson<Message[]>(`/api/sessions/${sessionId}/messages`));
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    }
  }

  async function loadProviders() {
    try {
      const response = await requestJson<ProviderListResponse>("/api/providers");
      setProviders(response.providers);
      setProviderProfileId((current) =>
        response.providers.some((profile) => profile.id === current) ? current : response.defaultProviderProfileId
      );
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    }
  }

  async function loadAgents() {
    try {
      const response = await requestJson<AgentListResponse>("/api/agents");
      setAgents(response.agents);
      setAgentId((current) => (response.agents.some((agent) => agent.id === current) ? current : response.defaultAgentId));
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    }
  }

  async function loadTools() {
    try {
      const response = await requestJson<ToolListResponse>("/api/tools");
      setTools(response.tools);
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    }
  }

  async function loadPendingPermissions() {
    try {
      const response = await requestJson<PermissionListResponse>("/api/permissions?status=pending");
      setPendingPermissions(response.permissions);
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    }
  }

  async function createSession() {
    setError(null);
    try {
      const session = await requestJson<Session>("/api/sessions", { method: "POST" });
      setSessions((current) => [session, ...current]);
      setSelectedSessionId(session.id);
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    }
  }

  async function saveSessionWorkingDirectory() {
    if (!selectedSessionId) {
      setWorkingDirectoryError("Select or create a session before changing its working directory.");
      return;
    }
    const workingDirectory = workingDirectoryDraft.trim();
    if (!workingDirectory) {
      setWorkingDirectoryError("Working directory is required.");
      return;
    }

    setWorkingDirectorySaveState("saving");
    setWorkingDirectoryError(null);
    try {
      const session = await requestJson<Session>(`/api/sessions/${selectedSessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workingDirectory })
      });
      setSessions((current) => current.map((item) => (item.id === session.id ? session : item)));
      setWorkingDirectoryDraft(session.workingDirectory);
      setWorkingDirectorySaveState("saved");
    } catch (requestError) {
      setWorkingDirectorySaveState("idle");
      setWorkingDirectoryError(toErrorMessage(requestError));
    }
  }

  async function startRun() {
    const text = input.trim();
    if (!text || activeRunId) {
      return;
    }

    setError(null);
    let sessionId = selectedSessionId;
    try {
      const runOptions = buildRunOptionsFromForm(modelOverride, reasoningEffort, temperature);
      if (!sessionId) {
        const session = await requestJson<Session>("/api/sessions", { method: "POST" });
        setSessions((current) => [session, ...current]);
        setSelectedSessionId(session.id);
        sessionId = session.id;
      }

      setInput("");
      setContextPreview(null);
      const response = await requestJson<CreateRunResponse>(`/api/sessions/${sessionId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          agentId: agentId || "main",
          providerProfileId: providerProfileId || undefined,
          runOptions: hasRunOptions(runOptions) ? runOptions : undefined
        })
      });
      setLastProviderResolution(response.providerResolution);
      setLastRunOptions(response.runOptions);
      setLastRunUsage(response.usage);
      setLastUnsupportedRunOptions(response.unsupportedRunOptions);
      setProviderNotice(providerResolutionNotice(response.providerResolution));
      setActiveRunId(response.run.id);
      openRunEvents(response.run.id);
      void loadSessions();
    } catch (requestError) {
      setError(toErrorMessage(requestError));
      setInput(text);
    }
  }

  async function cancelRun() {
    if (!activeRunId) {
      return;
    }

    setError(null);
    try {
      await requestJson(`/api/runs/${activeRunId}/cancel`, { method: "POST" });
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    }
  }

  async function previewContext() {
    if (!selectedSessionId) {
      setError("Create or select a session before previewing context.");
      return;
    }

    setContextPreviewState("loading");
    setError(null);
    try {
      const runOptions = buildRunOptionsFromForm(modelOverride, reasoningEffort, temperature);
      const response = await requestJson<ContextPreviewResponse>(`/api/sessions/${selectedSessionId}/context/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agentId || "main",
          providerProfileId: providerProfileId || undefined,
          runOptions: hasRunOptions(runOptions) ? runOptions : undefined,
          text: input.trim() || undefined
        })
      });
      setContextPreview(response);
      setContextPreviewState("idle");
    } catch (requestError) {
      setContextPreviewState("error");
      setError(toErrorMessage(requestError));
    }
  }

  async function executeShellTool() {
    const command = shellCommand.trim();
    if (!command || shellToolState === "running") {
      return;
    }

    setError(null);
    setLastShellResponse(null);
    setShellToolState("running");
    let sessionId = selectedSessionId;
    try {
      if (!sessionId) {
        const session = await requestJson<Session>("/api/sessions", { method: "POST" });
        setSessions((current) => [session, ...current]);
        setSelectedSessionId(session.id);
        sessionId = session.id;
      }

      const timeoutMs = parseShellTimeout(shellTimeoutMs);
      const response = await requestJson<InvokeToolResponse>(`/api/sessions/${sessionId}/tools/shell.exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command,
          cwd: shellCwd.trim() || undefined,
          timeoutMs
        })
      });
      setLastShellResponse(response);
      setShellToolState(shellToolStateFromResponse(response));
      upsertMessage(response.message);
      void loadMessages(sessionId);
      void loadSessions();
      void loadPendingPermissions();
    } catch (requestError) {
      setShellToolState("failed");
      setError(toErrorMessage(requestError));
    }
  }

  async function approvePermission(requestId: string) {
    setPermissionActionId(requestId);
    setError(null);
    try {
      const response = await requestJson<InvokeToolResponse>(`/api/permissions/${requestId}/approve`, { method: "POST" });
      setLastShellResponse(response);
      setShellToolState(shellToolStateFromResponse(response));
      upsertMessage(response.message);
      openRunEventsIfAgentResume(response);
      if (response.message.sessionId === selectedSessionId) {
        void loadMessages(response.message.sessionId);
      }
      void loadSessions();
      await loadPendingPermissions();
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    } finally {
      setPermissionActionId(null);
    }
  }

  async function denyPermission(requestId: string) {
    setPermissionActionId(requestId);
    setError(null);
    try {
      const response = await requestJson<InvokeToolResponse>(`/api/permissions/${requestId}/deny`, { method: "POST" });
      setLastShellResponse(response);
      setShellToolState(shellToolStateFromResponse(response));
      upsertMessage(response.message);
      openRunEventsIfAgentResume(response);
      if (response.message.sessionId === selectedSessionId) {
        void loadMessages(response.message.sessionId);
      }
      void loadSessions();
      await loadPendingPermissions();
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    } finally {
      setPermissionActionId(null);
    }
  }

  function openRunEvents(runId: string) {
    eventsRef.current?.close();
    const source = new EventSource(`/api/runs/${runId}/events`);
    eventsRef.current = source;

    source.onmessage = (event) => {
      const runEvent = JSON.parse(event.data) as RunEvent;
      applyRunEvent(runEvent);
      if (isTerminalEvent(runEvent.type)) {
        source.close();
        if (eventsRef.current === source) {
          eventsRef.current = null;
        }
        setActiveRunId(null);
        void loadSessions();
      }
    };

    source.onerror = () => {
      setError("SSE connection failed or closed unexpectedly.");
      source.close();
      if (eventsRef.current === source) {
        eventsRef.current = null;
      }
      setActiveRunId(null);
    };
  }

  function applyRunEvent(event: RunEvent) {
    if (event.type === "run_started") {
      const payload = event.payload as {
        providerResolution?: ProviderResolution;
        runOptions?: RunOptions;
        unsupportedRunOptions?: string[];
      };
      if (payload.providerResolution) {
        setLastProviderResolution(payload.providerResolution);
        setProviderNotice(providerResolutionNotice(payload.providerResolution));
      }
      setLastRunOptions(payload.runOptions ?? null);
      setLastRunUsage(null);
      setLastUnsupportedRunOptions(payload.unsupportedRunOptions ?? []);
      return;
    }

    if (event.type === "user_message_created" || event.type === "assistant_message_created" || event.type === "assistant_message_updated") {
      const payload = event.payload as { message?: Message };
      if (payload.message) {
        upsertMessage(payload.message);
      }
      return;
    }

    if (event.type === "delta") {
      const payload = event.payload as { messageId?: string; text?: string };
      if (payload.messageId && payload.text) {
        appendDelta(payload.messageId, payload.text);
      }
      return;
    }

    if (event.type === "tool_call.created" || event.type === "tool_result.created") {
      const payload = event.payload as { messageId?: string; part?: MessagePart };
      if (payload.messageId && payload.part) {
        upsertMessagePart(payload.messageId, payload.part);
      }
      return;
    }

    if (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed") {
      const payload = event.payload as { messageId?: string; part?: MessagePart; outputPart?: MessagePart; error?: string };
      if (payload.messageId && payload.part) {
        upsertMessagePart(payload.messageId, payload.part);
      }
      if (payload.messageId && payload.outputPart) {
        upsertMessagePart(payload.messageId, payload.outputPart);
      }
      if (payload.error) {
        setError(payload.error);
      }
      return;
    }

    if (event.type === "tool.stdout.delta" || event.type === "tool.stderr.delta") {
      const payload = event.payload as { messageId?: string; partId?: string; part?: MessagePart; text?: string };
      if (payload.messageId && payload.part) {
        upsertMessagePart(payload.messageId, payload.part);
      } else if (payload.messageId && payload.partId && payload.text) {
        appendPartDelta(payload.messageId, payload.partId, payload.text);
      }
      return;
    }

    if (event.type === "permission.requested" || event.type === "permission.approved" || event.type === "permission.denied") {
      void loadPendingPermissions();
      return;
    }

    if (event.type === "run_waiting_permission") {
      const payload = event.payload as { runId?: string };
      if (payload.runId) {
        setActiveRunId(payload.runId);
      }
      void loadPendingPermissions();
      return;
    }

    if (event.type === "run_completed" || event.type === "run_cancelled" || event.type === "run_failed") {
      const payload = event.payload as { messageId?: string; error?: string; metadata?: Message["metadata"]; usage?: RunUsage };
      if (payload.usage) {
        setLastRunUsage(payload.usage);
      }
      if (payload.messageId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === payload.messageId
              ? {
                  ...message,
                  status:
                    event.type === "run_completed" ? "completed" : event.type === "run_cancelled" ? "cancelled" : "failed",
                  error: event.type === "run_failed" ? payload.error ?? message.error ?? "Run failed without an error message." : null,
                  metadata: payload.metadata ? { ...message.metadata, ...payload.metadata } : message.metadata,
                  usage: payload.usage ?? message.usage ?? null
                }
              : message
          )
        );
      }
      if (payload.error) {
        setError(payload.error);
      }
    }
  }

  function upsertMessage(message: Message) {
    setMessages((current) => {
      const exists = current.some((item) => item.id === message.id);
      const next = exists ? current.map((item) => (item.id === message.id ? message : item)) : [...current, message];
      return next.sort(compareMessages);
    });
  }

  function appendDelta(messageId: string, delta: string) {
    setMessages((current) =>
      current.map((message) => {
        if (message.id !== messageId) {
          return message;
        }

        const textPart = message.parts.find((part) => part.type === "text");
        const nextPart = textPart
          ? {
              ...textPart,
              text: textPart.text + delta,
              content: { ...textPart.content, text: textPart.text + delta },
              updatedAt: new Date().toISOString()
            }
          : {
              id: `${messageId}:local-text`,
              messageId,
              seq: 0,
              type: "text" as const,
              text: delta,
              content: { text: delta },
              metadata: {},
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };

        const nextParts = textPart
          ? message.parts.map((part) => (part.id === textPart.id ? nextPart : part))
          : [nextPart, ...message.parts];

        return {
          ...message,
          status: "streaming",
          parts: nextParts.sort(compareParts)
        };
      })
    );
  }

  function upsertMessagePart(messageId: string, part: MessagePart) {
    setMessages((current) =>
      current.map((message) => {
        if (message.id !== messageId) {
          return message;
        }
        const exists = message.parts.some((item) => item.id === part.id);
        const parts = exists ? message.parts.map((item) => (item.id === part.id ? part : item)) : [...message.parts, part];
        return { ...message, parts: parts.sort(compareParts) };
      })
    );
  }

  function appendPartDelta(messageId: string, partId: string, delta: string) {
    setMessages((current) =>
      current.map((message) => {
        if (message.id !== messageId) {
          return message;
        }
        return {
          ...message,
          parts: message.parts.map((part) =>
            part.id === partId
              ? {
                  ...part,
                  text: part.text + delta,
                  content: { ...part.content, text: `${partText(part)}${delta}` },
                  updatedAt: new Date().toISOString()
                }
              : part
          )
        };
      })
    );
  }

  function openRunEventsIfAgentResume(response: InvokeToolResponse) {
    if (response.run.provider.startsWith("tool:")) {
      return;
    }
    if (response.run.status === "running" || response.run.status === "waiting_permission") {
      setActiveRunId(response.run.id);
      openRunEvents(response.run.id);
    }
  }

  const selectedAgent = agents.find((agent) => agent.id === agentId) ?? null;
  const selectedProviderProfile = providers.find((profile) => profile.id === providerProfileId) ?? null;
  const shellTool = tools.find((tool) => tool.id === "shell.exec") ?? null;

  return (
    <main className="appShell">
      <aside className="sidebar">
        <div className="sidebarHeader">
          <h1>Prototype</h1>
          {activeTab === "chat" && <button onClick={createSession}>New</button>}
        </div>

        <nav className="tabList" aria-label="Dashboard sections">
          <button className={activeTab === "chat" ? "tab active" : "tab"} onClick={() => setActiveTab("chat")}>
            Chat
          </button>
          <button className={activeTab === "settings" ? "tab active" : "tab"} onClick={() => setActiveTab("settings")}>
            Settings
          </button>
        </nav>

        {activeTab === "chat" ? (
          <>
            {loadState === "loading" && <p className="muted">Loading sessions...</p>}
            <div className="sessionList">
              {sessions.map((session) => (
                <button
                  className={session.id === selectedSessionId ? "session active" : "session"}
                  key={session.id}
                  onClick={() => setSelectedSessionId(session.id)}
                >
                  <strong>{session.title}</strong>
                  <span className="sessionCwd monospace">{session.workingDirectory}</span>
                  <span>{new Date(session.updatedAt).toLocaleString()}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="muted sidebarNote">Daemon lifecycle stays in the CLI. Settings and registries live here.</p>
        )}
      </aside>

      {activeTab === "chat" ? (
        <section className="chatPane">
        <header className="chatHeader">
          <div>
            <h2>{selectedSession?.title ?? "No session"}</h2>
            <p className="muted">SQLite-backed local chat with SSE streaming.</p>
          </div>
          <div className="chatControls">
            <div className="agentPicker">
              <label>
                Agent
                <select value={agentId || "main"} onChange={(event) => setAgentId(event.target.value)} disabled={Boolean(activeRunId)}>
                  {agents.length > 0 ? (
                    agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} ({agent.id})
                      </option>
                    ))
                  ) : (
                    <option value="main">Mango (main)</option>
                  )}
                </select>
              </label>
              <p className="muted providerSummary">
                {selectedAgent
                  ? `System prompt: ${selectedAgent.systemPrompt.slice(0, 96)}${selectedAgent.systemPrompt.length > 96 ? "…" : ""} · tools: ${agentToolIds(selectedAgent).join(", ") || "none"}`
                  : "Main agent"}
              </p>
            </div>

            <div className="providerPicker">
              <label>
                Provider
                <select
                  value={providerProfileId || "mock"}
                  onChange={(event) => {
                    setProviderProfileId(event.target.value);
                    setModelOverride("");
                    setReasoningEffort("");
                    setTemperature("");
                    setProviderNotice(null);
                  }}
                  disabled={Boolean(activeRunId)}
                >
                  {providers.length > 0 ? (
                    providers.map((profile) => (
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
              {selectedProviderProfile && (
                <p className="muted providerSummary">
                  {selectedProviderProfile.type}
                  {selectedProviderProfile.model ? ` · default ${selectedProviderProfile.model}` : ""} · {selectedProviderProfile.status.state}
                </p>
              )}
            </div>

            <div className="runOptionsPanel" aria-label="Run options">
              <label>
                Model override
                <input
                  value={modelOverride}
                  onChange={(event) => setModelOverride(event.target.value)}
                  placeholder={selectedProviderProfile?.model ?? "provider default"}
                  disabled={Boolean(activeRunId)}
                />
              </label>
              <label>
                Reasoning effort
                <select
                  value={reasoningEffort}
                  onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort | "")}
                  disabled={Boolean(activeRunId)}
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
                  value={temperature}
                  onChange={(event) => setTemperature(event.target.value)}
                  placeholder="default"
                  disabled={Boolean(activeRunId)}
                />
              </label>
              <p className="muted runOptionsNote">
                Experimental: unsupported options are kept as metadata only. Raw thinking is not stored or shown.
              </p>
            </div>
          </div>
        </header>

        <div className="chatBanners">
          <SessionWorkingDirectoryPanel
            session={selectedSession}
            value={workingDirectoryDraft}
            state={workingDirectorySaveState}
            error={workingDirectoryError}
            disabled={Boolean(activeRunId)}
            onChange={(value) => {
              setWorkingDirectoryDraft(value);
              setWorkingDirectorySaveState("idle");
              setWorkingDirectoryError(null);
            }}
            onSave={() => void saveSessionWorkingDirectory()}
          />
          {providerNotice && <div className="providerNotice">{providerNotice}</div>}
          {lastProviderResolution && (
            <div className="providerRunMeta">
              Last run: {lastProviderResolution.providerProfileName} ({lastProviderResolution.providerType}
              {lastProviderResolution.model ? ` · ${lastProviderResolution.model}` : ""})
              {formatRunOptions(lastRunOptions) ? ` · options: ${formatRunOptions(lastRunOptions)}` : ""}
              {lastUnsupportedRunOptions.length > 0 ? ` · metadata-only: ${lastUnsupportedRunOptions.join(", ")}` : ""}
              {lastRunUsage ? ` · usage: ${formatUsage(lastRunUsage)}` : ""}
            </div>
          )}
          {error && <div className="error">{error}</div>}
          {contextPreview && <ContextPreviewPanel preview={contextPreview} />}
          <PendingPermissionsPanel
            permissions={pendingPermissions}
            busyRequestId={permissionActionId}
            onRefresh={() => void loadPendingPermissions()}
            onApprove={(requestId) => void approvePermission(requestId)}
            onDeny={(requestId) => void denyPermission(requestId)}
          />
          <ShellToolPanel
            tool={shellTool}
            sessionWorkingDirectory={selectedSession?.workingDirectory ?? null}
            command={shellCommand}
            cwd={shellCwd}
            timeoutMs={shellTimeoutMs}
            state={shellToolState}
            lastResponse={lastShellResponse}
            disabled={Boolean(activeRunId)}
            onCommandChange={setShellCommand}
            onCwdChange={setShellCwd}
            onTimeoutChange={setShellTimeoutMs}
            onRun={() => void executeShellTool()}
          />
        </div>

        <div className="messages">
          {messages.length === 0 && <p className="muted empty">Create a session and send a message.</p>}
          {messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="messageMeta">
                <strong>{message.role}</strong>
                <span>{message.status}</span>
              </div>
              <MessageBody message={message} />
            </article>
          ))}
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void startRun();
          }}
        >
          <textarea
            value={input}
            placeholder="Send a message..."
            onChange={(event) => setInput(event.target.value)}
            disabled={Boolean(activeRunId)}
            rows={3}
          />
          <div className="composerActions">
            <button type="button" onClick={() => void previewContext()} disabled={Boolean(activeRunId) || contextPreviewState === "loading"}>
              {contextPreviewState === "loading" ? "Previewing..." : "Context Preview"}
            </button>
            {activeRunId ? (
              <button type="button" onClick={cancelRun}>
                Cancel
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()}>
                Run
              </button>
            )}
          </div>
        </form>
        </section>
      ) : (
        <SettingsPanel />
      )}
    </main>
  );
}

function SessionWorkingDirectoryPanel({
  session,
  value,
  state,
  error,
  disabled,
  onChange,
  onSave
}: {
  session: Session | null;
  value: string;
  state: SaveState;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const saving = state === "saving";
  const changed = Boolean(session) && value.trim() !== session?.workingDirectory;
  return (
    <section className="workingDirectoryPanel">
      <div>
        <strong>Session working directory</strong>
        <p className="muted monospace">{session?.workingDirectory ?? "No session selected"}</p>
      </div>
      <form
        className="workingDirectoryForm"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <label>
          cwd
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="/absolute/project/path"
            disabled={!session || disabled || saving}
          />
        </label>
        <button type="submit" disabled={!session || disabled || saving || !value.trim() || !changed}>
          {saving ? "Saving..." : "Save cwd"}
        </button>
      </form>
      <p className="muted workingDirectoryHint">
        shell.exec without cwd uses this path; relative shell cwd values resolve from it.
      </p>
      {error && <div className="inlineError">{error}</div>}
      {state === "saved" && !error && <div className="inlineSuccess">Saved.</div>}
    </section>
  );
}

function ContextPreviewPanel({ preview }: { preview: ContextPreviewResponse }) {
  return (
    <details className="contextPreview" open>
      <summary>
        Context preview · {preview.context.agent.name} · {preview.context.messages.length} messages · {preview.providerResolution.providerProfileName}
      </summary>
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
            <p className="muted">No model tools available.</p>
          ) : (
            <ul className="contextToolList">
              {preview.context.availableTools.map((tool) => (
                <li key={tool.id}>
                  <strong>{tool.id}</strong> <span className="muted">as {tool.providerName}</span>
                  <p>{tool.description}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="contextMessagesPreview">
          <h4>Messages</h4>
          {preview.context.messages.length === 0 ? (
            <p className="muted">No text messages in context.</p>
          ) : (
            preview.context.messages.map((message, index) => (
              <div className="contextMessage" key={`${message.messageId ?? "current"}-${index}`}>
                <strong>
                  {index + 1}. {message.role}
                  {message.source ? ` · ${message.source}` : ""}
                </strong>
                {message.parts && message.parts.length > 0 && (
                  <span className="muted contextPartTypes">parts: {message.parts.map((part) => part.type).join(", ")}</span>
                )}
                <pre>{message.content}</pre>
              </div>
            ))
          )}
        </section>
      </div>
      {preview.warnings.length > 0 && <p className="muted">Warnings: {preview.warnings.join(" ")}</p>}
    </details>
  );
}

function providerOptionLabel(profile: ProviderProfile): string {
  const model = profile.model ? ` · ${profile.model}` : "";
  return `${profile.name}${model} · ${profile.status.state}`;
}

function buildRunOptionsFromForm(modelOverride: string, reasoningEffort: ReasoningEffort | "", temperature: string): RunOptions {
  const runOptions: RunOptions = {};
  const model = modelOverride.trim();
  if (model) {
    runOptions.model = model;
  }
  if (reasoningEffort) {
    runOptions.reasoningEffort = reasoningEffort;
  }
  const temperatureText = temperature.trim();
  if (temperatureText) {
    const parsedTemperature = Number(temperatureText);
    if (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 2) {
      throw new Error("Temperature must be a number between 0 and 2.");
    }
    runOptions.temperature = parsedTemperature;
  }
  return runOptions;
}

function parseShellTimeout(value: string): number | undefined {
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Shell timeout must be a positive integer number of milliseconds.");
  }
  return parsed;
}

function hasRunOptions(options: RunOptions): boolean {
  return Boolean(options.model || options.reasoningEffort || options.temperature !== undefined);
}

function providerResolutionNotice(resolution: ProviderResolution): string | null {
  if (!resolution.fallback) {
    return null;
  }
  return `Provider fallback: ${resolution.fallback.message}`;
}

function compareMessages(a: Message, b: Message): number {
  return a.createdAt.localeCompare(b.createdAt) || roleRank(a.role) - roleRank(b.role) || a.id.localeCompare(b.id);
}

function roleRank(role: Message["role"]): number {
  if (role === "system") {
    return 0;
  }
  if (role === "user") {
    return 1;
  }
  return 2;
}

function isTerminalEvent(type: RunEvent["type"]): boolean {
  return type === "run_completed" || type === "run_cancelled" || type === "run_failed";
}
