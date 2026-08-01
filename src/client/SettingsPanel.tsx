import { useEffect, useState } from "react";
import { defaultShellToolSettings, defaultToolSettings, ToolSettingsValidationError, validateToolSettings } from "../shared/tool-settings";
import type {
  AgentDefinition,
  AgentListResponse,
  AppSettingsResponse,
  DaemonStatus,
  JsonObject,
  OpenAIChatGPTAuthPollResponse,
  OpenAIChatGPTAuthStartResponse,
  OpenAIChatGPTLogoutResponse,
  ProviderListResponse,
  ProviderProfile,
  ProviderTestResponse,
  RunOptions,
  ToolSettings,
  ToolSettingsResponse
} from "../shared/types";
import { requestJson, toErrorMessage } from "./api";

type LoadState = "idle" | "loading" | "error";
type SettingsSection = "providers" | "agent" | "tools" | "system" | "advanced";

const settingsSections: Array<{ id: SettingsSection; label: string; description: string }> = [
  { id: "providers", label: "Providers & Models", description: "Provider profiles, runtime status, authentication, and model defaults." },
  { id: "agent", label: "Agent", description: "Main agent identity, system prompt, and model tool access." },
  { id: "tools", label: "Tools & Permissions", description: "shell.exec policy, approval rules, timeout, and output limits." },
  { id: "system", label: "System", description: "Daemon health and persisted application settings." },
  { id: "advanced", label: "Advanced", description: "Adapter registry and future runtime integration points." }
];

export function SettingsPanel() {
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
  const [activeSection, setActiveSection] = useState<SettingsSection>("providers");

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

  const activeSectionDefinition = settingsSections.find((section) => section.id === activeSection)!;

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

      <div className="settingsWorkspace">
        <SettingsNavigation activeSection={activeSection} onChange={setActiveSection} />
        <section className="settingsSectionContent" aria-labelledby={`settings-${activeSection}-title`}>
          <header className="settingsSectionHeader">
            <span className="eyebrow">Settings area</span>
            <h3 id={`settings-${activeSection}-title`}>{activeSectionDefinition.label}</h3>
            <p className="muted">{activeSectionDefinition.description}</p>
          </header>
          <div className={`settingsSectionCards section-${activeSection}`}>
        {activeSection === "system" && (
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
        )}

        {activeSection === "tools" && (
          <article className="settingsCard toolSettingsCard">
          <div className="cardHeaderRow">
            <h3>Tool Settings</h3>
            <span className="muted">shell.exec policy and shell settings</span>
          </div>
          <p className="muted">
            JavaScript regular expressions only. Empty lines and lines starting with # are ignored. Evaluation order is Deny → Ask → Allow → Default. Use <code>.*</code> to match every command.
          </p>
          <p className="muted">
            shell.exec cwd defaults to the session workingDirectory. Relative cwd values resolve from that directory; absolute cwd values are used as-is and only checked for existence and directory type.
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
        )}

        {activeSection === "agent" && (
          <article className="settingsCard agentSettingsCard">
          <div className="cardHeaderRow">
            <h3>Main Agent</h3>
            {agentsData && <span className="muted">default: {agentsData.defaultAgentId}</span>}
          </div>
          <p className="muted">
            The main agent controls the system prompt and default model tool access injected by the provider-neutral Context Builder before each run.
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
            <dd>{agentToolIds(agentsData?.agents.find((agent) => agent.id === "main") ?? { id: "main", toolIds: [] }).join(", ") || "none"}</dd>
          </dl>
          </article>
        )}

        {activeSection === "providers" && (
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
                      Experimental ChatGPT/Codex OAuth runtime; billing and quota come from the consumer subscription channel. When an agent
                      exposes tools, the adapter sends experimental tool schemas by default; the backend contract may change.
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
        )}

        {activeSection === "advanced" && (
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
        )}

        {activeSection === "system" && (
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
        )}
          </div>
        </section>
      </div>
    </section>
  );
}

function SettingsNavigation({
  activeSection,
  onChange
}: {
  activeSection: SettingsSection;
  onChange: (section: SettingsSection) => void;
}) {
  return (
    <nav className="settingsSectionNav" aria-label="Settings sections">
      {settingsSections.map((section) => (
        <button
          type="button"
          key={section.id}
          className={section.id === activeSection ? "settingsSectionTab active" : "settingsSectionTab"}
          aria-pressed={section.id === activeSection}
          onClick={() => onChange(section.id)}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
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

export function agentToolIds(agent: Pick<AgentDefinition, "id" | "toolIds">): string[] {
  return agent.toolIds.length > 0 ? agent.toolIds : agent.id === "main" ? ["shell.exec"] : [];
}

export function formatRunOptions(options: RunOptions | null | undefined): string {
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

function formatRunOptionSupport(support: NonNullable<ProviderProfile["runOptionSupport"]>): string {
  return [
    `model ${support.model}`,
    `reasoning ${support.reasoningEffort}`,
    `temperature ${support.temperature}`,
    `usage ${support.usage}`
  ].join(" · ");
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
