import { useEffect, useRef, useState } from "react";
import type { AppSettingsResponse, CreateRunResponse, DaemonStatus, Message, RunEvent, Session } from "../shared/types";

type LoadState = "idle" | "loading" | "error";
type Tab = "chat" | "settings";

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [provider, setProvider] = useState("mock");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const eventsRef = useRef<EventSource | null>(null);

  useEffect(() => {
    void loadSessions();
    return () => eventsRef.current?.close();
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      setMessages([]);
      return;
    }
    void loadMessages(selectedSessionId);
  }, [selectedSessionId]);

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
      if (!sessionId) {
        const session = await requestJson<Session>("/api/sessions", { method: "POST" });
        setSessions((current) => [session, ...current]);
        setSelectedSessionId(session.id);
        sessionId = session.id;
      }

      setInput("");
      const response = await requestJson<CreateRunResponse>(`/api/sessions/${sessionId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, provider })
      });
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

    if (event.type === "run_completed" || event.type === "run_cancelled" || event.type === "run_failed") {
      const payload = event.payload as { messageId?: string; error?: string };
      if (payload.messageId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === payload.messageId
              ? {
                  ...message,
                  status:
                    event.type === "run_completed" ? "completed" : event.type === "run_cancelled" ? "cancelled" : "failed"
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

        const [firstPart, ...rest] = message.parts;
        const nextPart = firstPart
          ? { ...firstPart, text: firstPart.text + delta }
          : {
              id: `${messageId}:local-text`,
              messageId,
              seq: 0,
              type: "text" as const,
              text: delta,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };

        return {
          ...message,
          status: "streaming",
          parts: [nextPart, ...rest]
        };
      })
    );
  }

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;

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
          <label>
            Provider
            <select value={provider} onChange={(event) => setProvider(event.target.value)} disabled={Boolean(activeRunId)}>
              <option value="mock">mock</option>
              <option value="openai-compatible">openai-compatible</option>
            </select>
          </label>
        </header>

        {error && <div className="error">{error}</div>}

        <div className="messages">
          {messages.length === 0 && <p className="muted empty">Create a session and send a message.</p>}
          {messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="messageMeta">
                <strong>{message.role}</strong>
                <span>{message.status}</span>
              </div>
              <pre>{messageText(message)}</pre>
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

function SettingsPanel() {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [settingsData, setSettingsData] = useState<AppSettingsResponse | null>(null);
  const [instanceLabel, setInstanceLabel] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [saveState, setSaveState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadDashboardSettings();
  }, []);

  async function loadDashboardSettings() {
    setLoadState("loading");
    setError(null);
    try {
      const [nextStatus, nextSettings] = await Promise.all([
        requestJson<DaemonStatus>("/api/status"),
        requestJson<AppSettingsResponse>("/api/settings")
      ]);
      setStatus(nextStatus);
      setSettingsData(nextSettings);
      setInstanceLabel(settingValueAsString(nextSettings.settings.instanceLabel));
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

  return (
    <section className="settingsPane">
      <header className="settingsHeader">
        <div>
          <h2>Settings</h2>
          <p className="muted">Daemon status, provider profile placeholders, and adapter registry foundation.</p>
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

        <article className="settingsCard">
          <h3>Provider profiles</h3>
          <div className="registryList">
            {settingsData?.providerProfiles.map((profile) => (
              <div className="registryItem" key={profile.id}>
                <strong>{profile.name}</strong>
                <span>{profile.status}</span>
                <p className="muted">
                  {profile.type} · {profile.source}
                  {profile.model ? ` · ${profile.model}` : ""}
                </p>
                {profile.baseUrl && <code>{profile.baseUrl}</code>}
              </div>
            )) ?? <p className="muted">No provider profile data loaded yet.</p>}
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
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function messageText(message: Message): string {
  return message.parts.map((part) => part.text).join("");
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
