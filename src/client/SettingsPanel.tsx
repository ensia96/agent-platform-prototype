import { useEffect, useRef, useState } from "react";
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
  ProviderModelCatalog,
  ProviderProfile,
  ProviderTestResponse,
  RunOptions,
  ToolDefinition,
  ToolListResponse,
  ToolSettings,
  ToolSettingsResponse
} from "../shared/types";
import { ApiRequestError, requestJson, toErrorMessage } from "./api";
import { catalogSelectionWarnings } from "./model-catalog";

type LoadState = "idle" | "loading" | "error";
type SettingsSection = "providers" | "agent" | "tools" | "system" | "advanced";

export interface AgentProfileDraft {
  name: string;
  description: string;
  systemPrompt: string;
  modelProfileId: string;
  model: string;
  reasoningEffort: string;
  temperature: string;
  toolIds: string[];
}

export interface SettingsEditorState {
  dirty: boolean;
  busy: boolean;
}

const settingsSections: Array<{ id: SettingsSection; label: string; description: string }> = [
  { id: "providers", label: "Providers & Models", description: "Provider profiles, runtime status, authentication, and model defaults." },
  { id: "agent", label: "Agent Profiles", description: "Reusable agent defaults, prompts, providers, models, and model-tool access." },
  { id: "tools", label: "Tools & Permissions", description: "shell.exec policy, approval rules, timeout, and output limits." },
  { id: "system", label: "System", description: "Daemon health and persisted application settings." },
  { id: "advanced", label: "Advanced", description: "Adapter registry and future runtime integration points." }
];

export function SettingsPanel({
  onAgentsChanged,
  onEditorStateChange
}: {
  onAgentsChanged?: (agents: AgentDefinition[]) => void;
  onEditorStateChange?: (state: SettingsEditorState) => void;
}) {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [settingsData, setSettingsData] = useState<AppSettingsResponse | null>(null);
  const [providersData, setProvidersData] = useState<ProviderListResponse | null>(null);
  const [agentsData, setAgentsData] = useState<AgentListResponse | null>(null);
  const [availableTools, setAvailableTools] = useState<ToolDefinition[]>([]);
  const [providerTests, setProviderTests] = useState<Record<string, ProviderTestResponse>>({});
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [providerModelCatalogs, setProviderModelCatalogs] = useState<Record<string, ProviderModelCatalog>>({});
  const [providerModelCatalogStates, setProviderModelCatalogStates] = useState<Record<string, LoadState>>({});
  const [providerModelCatalogErrors, setProviderModelCatalogErrors] = useState<Record<string, string>>({});
  const providerModelCatalogAbortControllers = useRef(new Map<string, AbortController>());
  const providerModelCatalogRequestIds = useRef(new Map<string, number>());
  const [chatGPTAuthStart, setChatGPTAuthStart] = useState<OpenAIChatGPTAuthStartResponse | null>(null);
  const [chatGPTAuthPoll, setChatGPTAuthPoll] = useState<OpenAIChatGPTAuthPollResponse | null>(null);
  const [chatGPTAuthBusy, setChatGPTAuthBusy] = useState<"start" | "poll" | "logout" | null>(null);
  const [copiedAuthCode, setCopiedAuthCode] = useState(false);
  const [instanceLabel, setInstanceLabel] = useState("");
  const [toolSettings, setToolSettings] = useState<ToolSettings>(defaultToolSettings);
  const [toolSettingsSaveState, setToolSettingsSaveState] = useState<LoadState>("idle");
  const [toolSettingsError, setToolSettingsError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("main");
  const [agentDraft, setAgentDraft] = useState<AgentProfileDraft>(emptyAgentDraft());
  const [agentDraftBase, setAgentDraftBase] = useState<AgentDefinition | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [saveState, setSaveState] = useState<LoadState>("idle");
  const [agentSaveState, setAgentSaveState] = useState<LoadState>("idle");
  const [agentError, setAgentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>("providers");
  const dashboardLoadRequestIdRef = useRef(0);
  const agentMutationRequestIdRef = useRef(0);
  const agentDraftDirtyRef = useRef(false);

  useEffect(() => {
    void loadDashboardSettings();
    return () => {
      dashboardLoadRequestIdRef.current += 1;
      agentMutationRequestIdRef.current += 1;
      for (const controller of providerModelCatalogAbortControllers.current.values()) {
        controller.abort();
      }
    };
  }, []);

  async function loadDashboardSettings(options: { preserveAgentDraft?: boolean } = {}) {
    const requestId = dashboardLoadRequestIdRef.current + 1;
    dashboardLoadRequestIdRef.current = requestId;
    setLoadState("loading");
    setError(null);
    try {
      const [nextStatus, nextSettings, nextToolSettings, nextProviders, nextAgents, nextTools] = await Promise.all([
        requestJson<DaemonStatus>("/api/status"),
        requestJson<AppSettingsResponse>("/api/settings"),
        requestJson<ToolSettingsResponse>("/api/tool-settings"),
        requestJson<ProviderListResponse>("/api/providers"),
        requestJson<AgentListResponse>("/api/agents"),
        requestJson<ToolListResponse>("/api/tools")
      ]);
      if (requestId !== dashboardLoadRequestIdRef.current) {
        return;
      }
      setStatus(nextStatus);
      setSettingsData(nextSettings);
      setToolSettings(nextToolSettings.settings);
      setToolSettingsError(null);
      setProvidersData(nextProviders);
      setAgentsData(nextAgents);
      setAvailableTools(nextTools.tools);
      onAgentsChanged?.(nextAgents.agents);
      setInstanceLabel(settingValueAsString(nextSettings.settings.instanceLabel));
      if (!options.preserveAgentDraft) {
        applyAgentDraft(nextAgents.agents.find((agent) => agent.id === nextAgents.defaultAgentId) ?? nextAgents.agents[0] ?? null);
      }
      setLoadState("idle");
    } catch (requestError) {
      if (requestId !== dashboardLoadRequestIdRef.current) {
        return;
      }
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

  function applyAgentDraft(agent: AgentDefinition | null) {
    setSelectedAgentId(agent?.id ?? "");
    setAgentDraftBase(agent);
    setAgentDraft(agent ? agentDraftFromDefinition(agent) : emptyAgentDraft());
    setAgentError(null);
    setAgentSaveState("idle");
  }

  function updateAgentDraft(patch: Partial<AgentProfileDraft>) {
    setAgentDraft((current) => ({ ...current, ...patch }));
    setAgentError(null);
    setAgentSaveState((current) => (current === "loading" ? current : "idle"));
  }

  function publishAgents(agents: AgentDefinition[], selectedId: string) {
    setAgentsData({ agents, defaultAgentId: "main" });
    onAgentsChanged?.(agents);
    applyAgentDraft(agents.find((agent) => agent.id === selectedId) ?? agents[0] ?? null);
  }

  function confirmDiscardAgentDraft(action: string): boolean {
    if (!agentDraftDirty) {
      return true;
    }
    return window.confirm(`Discard unsaved changes to '${agentDraftBase?.name ?? "this profile"}' and ${action}?`);
  }

  function selectAgentProfile(agent: AgentDefinition) {
    if (!agentMutationBusy && confirmDiscardAgentDraft("switch profiles")) {
      applyAgentDraft(agent);
    }
  }

  function refreshDashboardSettings() {
    if (!agentMutationBusy && confirmDiscardAgentDraft("refresh Settings")) {
      void loadDashboardSettings();
    }
  }

  function beginAgentMutation(): number | null {
    if (agentMutationBusy) {
      return null;
    }
    const requestId = agentMutationRequestIdRef.current + 1;
    agentMutationRequestIdRef.current = requestId;
    setAgentSaveState("loading");
    setAgentError(null);
    return requestId;
  }

  function isCurrentAgentMutation(requestId: number): boolean {
    return isCurrentAgentProfileMutation(requestId, agentMutationRequestIdRef.current);
  }

  async function createAgentProfile() {
    if (!confirmDiscardAgentDraft("create a profile")) {
      return;
    }
    const requestId = beginAgentMutation();
    if (requestId === null) {
      return;
    }
    try {
      const existingNames = new Set((agentsData?.agents ?? []).map((agent) => agent.name.toLocaleLowerCase()));
      let name = "New Agent";
      for (let suffix = 2; existingNames.has(name.toLocaleLowerCase()); suffix += 1) {
        name = `New Agent ${suffix}`;
      }
      const agent = await requestJson<AgentDefinition>("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          systemPrompt: "You are a helpful local assistant.",
          toolIds: [],
          skillIds: []
        })
      });
      if (!isCurrentAgentMutation(requestId)) {
        return;
      }
      publishAgents([...(agentsData?.agents ?? []), agent].sort(compareAgentProfiles), agent.id);
    } catch (requestError) {
      if (!isCurrentAgentMutation(requestId)) {
        return;
      }
      setAgentSaveState("error");
      setAgentError(formatAgentProfileError(requestError));
    }
  }

  async function cloneAgentProfile() {
    if (!selectedAgentId || !agentDraftBase || !confirmDiscardAgentDraft("clone the saved profile")) {
      return;
    }
    const requestId = beginAgentMutation();
    if (requestId === null) {
      return;
    }
    try {
      const agent = await requestJson<AgentDefinition>(`/api/agents/${encodeURIComponent(selectedAgentId)}/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: agentDraftBase.revision })
      });
      if (!isCurrentAgentMutation(requestId)) {
        return;
      }
      publishAgents([...(agentsData?.agents ?? []), agent].sort(compareAgentProfiles), agent.id);
    } catch (requestError) {
      if (!isCurrentAgentMutation(requestId)) {
        return;
      }
      setAgentSaveState("error");
      setAgentError(formatAgentProfileError(requestError));
    }
  }

  async function saveAgentProfile() {
    if (!selectedAgentId || !agentDraftBase) {
      return;
    }
    const requestId = beginAgentMutation();
    if (requestId === null) {
      return;
    }
    setError(null);
    try {
      const agent = await requestJson<AgentDefinition>(`/api/agents/${encodeURIComponent(selectedAgentId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: agentDraftBase.revision,
          name: agentDraft.name,
          description: agentDraft.description || null,
          systemPrompt: agentDraft.systemPrompt,
          modelProfileId: agentDraft.modelProfileId || null,
          defaultRunOptions: runOptionsFromAgentDraft(agentDraft),
          toolIds: agentDraft.toolIds
        })
      });
      if (!isCurrentAgentMutation(requestId)) {
        return;
      }
      publishAgents(
        (agentsData?.agents ?? []).map((item) => (item.id === agent.id ? agent : item)).sort(compareAgentProfiles),
        agent.id
      );
    } catch (requestError) {
      if (!isCurrentAgentMutation(requestId)) {
        return;
      }
      setAgentSaveState("error");
      setAgentError(formatAgentProfileError(requestError));
    }
  }

  async function deleteAgentProfile() {
    if (!selectedAgentId || selectedAgentId === "main" || !agentDraftBase || !confirmDiscardAgentDraft("delete this profile")) {
      return;
    }
    const requestId = beginAgentMutation();
    if (requestId === null) {
      return;
    }
    try {
      await requestJson<void>(`/api/agents/${encodeURIComponent(selectedAgentId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: agentDraftBase.revision })
      });
      if (!isCurrentAgentMutation(requestId)) {
        return;
      }
      const agents = (agentsData?.agents ?? []).filter((agent) => agent.id !== selectedAgentId);
      publishAgents(agents, "main");
    } catch (requestError) {
      if (!isCurrentAgentMutation(requestId)) {
        return;
      }
      setAgentSaveState("error");
      setAgentError(formatAgentProfileError(requestError));
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

  async function loadProviderModels(profileId: string, refresh: boolean) {
    providerModelCatalogAbortControllers.current.get(profileId)?.abort();
    const controller = new AbortController();
    providerModelCatalogAbortControllers.current.set(profileId, controller);
    const requestId = (providerModelCatalogRequestIds.current.get(profileId) ?? 0) + 1;
    providerModelCatalogRequestIds.current.set(profileId, requestId);
    setProviderModelCatalogStates((current) => ({ ...current, [profileId]: "loading" }));
    setProviderModelCatalogErrors((current) => omitRecordKey(current, profileId));
    try {
      const query = refresh ? "?refresh=1" : "";
      const catalog = await requestJson<ProviderModelCatalog>(`/api/providers/${encodeURIComponent(profileId)}/models${query}`, {
        signal: controller.signal
      });
      if (controller.signal.aborted || providerModelCatalogRequestIds.current.get(profileId) !== requestId) {
        return;
      }
      setProviderModelCatalogs((current) => ({ ...current, [profileId]: catalog }));
      setProviderModelCatalogStates((current) => ({ ...current, [profileId]: "idle" }));
    } catch (requestError) {
      if (controller.signal.aborted || providerModelCatalogRequestIds.current.get(profileId) !== requestId) {
        return;
      }
      setProviderModelCatalogStates((current) => ({ ...current, [profileId]: "error" }));
      setProviderModelCatalogErrors((current) => ({ ...current, [profileId]: toErrorMessage(requestError) }));
    } finally {
      if (providerModelCatalogAbortControllers.current.get(profileId) === controller) {
        providerModelCatalogAbortControllers.current.delete(profileId);
      }
    }
  }

  function clearProviderModelCatalog(profileId: string) {
    providerModelCatalogAbortControllers.current.get(profileId)?.abort();
    providerModelCatalogAbortControllers.current.delete(profileId);
    providerModelCatalogRequestIds.current.set(profileId, (providerModelCatalogRequestIds.current.get(profileId) ?? 0) + 1);
    setProviderModelCatalogs((current) => omitRecordKey(current, profileId));
    setProviderModelCatalogStates((current) => omitRecordKey(current, profileId));
    setProviderModelCatalogErrors((current) => omitRecordKey(current, profileId));
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
        clearProviderModelCatalog("openai-chatgpt");
        setChatGPTAuthStart(null);
        await loadDashboardSettings({ preserveAgentDraft: agentDraftDirtyRef.current });
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
      clearProviderModelCatalog("openai-chatgpt");
      await loadDashboardSettings({ preserveAgentDraft: agentDraftDirtyRef.current });
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
  const agentMutationBusy = agentSaveState === "loading";
  const agentDraftDirty = isAgentProfileDraftDirty(agentDraftBase, agentDraft);
  agentDraftDirtyRef.current = agentDraftDirty;
  const agentProviderProfileId = agentDraft.modelProfileId || providersData?.defaultProviderProfileId || "";
  const agentProvider = providersData?.providers.find((provider) => provider.id === agentProviderProfileId) ?? null;
  const agentCatalog = agentProviderProfileId ? providerModelCatalogs[agentProviderProfileId] ?? null : null;
  const agentCatalogState = agentProviderProfileId ? providerModelCatalogStates[agentProviderProfileId] ?? "idle" : "idle";
  const agentCatalogError = agentProviderProfileId ? providerModelCatalogErrors[agentProviderProfileId] ?? null : null;
  const agentEffectiveModelId =
    agentDraft.model || agentProvider?.defaultRunOptions?.model || agentProvider?.model || "";
  const selectedAgentCatalogModel = agentCatalog?.models.find((model) => model.id === agentEffectiveModelId) ?? null;
  const agentReasoningEfforts =
    selectedAgentCatalogModel?.reasoning.support === "supported" ? selectedAgentCatalogModel.reasoning.efforts : [];
  const agentTemperatureUnsupported = agentProvider?.runOptionSupport?.temperature === "unsupported";
  const agentCatalogWarnings = catalogSelectionWarnings(
    agentCatalog,
    agentEffectiveModelId,
    agentDraft.model,
    agentDraft.reasoningEffort
  );

  useEffect(() => {
    onEditorStateChange?.({ dirty: agentDraftDirty, busy: agentMutationBusy });
  }, [agentDraftDirty, agentMutationBusy, onEditorStateChange]);

  return (
    <section className="settingsPane">
      <header className="settingsHeader">
        <div>
          <h2>Settings</h2>
          <p className="muted">Daemon status, provider profiles, and adapter registry foundation.</p>
        </div>
        <button onClick={refreshDashboardSettings} disabled={loadState === "loading" || agentMutationBusy}>
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
              <div>
                <h3>Agent Profiles</h3>
                <p className="muted">Profiles are bound to sessions; each run stores an immutable internal snapshot.</p>
              </div>
              <div className="providerActions">
                <button type="button" onClick={() => void createAgentProfile()} disabled={agentMutationBusy}>Create</button>
                <button type="button" onClick={() => void cloneAgentProfile()} disabled={!agentDraftBase || agentMutationBusy}>Clone</button>
              </div>
            </div>

            <div className="agentProfileWorkspace">
              <div className="registryList agentProfileList" aria-label="Agent profiles">
                {agentsData?.agents.map((agent) => (
                  <button
                    type="button"
                    key={agent.id}
                    className={agent.id === selectedAgentId ? "registryItem active" : "registryItem"}
                    aria-pressed={agent.id === selectedAgentId}
                    onClick={() => selectAgentProfile(agent)}
                    disabled={agentMutationBusy || loadState === "loading"}
                  >
                    <strong>{agent.name}</strong>
                    <span className="muted">{agent.id === "main" ? "main · protected" : agent.id}</span>
                  </button>
                ))}
              </div>

              {agentDraftBase ? (
                <fieldset className="agentProfileEditor" disabled={agentMutationBusy || loadState === "loading"}>
                  <div className="inspectorFormRow">
                    <label className="settingEditor">
                      Name
                      <input value={agentDraft.name} onChange={(event) => updateAgentDraft({ name: event.target.value })} maxLength={120} />
                    </label>
                    <label className="settingEditor">
                      Description
                      <input value={agentDraft.description} onChange={(event) => updateAgentDraft({ description: event.target.value })} maxLength={1000} />
                    </label>
                  </div>
                  <label className="settingEditor">
                    System prompt
                    <textarea
                      className="agentPromptEditor"
                      value={agentDraft.systemPrompt}
                      onChange={(event) => updateAgentDraft({ systemPrompt: event.target.value })}
                      rows={8}
                      maxLength={20_000}
                    />
                  </label>
                  <label className="settingEditor">
                    Provider profile
                    <select
                      value={agentDraft.modelProfileId}
                      onChange={(event) => {
                        const modelProfileId = event.target.value;
                        const provider = providersData?.providers.find((item) => item.id === modelProfileId);
                        updateAgentDraft({
                          modelProfileId,
                          model: "",
                          reasoningEffort: "",
                          ...(provider?.runOptionSupport?.temperature === "unsupported" ? { temperature: "" } : {})
                        });
                      }}
                    >
                      <option value="">application provider default</option>
                      {agentDraft.modelProfileId && !agentProvider && (
                        <option value={agentDraft.modelProfileId}>{agentDraft.modelProfileId} (saved, unavailable)</option>
                      )}
                      {providersData?.providers.map((provider) => (
                        <option key={provider.id} value={provider.id}>{provider.name} ({provider.id})</option>
                      ))}
                    </select>
                  </label>

                  <div className="settingEditor">
                    <span>Default model</span>
                    {agentCatalog && !agentCatalog.customModelAllowed ? (
                      <select value={agentDraft.model} onChange={(event) => updateAgentDraft({ model: event.target.value, reasoningEffort: "" })}>
                        <option value="">provider default</option>
                        {agentDraft.model && !agentCatalog.models.some((model) => model.id === agentDraft.model) && (
                          <option value={agentDraft.model}>{agentDraft.model} (saved, unavailable)</option>
                        )}
                        {agentCatalog.models.map((model) => <option key={model.id} value={model.id}>{model.displayName ?? model.id}</option>)}
                      </select>
                    ) : (
                      <>
                        <input
                          value={agentDraft.model}
                          onChange={(event) => updateAgentDraft({ model: event.target.value, reasoningEffort: "" })}
                          placeholder={agentProvider?.model ?? "provider default or exact custom model ID"}
                          list="agent-profile-model-catalog"
                        />
                        <datalist id="agent-profile-model-catalog">
                          {agentCatalog?.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
                        </datalist>
                      </>
                    )}
                    <div className="providerActions">
                      <button
                        type="button"
                        onClick={() => void loadProviderModels(agentProviderProfileId, false)}
                        disabled={!agentProviderProfileId || agentCatalogState === "loading"}
                      >
                        {agentCatalogState === "loading" ? "Loading models..." : agentCatalog ? "Reload models" : "Load models"}
                      </button>
                    </div>
                    {agentCatalogError && <span className="inlineError">{agentCatalogError}</span>}
                    {agentCatalog?.warning && <span className="muted">{agentCatalog.warning}</span>}
                    {agentCatalogWarnings.map((warning) => <span className="inlineWarning" key={warning}>{warning}</span>)}
                  </div>

                  <div className="inspectorFormRow">
                    <label className="settingEditor">
                      Default reasoning effort
                      <select
                        value={agentDraft.reasoningEffort}
                        onChange={(event) => updateAgentDraft({ reasoningEffort: event.target.value })}
                        disabled={agentReasoningEfforts.length === 0 && !agentDraft.reasoningEffort}
                      >
                        <option value="">provider default</option>
                        {agentDraft.reasoningEffort && !agentReasoningEfforts.some((item) => item.value === agentDraft.reasoningEffort) && (
                          <option value={agentDraft.reasoningEffort}>{agentDraft.reasoningEffort} (saved)</option>
                        )}
                        {agentReasoningEfforts.map((effort) => <option key={effort.value} value={effort.value}>{effort.value}</option>)}
                      </select>
                    </label>
                    <label className="settingEditor">
                      Default temperature
                      <input
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        value={agentDraft.temperature}
                        onChange={(event) => updateAgentDraft({ temperature: event.target.value })}
                        placeholder="provider default"
                        disabled={agentTemperatureUnsupported && !agentDraft.temperature}
                      />
                      {agentTemperatureUnsupported && <span className="muted">Unsupported by this provider; existing values are metadata-only.</span>}
                    </label>
                  </div>

                  <fieldset className="settingEditor agentToolAllowlist">
                    <legend>Model tool allowlist</legend>
                    {availableTools.map((tool) => (
                      <label key={tool.id}>
                        <input
                          type="checkbox"
                          checked={agentDraft.toolIds.includes(tool.id)}
                          onChange={(event) =>
                            updateAgentDraft({
                              toolIds: event.target.checked
                                ? [...agentDraft.toolIds, tool.id]
                                : agentDraft.toolIds.filter((id) => id !== tool.id)
                            })
                          }
                        />
                        {tool.name} <span className="muted">({tool.id})</span>
                      </label>
                    ))}
                    <p className="muted">This is a hard model-tool allowlist. Global Tool Settings still decide allow/ask/deny.</p>
                  </fieldset>

                  <p className="muted">
                    Skill IDs are stored only as a future placeholder and are not loaded or executed in this MVP.
                    {agentDraftBase.skillIds.length > 0 ? ` Stored: ${agentDraftBase.skillIds.join(", ")}` : ""}
                  </p>
                  <dl className="providerDetails">
                    <dt>ID</dt><dd className="monospace">{agentDraftBase.id}</dd>
                    <dt>Revision</dt><dd>{agentDraftBase.revision}</dd>
                    <dt>Tools</dt><dd>{agentDraft.toolIds.join(", ") || "none"}</dd>
                  </dl>
                  {agentDraftDirty && <div className="inlineWarning">Unsaved Agent Profile changes.</div>}
                  {agentError && <div className="inlineError">{agentError}</div>}
                  <div className="providerActions">
                    <button
                      type="button"
                      onClick={() => void saveAgentProfile()}
                      disabled={agentMutationBusy || !agentDraftDirty || !agentDraft.name.trim() || !agentDraft.systemPrompt.trim()}
                    >
                      {agentSaveState === "loading" ? "Saving..." : "Save profile"}
                    </button>
                    <button type="button" onClick={() => applyAgentDraft(agentDraftBase)} disabled={agentMutationBusy || !agentDraftDirty}>Discard changes</button>
                    <button
                      type="button"
                      className="dangerButton"
                      onClick={() => void deleteAgentProfile()}
                      disabled={agentDraftBase.id === "main" || agentMutationBusy}
                    >
                      {agentDraftBase.id === "main" ? "Main protected" : "Delete profile"}
                    </button>
                  </div>
                </fieldset>
              ) : (
                <p className="muted">Create or select an agent profile.</p>
              )}
            </div>
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
              const modelCatalog = providerModelCatalogs[profile.id];
              const modelCatalogState = providerModelCatalogStates[profile.id] ?? "idle";
              const modelCatalogError = providerModelCatalogErrors[profile.id];
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
                    <button
                      onClick={() => void loadProviderModels(profile.id, Boolean(modelCatalog))}
                      disabled={modelCatalogState === "loading"}
                    >
                      {modelCatalogState === "loading" ? "Loading models..." : modelCatalog ? "Refresh models" : "Load models"}
                    </button>
                  </div>
                  {modelCatalogError && (
                    <div className="testResult failure">
                      <strong>Model catalog unavailable</strong>
                      <p>{modelCatalogError}</p>
                    </div>
                  )}
                  {modelCatalog && <ProviderModelCatalogPanel catalog={modelCatalog} />}
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

function ProviderModelCatalogPanel({ catalog }: { catalog: ProviderModelCatalog }) {
  return (
    <div className="modelCatalogPanel">
      <dl className="providerDetails">
        <dt>Catalog status</dt>
        <dd>{catalog.status}{catalog.stale ? " · stale" : ""}</dd>
        <dt>Catalog source</dt>
        <dd>{catalog.source}</dd>
        <dt>Fetched</dt>
        <dd>{formatTimestamp(catalog.fetchedAt)}</dd>
        <dt>Custom model ID</dt>
        <dd>{catalog.customModelAllowed ? "allowed" : "catalog choices only"}</dd>
      </dl>
      {catalog.warning && <p className="muted">{catalog.warning}</p>}
      <details open={catalog.models.length <= 12}>
        <summary>{catalog.models.length} exact model ID{catalog.models.length === 1 ? "" : "s"}</summary>
        {catalog.models.length > 0 ? (
          <ul className="modelCatalogList">
            {catalog.models.map((model) => (
              <li key={model.id}>
                <code>{model.id}</code>
                {model.displayName && model.displayName !== model.id && <span>{model.displayName}</span>}
                {model.description && <span className="muted">{model.description}</span>}
                <span className="muted">{formatCatalogReasoning(model.reasoning)}</span>
                {model.owner && <span className="muted">owner: {model.owner}</span>}
                {model.created !== undefined && <span className="muted">created: {formatUnixTimestamp(model.created)}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No models were advertised.</p>
        )}
      </details>
    </div>
  );
}

function formatCatalogReasoning(reasoning: ProviderModelCatalog["models"][number]["reasoning"]): string {
  if (reasoning.support !== "supported") {
    return `reasoning: ${reasoning.support}`;
  }
  const efforts = reasoning.efforts.map((effort) => effort.value).join(", ") || "no advertised efforts";
  return `reasoning: ${efforts}${reasoning.defaultEffort ? ` · default ${reasoning.defaultEffort}` : ""}`;
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

function formatUnixTimestamp(value: number): string {
  const timestamp = new Date(value * 1000);
  return Number.isNaN(timestamp.getTime()) ? String(value) : timestamp.toLocaleString();
}

function omitRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const remaining = { ...record };
  delete remaining[key];
  return remaining;
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
  return [...agent.toolIds];
}

function emptyAgentDraft(): AgentProfileDraft {
  return {
    name: "",
    description: "",
    systemPrompt: "",
    modelProfileId: "",
    model: "",
    reasoningEffort: "",
    temperature: "",
    toolIds: []
  };
}

function agentDraftFromDefinition(agent: AgentDefinition): AgentProfileDraft {
  return {
    name: agent.name,
    description: agent.description ?? "",
    systemPrompt: agent.systemPrompt,
    modelProfileId: agent.modelProfileId ?? "",
    model: agent.defaultRunOptions?.model ?? "",
    reasoningEffort: agent.defaultRunOptions?.reasoningEffort ?? "",
    temperature: agent.defaultRunOptions?.temperature === undefined ? "" : String(agent.defaultRunOptions.temperature),
    toolIds: [...agent.toolIds]
  };
}

export function isAgentProfileDraftDirty(agent: AgentDefinition | null, draft: AgentProfileDraft): boolean {
  if (!agent) {
    return false;
  }
  const loaded = agentDraftFromDefinition(agent);
  return (
    draft.name !== loaded.name ||
    draft.description !== loaded.description ||
    draft.systemPrompt !== loaded.systemPrompt ||
    draft.modelProfileId !== loaded.modelProfileId ||
    draft.model !== loaded.model ||
    draft.reasoningEffort !== loaded.reasoningEffort ||
    draft.temperature !== loaded.temperature ||
    draft.toolIds.length !== loaded.toolIds.length ||
    draft.toolIds.some((toolId, index) => toolId !== loaded.toolIds[index])
  );
}

export function isCurrentAgentProfileMutation(requestId: number, currentRequestId: number): boolean {
  return requestId === currentRequestId;
}

function runOptionsFromAgentDraft(draft: AgentProfileDraft): RunOptions | null {
  const options: RunOptions = {};
  if (draft.model.trim()) {
    options.model = draft.model.trim();
  }
  if (draft.reasoningEffort.trim()) {
    options.reasoningEffort = draft.reasoningEffort.trim();
  }
  if (draft.temperature.trim()) {
    options.temperature = Number(draft.temperature);
  }
  return Object.keys(options).length > 0 ? options : null;
}

function compareAgentProfiles(left: AgentDefinition, right: AgentDefinition): number {
  if (left.id === "main") {
    return -1;
  }
  if (right.id === "main") {
    return 1;
  }
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function formatAgentProfileError(error: unknown): string {
  if (!(error instanceof ApiRequestError)) {
    return toErrorMessage(error);
  }
  if (error.code === "agent_revision_conflict") {
    const latest = error.body?.latest;
    const revision =
      latest && typeof latest === "object" && !Array.isArray(latest)
        ? (latest as Record<string, unknown>).revision
        : null;
    return `${error.message}${typeof revision === "number" ? ` Latest revision: ${revision}.` : ""} Your draft was preserved; review and retry from refreshed data.`;
  }
  if (error.code !== "agent_in_use") {
    return error.message;
  }
  const usage = error.body?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return error.message;
  }
  const sessions = (usage as Record<string, unknown>).sessions;
  if (!Array.isArray(sessions)) {
    return error.message;
  }
  const labels = sessions.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    const session = value as Record<string, unknown>;
    const id = typeof session.id === "string" ? session.id : "";
    const title = typeof session.title === "string" ? session.title : "";
    return id ? [`${title || "Untitled session"} (${id})`] : [];
  });
  return labels.length > 0 ? `${error.message} Sessions: ${labels.join(", ")}` : error.message;
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
