import { useEffect, useRef, useState } from "react";
import { defaultShellToolSettings, defaultToolSettings, ToolSettingsValidationError, validateToolSettings } from "../shared/tool-settings";
import type {
  AgentDefinition,
  AgentListResponse,
  AppSettingsResponse,
  ContextPreviewResponse,
  CreateRunResponse,
  DaemonStatus,
  InvokeToolResponse,
  JsonObject,
  Message,
  MessagePart,
  OpenAIChatGPTAuthPollResponse,
  OpenAIChatGPTAuthStartResponse,
  OpenAIChatGPTLogoutResponse,
  PermissionListResponse,
  PermissionRequest,
  ProviderListResponse,
  ProviderProfile,
  ProviderResolution,
  ProviderTestResponse,
  ReasoningEffort,
  RunOptions,
  RunUsage,
  RunEvent,
  Session,
  ToolDefinition,
  ToolSettings,
  ToolSettingsResponse,
  ToolListResponse
} from "../shared/types";

type LoadState = "idle" | "loading" | "error";
type Tab = "chat" | "settings";
type ShellToolState = "idle" | "running" | "pending_permission" | "completed" | "failed" | "denied";

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

    if (event.type === "user_message_created" || event.type === "assistant_message_created") {
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
      }
      if (payload.messageId && payload.partId && payload.text) {
        appendPartDelta(payload.messageId, payload.partId, payload.text);
      }
      return;
    }

    if (event.type === "permission.requested" || event.type === "permission.approved" || event.type === "permission.denied") {
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

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
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
                {selectedAgent ? `System prompt: ${selectedAgent.systemPrompt.slice(0, 96)}${selectedAgent.systemPrompt.length > 96 ? "…" : ""}` : "Main agent"}
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

function MessageBody({ message }: { message: Message }) {
  return (
    <>
      {message.error && (
        <div className="messageError">
          <strong>Provider error</strong>
          <pre>{message.error}</pre>
        </div>
      )}
      <div className="messageParts">
        {message.parts.map((part) => (
          <MessagePartView key={part.id} part={part} />
        ))}
      </div>
      {message.usage && <UsageSummary usage={message.usage} />}
    </>
  );
}

function MessagePartView({ part }: { part: MessagePart }) {
  if (part.type === "text") {
    const text = partText(part);
    return text ? <pre className="messageTextPart">{text}</pre> : null;
  }

  if (part.type === "error") {
    return (
      <div className="messagePart messagePartError">
        <strong>Error</strong>
        <pre>{partString(part, "message") || part.text || "Unknown error"}</pre>
      </div>
    );
  }

  if (part.type === "reasoning_summary") {
    const usage = usageFromPart(part);
    const summary = partString(part, "summary") || part.text;
    return (
      <details className="messagePart messagePartReasoning">
        <summary>Reasoning metadata</summary>
        {summary && <pre>{summary}</pre>}
        {usage && <UsageSummary usage={usage} />}
      </details>
    );
  }

  if (part.type === "tool_call") {
    return (
      <details className="messagePart messagePartTool" open>
        <summary>Tool call · {partString(part, "toolName") || partString(part, "toolId") || "unknown"}</summary>
        <dl className="partDetails">
          <dt>Call ID</dt>
          <dd>{partString(part, "callId") || "unknown"}</dd>
          <dt>Status</dt>
          <dd>{partString(part, "status") || "created"}</dd>
          {partString(part, "provider") && (
            <>
              <dt>Provider</dt>
              <dd>{partString(part, "provider")}</dd>
            </>
          )}
        </dl>
        {partString(part, "inputSummary") && <pre>{partString(part, "inputSummary")}</pre>}
        <JsonPreview value={part.content.input} label="Input" />
      </details>
    );
  }

  if (part.type === "tool_result") {
    return (
      <details className="messagePart messagePartToolResult" open>
        <summary>
          Tool result · {partString(part, "toolName") || partString(part, "toolId") || partString(part, "callId") || "unknown"} ·{" "}
          {partString(part, "status") || "completed"}
        </summary>
        {(partString(part, "outputSummary") || partString(part, "output") || part.text) && (
          <pre>{partString(part, "outputSummary") || partString(part, "output") || part.text}</pre>
        )}
        {partString(part, "error") && <pre className="partErrorText">{partString(part, "error")}</pre>}
      </details>
    );
  }

  if (part.type === "command_output") {
    return (
      <div className="messagePart messagePartCommand">
        <strong>
          Command output{partString(part, "stream") ? ` · ${partString(part, "stream")}` : ""}
          {partNumber(part, "exitCode") !== null ? ` · exit ${partNumber(part, "exitCode")}` : ""}
          {partBoolean(part, "timedOut") ? " · timed out" : ""}
          {partBoolean(part, "truncated") ? " · truncated" : ""}
        </strong>
        {partString(part, "cwd") && <span className="muted monospace">cwd: {partString(part, "cwd")}</span>}
        <pre>{partString(part, "text") || part.text}</pre>
      </div>
    );
  }

  if (part.type === "file_ref") {
    return (
      <div className="messagePart messagePartFile">
        <strong>File reference</strong>
        <span className="monospace">{fileRefLabel(part)}</span>
      </div>
    );
  }

  return (
    <details className="messagePart">
      <summary>{part.type}</summary>
      <pre>{part.text || JSON.stringify(part.content, null, 2)}</pre>
    </details>
  );
}

function UsageSummary({ usage }: { usage: RunUsage }) {
  const summary = formatUsage(usage);
  if (!summary) {
    return null;
  }
  return <div className="usageSummary">Usage: {summary}</div>;
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

function PendingPermissionsPanel({
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
        Manual shell.exec approvals only. This is an experimental policy/approval layer, not a security sandbox.
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

function ShellToolPanel({
  tool,
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
        Manual local shell execution only. Commands pass through Tool Settings allow / ask / deny regex policy before running.
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
          <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} placeholder="home directory" disabled={disabled || busy} />
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
          ? `Registered built-in tool. cwd defaults to the user's home directory; relative cwd is resolved from home and absolute cwd is used as-is. Default timeout comes from Tool Settings.`
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

function SettingsPanel() {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [settingsData, setSettingsData] = useState<AppSettingsResponse | null>(null);
  const [providersData, setProvidersData] = useState<ProviderListResponse | null>(null);
  const [agentsData, setAgentsData] = useState<AgentListResponse | null>(null);
  const [providerTests, setProviderTests] = useState<Record<string, ProviderTestResponse>>({});
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [chatGPTAuthStart, setChatGPTAuthStart] = useState<OpenAIChatGPTAuthStartResponse | null>(null);
  const [chatGPTAuthPoll, setChatGPTAuthPoll] = useState<OpenAIChatGPTAuthPollResponse | null>(null);
  const [chatGPTAuthBusy, setChatGPTAuthBusy] = useState<"start" | "poll" | "logout" | null>(null);
  const [copiedAuthCode, setCopiedAuthCode] = useState(false);
  const [instanceLabel, setInstanceLabel] = useState("");
  const [toolSettings, setToolSettings] = useState<ToolSettings>(defaultToolSettings);
  const [toolSettingsSaveState, setToolSettingsSaveState] = useState<LoadState>("idle");
  const [toolSettingsError, setToolSettingsError] = useState<string | null>(null);
  const [mainAgentName, setMainAgentName] = useState("");
  const [mainAgentSystemPrompt, setMainAgentSystemPrompt] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [saveState, setSaveState] = useState<LoadState>("idle");
  const [agentSaveState, setAgentSaveState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadDashboardSettings();
  }, []);

  async function loadDashboardSettings() {
    setLoadState("loading");
    setError(null);
    try {
      const [nextStatus, nextSettings, nextToolSettings, nextProviders, nextAgents] = await Promise.all([
        requestJson<DaemonStatus>("/api/status"),
        requestJson<AppSettingsResponse>("/api/settings"),
        requestJson<ToolSettingsResponse>("/api/tool-settings"),
        requestJson<ProviderListResponse>("/api/providers"),
        requestJson<AgentListResponse>("/api/agents")
      ]);
      setStatus(nextStatus);
      setSettingsData(nextSettings);
      setToolSettings(nextToolSettings.settings);
      setToolSettingsError(null);
      setProvidersData(nextProviders);
      setAgentsData(nextAgents);
      setInstanceLabel(settingValueAsString(nextSettings.settings.instanceLabel));
      applyMainAgentDraft(nextAgents.agents.find((agent) => agent.id === nextAgents.defaultAgentId) ?? nextAgents.agents[0] ?? null);
      setLoadState("idle");
    } catch (requestError) {
      setLoadState("error");
      setError(toErrorMessage(requestError));
    }
  }

  async function saveInstanceLabel() {
    setSaveState("loading");
    setError(null);
    try {
      const nextSettings = await requestJson<AppSettingsResponse>("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceLabel: instanceLabel.trim() || null })
      });
      setSettingsData(nextSettings);
      setInstanceLabel(settingValueAsString(nextSettings.settings.instanceLabel));
      setSaveState("idle");
    } catch (requestError) {
      setSaveState("error");
      setError(toErrorMessage(requestError));
    }
  }

  function updateToolSettings(patch: Partial<ToolSettings>) {
    setToolSettings((current) => ({ ...current, ...patch }));
    setToolSettingsError(null);
  }

  function updateShellExecutionSetting(field: keyof ToolSettings["shell"], value: string) {
    const trimmed = value.trim();
    const parsedValue = trimmed ? Number(trimmed) : undefined;
    setToolSettings((current) => ({
      ...current,
      shell: {
        ...current.shell,
        [field]: parsedValue
      }
    }));
    setToolSettingsError(null);
  }

  async function saveToolSettings() {
    setToolSettingsSaveState("loading");
    setToolSettingsError(null);
    setError(null);
    try {
      validateToolSettings(toolSettings);
      const response = await requestJson<ToolSettingsResponse>("/api/tool-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: toolSettings })
      });
      setToolSettings(response.settings);
      setSettingsData((current) =>
        current
          ? {
              ...current,
              settings: {
                ...current.settings,
                toolSettings: toolSettingsJson(response.settings)
              }
            }
          : current
      );
      setToolSettingsSaveState("idle");
    } catch (requestError) {
      setToolSettingsSaveState("error");
      setToolSettingsError(formatToolSettingsError(requestError));
    }
  }

  function applyMainAgentDraft(agent: AgentDefinition | null) {
    setMainAgentName(agent?.name ?? "Mango");
    setMainAgentSystemPrompt(agent?.systemPrompt ?? "");
  }

  async function saveMainAgent() {
    setAgentSaveState("loading");
    setError(null);
    try {
      const agent = await requestJson<AgentDefinition>("/api/agents/main", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: mainAgentName.trim() || "Mango",
          systemPrompt: mainAgentSystemPrompt
        })
      });
      setAgentsData((current) =>
        current
          ? {
              ...current,
              agents: current.agents.some((item) => item.id === agent.id)
                ? current.agents.map((item) => (item.id === agent.id ? agent : item))
                : [agent, ...current.agents]
            }
          : { agents: [agent], defaultAgentId: agent.id }
      );
      applyMainAgentDraft(agent);
      setAgentSaveState("idle");
    } catch (requestError) {
      setAgentSaveState("error");
      setError(toErrorMessage(requestError));
    }
  }

  async function testProvider(profileId: string) {
    setTestingProviderId(profileId);
    setError(null);
    try {
      const result = await requestJson<ProviderTestResponse>(`/api/providers/${encodeURIComponent(profileId)}/test`, {
        method: "POST"
      });
      setProviderTests((current) => ({ ...current, [profileId]: result }));
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    } finally {
      setTestingProviderId(null);
    }
  }

  async function startOpenAIChatGPTAuth() {
    setChatGPTAuthBusy("start");
    setChatGPTAuthPoll(null);
    setCopiedAuthCode(false);
    setError(null);
    try {
      const result = await requestJson<OpenAIChatGPTAuthStartResponse>("/api/providers/openai-chatgpt/auth/start", {
        method: "POST"
      });
      setChatGPTAuthStart(result);
      window.open(result.verificationUrl, "_blank", "noopener,noreferrer");
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    } finally {
      setChatGPTAuthBusy(null);
    }
  }

  async function pollOpenAIChatGPTAuth() {
    if (!chatGPTAuthStart) {
      return;
    }

    setChatGPTAuthBusy("poll");
    setError(null);
    try {
      const result = await requestJson<OpenAIChatGPTAuthPollResponse>("/api/providers/openai-chatgpt/auth/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId: chatGPTAuthStart.attemptId })
      });
      setChatGPTAuthPoll(result);
      if (result.status === "connected") {
        setChatGPTAuthStart(null);
        await loadDashboardSettings();
      }
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    } finally {
      setChatGPTAuthBusy(null);
    }
  }

  async function logoutOpenAIChatGPT() {
    setChatGPTAuthBusy("logout");
    setError(null);
    try {
      await requestJson<OpenAIChatGPTLogoutResponse>("/api/providers/openai-chatgpt/logout", { method: "POST" });
      setChatGPTAuthStart(null);
      setChatGPTAuthPoll(null);
      await loadDashboardSettings();
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    } finally {
      setChatGPTAuthBusy(null);
    }
  }

  async function copyOpenAIChatGPTCode() {
    if (!chatGPTAuthStart) {
      return;
    }

    try {
      await navigator.clipboard.writeText(chatGPTAuthStart.userCode);
      setCopiedAuthCode(true);
    } catch {
      setCopiedAuthCode(false);
    }
  }

  return (
    <section className="settingsPane">
      <header className="settingsHeader">
        <div>
          <h2>Settings</h2>
          <p className="muted">Daemon status, provider profiles, and adapter registry foundation.</p>
        </div>
        <button onClick={loadDashboardSettings} disabled={loadState === "loading"}>
          Refresh
        </button>
      </header>

      {error && <div className="error">{error}</div>}
      {loadState === "loading" && <p className="muted settingsLoading">Loading settings...</p>}

      <div className="settingsGrid">
        <article className="settingsCard">
          <h3>Daemon status</h3>
          {status ? (
            <dl className="statusGrid">
              <dt>Status</dt>
              <dd>{status.status}</dd>
              <dt>Version</dt>
              <dd>{status.version}</dd>
              <dt>PID</dt>
              <dd>{status.pid}</dd>
              <dt>Started</dt>
              <dd>{new Date(status.startedAt).toLocaleString()}</dd>
              <dt>Uptime</dt>
              <dd>{formatUptime(status.uptimeSeconds)}</dd>
              <dt>Mode</dt>
              <dd>{status.mode}</dd>
              <dt>Port</dt>
              <dd>{status.port}</dd>
              <dt>DB path</dt>
              <dd className="monospace">{status.dbPath}</dd>
            </dl>
          ) : (
            <p className="muted">No daemon status loaded yet.</p>
          )}
        </article>

        <article className="settingsCard toolSettingsCard">
          <div className="cardHeaderRow">
            <h3>Tool Settings</h3>
            <span className="muted">shell.exec policy and shell settings</span>
          </div>
          <p className="muted">
            JavaScript regular expressions only. Empty lines and lines starting with # are ignored. Evaluation order is Deny → Ask → Allow → Default. Use <code>.*</code> to match every command.
          </p>
          <p className="muted">
            shell.exec cwd defaults to the user's home directory. Relative cwd values resolve from home; absolute cwd values are used as-is and only checked for existence and directory type.
          </p>
          <label className="settingEditor">
            Default action
            <select
              value={toolSettings.defaultAction}
              onChange={(event) => updateToolSettings({ defaultAction: event.target.value as ToolSettings["defaultAction"] })}
            >
              <option value="allow">allow</option>
              <option value="ask">ask</option>
              <option value="deny">deny</option>
            </select>
          </label>
          <div className="toolPatternGrid">
            <label className="settingEditor">
              Deny regex patterns
              <textarea
                className="toolPatternEditor"
                value={toolSettings.denyPatternsText}
                onChange={(event) => updateToolSettings({ denyPatternsText: event.target.value })}
                rows={7}
                placeholder={"# deny examples\n^git\\s+push\\b\n^rm\\s+-rf\\b"}
              />
            </label>
            <label className="settingEditor">
              Ask regex patterns
              <textarea
                className="toolPatternEditor"
                value={toolSettings.askPatternsText}
                onChange={(event) => updateToolSettings({ askPatternsText: event.target.value })}
                rows={7}
                placeholder={"# ask examples\n^npm\\s+install\\b\n^git\\s+commit\\b"}
              />
            </label>
            <label className="settingEditor">
              Allow regex patterns
              <textarea
                className="toolPatternEditor"
                value={toolSettings.allowPatternsText}
                onChange={(event) => updateToolSettings({ allowPatternsText: event.target.value })}
                rows={7}
                placeholder={"# allow examples\n^pwd$\n^git\\s+status\\b"}
              />
            </label>
          </div>
          <div className="shellSettingsBlock">
            <h4>Shell execution settings</h4>
            <p className="muted">
              These settings control the built-in shell tool. Invocation timeout overrides must be less than or equal to max timeout; stdout/stderr are truncated at max output chars per stream.
            </p>
            <div className="shellSettingsGrid">
              <label className="settingEditor">
                Default timeout ms
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={toolShellSettingValue(toolSettings, "defaultTimeoutMs")}
                  onChange={(event) => updateShellExecutionSetting("defaultTimeoutMs", event.target.value)}
                />
              </label>
              <label className="settingEditor">
                Max timeout ms
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={toolShellSettingValue(toolSettings, "maxTimeoutMs")}
                  onChange={(event) => updateShellExecutionSetting("maxTimeoutMs", event.target.value)}
                />
              </label>
              <label className="settingEditor">
                Max output chars
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={toolShellSettingValue(toolSettings, "maxOutputChars")}
                  onChange={(event) => updateShellExecutionSetting("maxOutputChars", event.target.value)}
                />
              </label>
            </div>
          </div>
          {toolSettingsError && (
            <div className="testResult failure">
              <strong>Tool Settings validation failed</strong>
              <pre>{toolSettingsError}</pre>
            </div>
          )}
          <div className="providerActions">
            <button onClick={() => void saveToolSettings()} disabled={toolSettingsSaveState === "loading"}>
              {toolSettingsSaveState === "loading" ? "Saving..." : "Save Tool Settings"}
            </button>
            <button onClick={() => updateToolSettings(defaultToolSettings)} disabled={toolSettingsSaveState === "loading"}>
              Reset to default allow
            </button>
          </div>
        </article>

        <article className="settingsCard agentSettingsCard">
          <div className="cardHeaderRow">
            <h3>Main Agent</h3>
            {agentsData && <span className="muted">default: {agentsData.defaultAgentId}</span>}
          </div>
          <p className="muted">
            The main agent controls the system prompt that is injected by the provider-neutral Context Builder before each run.
          </p>
          <label className="settingEditor">
            Agent name
            <input value={mainAgentName} onChange={(event) => setMainAgentName(event.target.value)} placeholder="Mango" />
          </label>
          <label className="settingEditor">
            System prompt
            <textarea
              className="agentPromptEditor"
              value={mainAgentSystemPrompt}
              onChange={(event) => setMainAgentSystemPrompt(event.target.value)}
              rows={8}
              placeholder="Define how the main agent should behave..."
            />
          </label>
          <div className="providerActions">
            <button onClick={() => void saveMainAgent()} disabled={agentSaveState === "loading" || !mainAgentSystemPrompt.trim()}>
              {agentSaveState === "loading" ? "Saving..." : "Save main agent"}
            </button>
            <button
              onClick={() => applyMainAgentDraft(agentsData?.agents.find((agent) => agent.id === "main") ?? null)}
              disabled={agentSaveState === "loading"}
            >
              Reset draft
            </button>
          </div>
          <dl className="providerDetails">
            <dt>Agent ID</dt>
            <dd>main</dd>
            <dt>Skills</dt>
            <dd>{agentsData?.agents.find((agent) => agent.id === "main")?.skillIds.length ?? 0} configured (future)</dd>
            <dt>Tools</dt>
            <dd>{agentsData?.agents.find((agent) => agent.id === "main")?.toolIds.length ?? 0} configured (future)</dd>
          </dl>
        </article>

        <article className="settingsCard">
          <div className="cardHeaderRow">
            <h3>Providers</h3>
            {providersData && <span className="muted">default: {providersData.defaultProviderProfileId}</span>}
          </div>
          <div className="registryList providerList">
            {providersData?.providers.map((profile) => {
              const testResult = providerTests[profile.id];
              const isOpenAIChatGPT = profile.id === "openai-chatgpt";
              return (
                <div className="registryItem providerItem" key={profile.id}>
                  <div className="registryItemHeader">
                    <strong>
                      {profile.name}
                      {profile.experimental ? <span className="experimentalBadge">experimental</span> : null}
                    </strong>
                    <span className={`statusBadge ${profile.status.state}`}>{profile.status.state}</span>
                  </div>
                  <dl className="providerDetails">
                    <dt>Vendor</dt>
                    <dd>{profile.vendor}</dd>
                    <dt>Type</dt>
                    <dd>{profile.type}</dd>
                    <dt>Runtime</dt>
                    <dd>{profile.runtime}</dd>
                    <dt>Auth</dt>
                    <dd>{profile.authMode}</dd>
                    <dt>Billing</dt>
                    <dd>{profile.billingSource}</dd>
                    <dt>Source</dt>
                    <dd>{profile.source}</dd>
                    <dt>Enabled</dt>
                    <dd>{profile.enabled ? "yes" : "no"}</dd>
                    <dt>Credential</dt>
                    <dd>
                      {profile.credentialRef ?? "not required"} · {profile.status.credentialStatus}
                    </dd>
                    {profile.model && (
                      <>
                        <dt>Default model</dt>
                        <dd>{profile.model}</dd>
                      </>
                    )}
                    {profile.defaultRunOptions && (
                      <>
                        <dt>Default options</dt>
                        <dd>{formatRunOptions(profile.defaultRunOptions) || "none"}</dd>
                      </>
                    )}
                    {profile.runOptionSupport && (
                      <>
                        <dt>Run options</dt>
                        <dd>{formatRunOptionSupport(profile.runOptionSupport)}</dd>
                      </>
                    )}
                    {profile.baseUrl && (
                      <>
                        <dt>Base URL</dt>
                        <dd className="monospace">{profile.baseUrl}</dd>
                      </>
                    )}
                    {profile.endpoint && (
                      <>
                        <dt>Endpoint</dt>
                        <dd className="monospace">{profile.endpoint}</dd>
                      </>
                    )}
                  </dl>
                  <p className="muted">{profile.status.message}</p>
                  {isOpenAIChatGPT && (
                    <p className="muted">
                      Experimental ChatGPT/Codex OAuth runtime; billing and quota come from the consumer subscription channel.
                    </p>
                  )}
                  <div className="providerActions">
                    <button onClick={() => void testProvider(profile.id)} disabled={testingProviderId === profile.id}>
                      {testingProviderId === profile.id ? "Testing..." : "Test connection"}
                    </button>
                    {isOpenAIChatGPT && (
                      <>
                        <button onClick={() => void startOpenAIChatGPTAuth()} disabled={chatGPTAuthBusy !== null}>
                          {profile.status.state === "connected" ? "Reconnect" : "Connect"}
                        </button>
                        <button
                          onClick={() => void logoutOpenAIChatGPT()}
                          disabled={chatGPTAuthBusy !== null || profile.status.credentialStatus === "missing"}
                        >
                          Disconnect
                        </button>
                      </>
                    )}
                  </div>
                  {isOpenAIChatGPT && chatGPTAuthStart && (
                    <div className="authBox">
                      <strong>Device authorization</strong>
                      <p>{chatGPTAuthStart.instruction}</p>
                      <dl className="providerDetails">
                        <dt>URL</dt>
                        <dd>
                          <a href={chatGPTAuthStart.verificationUrl} target="_blank" rel="noreferrer">
                            {chatGPTAuthStart.verificationUrl}
                          </a>
                        </dd>
                        <dt>Code</dt>
                        <dd className="authCode">{chatGPTAuthStart.userCode}</dd>
                        <dt>Expires</dt>
                        <dd>{new Date(chatGPTAuthStart.expiresAt).toLocaleString()}</dd>
                      </dl>
                      <div className="providerActions">
                        <button onClick={() => void copyOpenAIChatGPTCode()}>{copiedAuthCode ? "Copied" : "Copy code"}</button>
                        <button onClick={() => void pollOpenAIChatGPTAuth()} disabled={chatGPTAuthBusy !== null}>
                          {chatGPTAuthBusy === "poll" ? "Checking..." : "Poll / Complete"}
                        </button>
                      </div>
                      {chatGPTAuthPoll && (
                        <div className={chatGPTAuthPoll.status === "connected" ? "testResult success" : "testResult failure"}>
                          <strong>{chatGPTAuthPoll.status}</strong>
                          <p>{chatGPTAuthPoll.message}</p>
                          {chatGPTAuthPoll.retryAfterMs ? <span>retry after ~{Math.ceil(chatGPTAuthPoll.retryAfterMs / 1000)}s</span> : null}
                        </div>
                      )}
                    </div>
                  )}
                  {testResult && (
                    <div className={testResult.ok ? "testResult success" : "testResult failure"}>
                      <strong>{testResult.ok ? "Connected" : testResult.code ?? "Failed"}</strong>
                      <p>{testResult.message}</p>
                      {typeof testResult.latencyMs === "number" && <span>{testResult.latencyMs}ms</span>}
                    </div>
                  )}
                </div>
              );
            }) ?? <p className="muted">No provider profile data loaded yet.</p>}
          </div>
        </article>

        <article className="settingsCard">
          <h3>Adapter registry</h3>
          <div className="registryList">
            {settingsData?.adapters.map((adapter) => (
              <div className="registryItem" key={adapter.id}>
                <strong>{adapter.name}</strong>
                <span>{adapter.status}</span>
                <p className="muted">{adapter.description}</p>
              </div>
            )) ?? <p className="muted">No adapter registry data loaded yet.</p>}
          </div>
        </article>

        <article className="settingsCard">
          <h3>Stored app settings</h3>
          <label className="settingEditor">
            Instance label
            <input value={instanceLabel} onChange={(event) => setInstanceLabel(event.target.value)} placeholder="Local daemon" />
          </label>
          <button onClick={saveInstanceLabel} disabled={saveState === "loading"}>
            Save label
          </button>
          <pre className="settingsJson">{JSON.stringify(settingsData?.settings ?? {}, null, 2)}</pre>
        </article>
      </div>
    </section>
  );
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
      issues?: Array<{ field?: string; lineNumber?: number; pattern?: string; message?: string }>;
    } | null;
    const issueText = body?.issues?.length
      ? `\n${body.issues
          .map((issue) => {
            const location = issue.lineNumber ? `${issue.field ?? "field"} line ${issue.lineNumber}` : issue.field ?? "field";
            return `${location}: ${issue.message ?? "Invalid value"}${issue.pattern ? ` (${issue.pattern})` : ""}`;
          })
          .join("\n")}`
      : "";
    throw new Error(`${body?.message || body?.error || `${response.status} ${response.statusText}`}${issueText}`);
  }
  return (await response.json()) as T;
}

function toolSettingsJson(settings: ToolSettings): JsonObject {
  const normalizedSettings = validateToolSettings(settings);
  return {
    defaultAction: normalizedSettings.defaultAction,
    denyPatternsText: normalizedSettings.denyPatternsText,
    askPatternsText: normalizedSettings.askPatternsText,
    allowPatternsText: normalizedSettings.allowPatternsText,
    shell: {
      defaultTimeoutMs: normalizedSettings.shell.defaultTimeoutMs ?? defaultShellToolSettings.defaultTimeoutMs,
      maxTimeoutMs: normalizedSettings.shell.maxTimeoutMs ?? defaultShellToolSettings.maxTimeoutMs,
      maxOutputChars: normalizedSettings.shell.maxOutputChars ?? defaultShellToolSettings.maxOutputChars
    }
  };
}

function toolShellSettingValue(settings: ToolSettings, field: keyof ToolSettings["shell"]): string {
  const value = settings.shell[field];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function formatToolSettingsError(error: unknown): string {
  if (error instanceof ToolSettingsValidationError) {
    return error.message;
  }
  return toErrorMessage(error);
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

function formatRunOptions(options: RunOptions | null | undefined): string {
  if (!options) {
    return "";
  }
  const parts = [
    options.model ? `model=${options.model}` : "",
    options.reasoningEffort ? `reasoning=${options.reasoningEffort}` : "",
    options.temperature !== undefined ? `temperature=${options.temperature}` : ""
  ].filter(Boolean);
  return parts.join(", ");
}

function formatUsage(usage: RunUsage | null | undefined): string {
  if (!usage) {
    return "";
  }
  const parts = [
    usage.inputTokens !== undefined ? `input ${usage.inputTokens}` : "",
    usage.outputTokens !== undefined ? `output ${usage.outputTokens}` : "",
    usage.reasoningTokens !== undefined ? `reasoning ${usage.reasoningTokens}` : "",
    usage.totalTokens !== undefined ? `total ${usage.totalTokens}` : ""
  ].filter(Boolean);
  return parts.join(" / ");
}

function formatRunOptionSupport(support: NonNullable<ProviderProfile["runOptionSupport"]>): string {
  return [
    `model ${support.model}`,
    `reasoning ${support.reasoningEffort}`,
    `temperature ${support.temperature}`,
    `usage ${support.usage}`
  ].join(" · ");
}

function shellToolStateFromResponse(response: InvokeToolResponse): ShellToolState {
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

function providerResolutionNotice(resolution: ProviderResolution): string | null {
  if (!resolution.fallback) {
    return null;
  }
  return `Provider fallback: ${resolution.fallback.message}`;
}

function JsonPreview({ value, label }: { value: unknown; label: string }) {
  if (value === undefined || value === null) {
    return null;
  }
  return (
    <details className="jsonPreview">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function partText(part: MessagePart): string {
  return part.text || partString(part, "text");
}

function partString(part: MessagePart, key: string): string {
  const value = part.content[key];
  return typeof value === "string" ? value : "";
}

function partNumber(part: MessagePart, key: string): number | null {
  const value = part.content[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function partBoolean(part: MessagePart, key: string): boolean {
  return part.content[key] === true;
}

function usageFromPart(part: MessagePart): RunUsage | null {
  const value = part.content.usage;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const usage: RunUsage = {};
  const usageRecord = value as Record<string, unknown>;
  if (typeof usageRecord.inputTokens === "number" && Number.isFinite(usageRecord.inputTokens)) {
    usage.inputTokens = usageRecord.inputTokens;
  }
  if (typeof usageRecord.outputTokens === "number" && Number.isFinite(usageRecord.outputTokens)) {
    usage.outputTokens = usageRecord.outputTokens;
  }
  if (typeof usageRecord.reasoningTokens === "number" && Number.isFinite(usageRecord.reasoningTokens)) {
    usage.reasoningTokens = usageRecord.reasoningTokens;
  }
  if (typeof usageRecord.totalTokens === "number" && Number.isFinite(usageRecord.totalTokens)) {
    usage.totalTokens = usageRecord.totalTokens;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function fileRefLabel(part: MessagePart): string {
  const location = partString(part, "path") || partString(part, "uri") || partString(part, "name") || part.text || "unknown";
  const lineStart = partNumber(part, "lineStart");
  const lineEnd = partNumber(part, "lineEnd");
  if (lineStart !== null && lineEnd !== null) {
    return `${location}:${lineStart}-${lineEnd}`;
  }
  if (lineStart !== null) {
    return `${location}:${lineStart}`;
  }
  return location;
}

function compareParts(a: MessagePart, b: MessagePart): number {
  return a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
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

function settingValueAsString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${remainingSeconds}s`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
