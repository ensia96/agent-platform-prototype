import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type {
  AgentDefinition,
  AgentListResponse,
  ContextPreviewResponse,
  CreateRunResponse,
  InvokeToolResponse,
  Message,
  PermissionListResponse,
  PermissionRequest,
  PublicProviderResolution,
  PublicRunSummary,
  ProviderListResponse,
  ProviderModelCatalog,
  ProviderProfile,
  ReasoningEffort,
  RunEvent,
  RunOptions,
  RunUsage,
  Session,
  ToolDefinition,
  ToolListResponse
} from "../shared/types";
import { isActiveRunStatus, isTerminalRunStatus } from "../shared/types";
import { ApiRequestError, requestJson, toErrorMessage } from "./api";
import { ChatHeader } from "./ChatHeader";
import { MessageBody } from "./MessageBody";
import {
  profileDefaultsApplyToProvider,
  reconcileModelOverride,
  reconcileReasoningEffort,
  type ModelCatalogLoadState
} from "./model-catalog";
import { RunInspector } from "./RunInspector";
import { RunActionButton } from "./RunActionButton";
import {
  applyRunEventToMessages,
  isCurrentSessionOperation as isCurrentSessionOperationRequest,
  isCurrentSessionRequest,
  isCurrentTrackedRunRequest,
  isMatchingPermissionResponse,
  mergeSnapshotWithTrackedRun,
  prepareMessagesForRunReplay,
  runDisplayStatus,
  selectRecoveredRun,
  shouldApplyRunEvent,
  terminalNoticeFromEvent,
  terminalNoticeFromMessages,
  updateRunFromEvent,
  type RunConnectionState,
  type RunTerminalNotice
} from "./run-recovery";
import { SettingsPanel, type SettingsEditorState } from "./SettingsPanel";
import { shellToolStateFromResponse, type ShellToolState } from "./ToolPanels";
import { mergeSessionMutation } from "./session-mutations";

type LoadState = "idle" | "loading" | "error";
type Tab = "chat" | "settings";
type SaveState = "idle" | "saving" | "saved";
const INSPECTOR_OVERLAY_QUERY = "(max-width: 1180px)";
const MESSAGE_BOTTOM_THRESHOLD_PX = 96;
const COMPOSER_SEND_ON_ENTER_STORAGE_KEY = "agent-platform.composer.sendOnEnter.v1";

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sendOnEnter, setSendOnEnter] = useState(readSendOnEnterPreference);
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [defaultProviderProfileId, setDefaultProviderProfileId] = useState("");
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [providerProfileId, setProviderProfileId] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">("");
  const [temperature, setTemperature] = useState("");
  const [modelCatalog, setModelCatalog] = useState<ProviderModelCatalog | null>(null);
  const [modelCatalogState, setModelCatalogState] = useState<ModelCatalogLoadState>("idle");
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [lastProviderResolution, setLastProviderResolution] = useState<PublicProviderResolution | null>(null);
  const [lastRunOptions, setLastRunOptions] = useState<RunOptions | null>(null);
  const [lastRunUsage, setLastRunUsage] = useState<RunUsage | null>(null);
  const [lastUnsupportedRunOptions, setLastUnsupportedRunOptions] = useState<string[]>([]);
  const [providerNotice, setProviderNotice] = useState<string | null>(null);
  const [contextPreview, setContextPreview] = useState<ContextPreviewResponse | null>(null);
  const [contextPreviewState, setContextPreviewState] = useState<LoadState>("idle");
  const [workingDirectoryDraft, setWorkingDirectoryDraft] = useState("");
  const [workingDirectorySaveState, setWorkingDirectorySaveState] = useState<SaveState>("idle");
  const [workingDirectoryError, setWorkingDirectoryError] = useState<string | null>(null);
  const [sessionAgentSaveState, setSessionAgentSaveState] = useState<SaveState>("idle");
  const [sessionAgentError, setSessionAgentError] = useState<string | null>(null);
  const [shellCommand, setShellCommand] = useState("");
  const [shellCwd, setShellCwd] = useState("");
  const [shellTimeoutMs, setShellTimeoutMs] = useState("");
  const [shellToolState, setShellToolState] = useState<ShellToolState>("idle");
  const [lastShellResponse, setLastShellResponse] = useState<InvokeToolResponse | null>(null);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [permissionActionId, setPermissionActionId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<PublicRunSummary | null>(null);
  const [runConnectionState, setRunConnectionState] = useState<RunConnectionState>("idle");
  const [runTerminalNotice, setRunTerminalNotice] = useState<RunTerminalNotice | null>(null);
  const [runRecoveryWarning, setRunRecoveryWarning] = useState<string | null>(null);
  const [runDiscoveryPending, setRunDiscoveryPending] = useState(false);
  const [runStartPending, setRunStartPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [settingsEditorState, setSettingsEditorState] = useState<SettingsEditorState>({ dirty: false, busy: false });
  const [inspectorOpen, setInspectorOpen] = useState(
    () => typeof window === "undefined" || !window.matchMedia(INSPECTOR_OVERLAY_QUERY).matches
  );
  const inspectorModal = useMediaQuery(INSPECTOR_OVERLAY_QUERY);
  const eventsRef = useRef<EventSource | null>(null);
  const trackedRunIdRef = useRef<string | null>(null);
  const runEventCursorRef = useRef(0);
  const sessionRecoveryIdRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const cancelRequestRunIdRef = useRef<string | null>(null);
  const pendingPermissionsLoadIdRef = useRef(0);
  const shellRequestIdRef = useRef(0);
  const shellRunIdRef = useRef<string | null>(null);
  const permissionActionTokenRef = useRef(0);
  const workingDirectoryRequestIdRef = useRef(0);
  const runStartRequestIdRef = useRef(0);
  const contextPreviewRequestIdRef = useRef(0);
  const sessionAgentRequestIdRef = useRef(0);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesShouldFollowRef = useRef(true);
  const messagesScrollFrameRef = useRef<number | null>(null);
  const messagesLoadIdRef = useRef(0);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const composerIsComposingRef = useRef(false);
  const modelCatalogAbortRef = useRef<AbortController | null>(null);
  const modelCatalogRequestIdRef = useRef(0);
  const providerProfileIdRef = useRef(providerProfileId);
  const modelOverrideRef = useRef(modelOverride);
  const previousActiveTabRef = useRef<Tab>(activeTab);
  selectedSessionIdRef.current = selectedSessionId;
  modelOverrideRef.current = modelOverride;
  const activeRunId = activeRun?.id ?? null;
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const agentId = selectedSession?.agentId ?? "main";
  const selectedAgent = agents.find((agent) => agent.id === agentId) ?? null;
  const effectiveProviderProfileId = providerProfileId || selectedAgent?.modelProfileId || defaultProviderProfileId;
  const selectedProvider = providers.find((profile) => profile.id === effectiveProviderProfileId) ?? null;
  const selectedAgentDefaultsApply = profileDefaultsApplyToProvider(
    selectedAgent,
    effectiveProviderProfileId,
    defaultProviderProfileId,
    Boolean(providerProfileId)
  );
  const effectiveDefaultsAgent = selectedAgentDefaultsApply ? selectedAgent : null;
  providerProfileIdRef.current = effectiveProviderProfileId;
  const selectedPendingPermissions = pendingPermissions.filter((permission) => permission.sessionId === selectedSessionId);

  useEffect(() => {
    void loadSessions();
    void loadProviders();
    void loadAgents();
    void loadTools();
    void loadPendingPermissions();
    return () => detachRunEvents();
  }, []);

  useEffect(() => {
    messagesShouldFollowRef.current = true;
    const recoveryId = sessionRecoveryIdRef.current + 1;
    sessionRecoveryIdRef.current = recoveryId;
    messagesLoadIdRef.current += 1;
    detachRunEvents();
    setActiveRun(null);
    setRunConnectionState("idle");
    setRunTerminalNotice(null);
    setRunRecoveryWarning(null);
    setRunDiscoveryPending(Boolean(selectedSessionId));
    setCancelPending(false);
    cancelRequestRunIdRef.current = null;
    shellRunIdRef.current = null;
    setShellToolState("idle");
    setLastShellResponse(null);
    setContextPreview(null);
    setContextPreviewState("idle");
    setMessages([]);
    setProviderProfileId("");
    setModelOverride("");
    setReasoningEffort("");
    setTemperature("");
    setSessionAgentSaveState("idle");
    setSessionAgentError(null);
    void loadPendingPermissions();
    if (!selectedSessionId) {
      return undefined;
    }
    void restoreSessionState(selectedSessionId, recoveryId);
    return () => {
      if (sessionRecoveryIdRef.current === recoveryId) {
        sessionRecoveryIdRef.current += 1;
        detachRunEvents();
      }
    };
  }, [selectedSessionId]);

  useEffect(() => {
    setWorkingDirectoryDraft(selectedSession?.workingDirectory ?? "");
    setWorkingDirectorySaveState("idle");
    setWorkingDirectoryError(null);
  }, [selectedSessionId, selectedSession?.workingDirectory]);

  useEffect(() => {
    const returningToChat = previousActiveTabRef.current !== "chat" && activeTab === "chat";
    previousActiveTabRef.current = activeTab;
    if (activeTab === "chat") {
      void loadProviders();
      void loadAgents();
      void loadTools();
      void loadPendingPermissions();
      if (returningToChat && providerProfileIdRef.current) {
        void loadProviderModelCatalog(providerProfileIdRef.current);
      }
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "chat" && selectedPendingPermissions.length > 0) {
      setInspectorOpen(true);
    }
  }, [activeTab, selectedPendingPermissions.length]);

  useEffect(() => {
    modelCatalogAbortRef.current?.abort();
    setModelCatalog(null);
    setModelCatalogError(null);
    setReasoningEffort("");
    if (!effectiveProviderProfileId) {
      setModelCatalogState("idle");
      return;
    }
    void loadProviderModelCatalog(effectiveProviderProfileId);
    return () => modelCatalogAbortRef.current?.abort();
  }, [effectiveProviderProfileId]);

  useEffect(() => {
    if (!modelCatalog) {
      return;
    }
    setReasoningEffort((current) => reconcileReasoningEffort(modelCatalog, selectedProvider, effectiveDefaultsAgent, modelOverride, current));
  }, [effectiveDefaultsAgent, modelCatalog, modelOverride, selectedProvider]);

  useEffect(() => {
    writeSendOnEnterPreference(sendOnEnter);
  }, [sendOnEnter]);

  useEffect(() => {
    if (activeTab === "chat" && messagesShouldFollowRef.current) {
      scheduleMessagesToBottom();
    }
  }, [activeTab, error, inspectorOpen, messages]);

  useEffect(() => {
    const handleResize = () => {
      if (messagesShouldFollowRef.current) {
        scheduleMessagesToBottom();
      }
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (messagesScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(messagesScrollFrameRef.current);
      }
    };
  }, []);

  async function loadSessions() {
    setLoadState("loading");
    setError(null);
    try {
      const nextSessions = await requestJson<Session[]>("/api/sessions");
      setSessions(nextSessions);
      if (!selectedSessionIdRef.current && nextSessions[0]) {
        selectSession(nextSessions[0].id);
      }
      setLoadState("idle");
    } catch (requestError) {
      setLoadState("error");
      setError(toErrorMessage(requestError));
    }
  }

  async function restoreSessionState(sessionId: string, recoveryId: number) {
    setError(null);
    try {
      const activeRuns = await requestJson<PublicRunSummary[]>(`/api/sessions/${sessionId}/runs/active`);
      if (recoveryId !== sessionRecoveryIdRef.current || sessionId !== selectedSessionIdRef.current) {
        return;
      }
      const selection = selectRecoveredRun(activeRuns);
      let nextMessages: Message[];
      try {
        nextMessages = await requestJson<Message[]>(`/api/sessions/${sessionId}/messages`);
      } catch (requestError) {
        if (selection.run && recoveryId === sessionRecoveryIdRef.current && sessionId === selectedSessionIdRef.current) {
          setRunRecoveryWarning(selection.warning);
          setLastRunOptions(selection.run.runOptions);
          setLastRunUsage(selection.run.usage);
          if (selection.run.status === "waiting_permission") {
            setInspectorOpen(true);
            void loadPendingPermissions();
          }
          beginRunTracking(selection.run, false);
          setError(`Message snapshot failed; rebuilding the active run from its event log. ${toErrorMessage(requestError)}`);
          return;
        }
        throw requestError;
      }
      if (recoveryId !== sessionRecoveryIdRef.current || sessionId !== selectedSessionIdRef.current) {
        return;
      }

      messagesShouldFollowRef.current = true;
      setRunRecoveryWarning(selection.warning);
      if (selection.warning) {
        setInspectorOpen(true);
      }
      if (!selection.run) {
        const trackedRunId = trackedRunIdRef.current;
        if (trackedRunId) {
          setMessages((current) => mergeSnapshotWithTrackedRun(nextMessages, current, trackedRunId));
          return;
        }
        trackedRunIdRef.current = null;
        setMessages(nextMessages);
        setRunTerminalNotice(terminalNoticeFromMessages(nextMessages));
        return;
      }

      setMessages(prepareMessagesForRunReplay(nextMessages, selection.run.id));
      setLastRunOptions(selection.run.runOptions);
      setLastRunUsage(selection.run.usage);
      if (selection.run.status === "waiting_permission") {
        setInspectorOpen(true);
        void loadPendingPermissions();
      }
      beginRunTracking(selection.run, false);
    } catch (requestError) {
      if (recoveryId === sessionRecoveryIdRef.current && sessionId === selectedSessionIdRef.current) {
        setError(toErrorMessage(requestError));
      }
    } finally {
      if (recoveryId === sessionRecoveryIdRef.current && sessionId === selectedSessionIdRef.current) {
        setRunDiscoveryPending(false);
      }
    }
  }

  async function loadMessages(sessionId: string, followAfterLoad = false) {
    if (sessionId !== selectedSessionIdRef.current) {
      return;
    }
    const loadId = messagesLoadIdRef.current + 1;
    messagesLoadIdRef.current = loadId;
    setError(null);
    try {
      const nextMessages = await requestJson<Message[]>(`/api/sessions/${sessionId}/messages`);
      if (loadId !== messagesLoadIdRef.current || sessionId !== selectedSessionIdRef.current) {
        return;
      }
      if (followAfterLoad) {
        messagesShouldFollowRef.current = true;
      }
      const trackedRunId = trackedRunIdRef.current;
      setMessages((current) =>
        trackedRunId ? mergeSnapshotWithTrackedRun(nextMessages, current, trackedRunId) : nextMessages
      );
    } catch (requestError) {
      if (loadId === messagesLoadIdRef.current && sessionId === selectedSessionIdRef.current) {
        setError(toErrorMessage(requestError));
      }
    }
  }

  async function loadProviders() {
    try {
      const response = await requestJson<ProviderListResponse>("/api/providers");
      setProviders(response.providers);
      setDefaultProviderProfileId(response.defaultProviderProfileId);
      setProviderProfileId((current) =>
        !current || response.providers.some((profile) => profile.id === current) ? current : ""
      );
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    }
  }

  async function loadProviderModelCatalog(profileId: string, refresh = false) {
    modelCatalogAbortRef.current?.abort();
    const controller = new AbortController();
    modelCatalogAbortRef.current = controller;
    const requestId = modelCatalogRequestIdRef.current + 1;
    modelCatalogRequestIdRef.current = requestId;
    setModelCatalogState("loading");
    setModelCatalogError(null);
    try {
      const query = refresh ? "?refresh=1" : "";
      const catalog = await requestJson<ProviderModelCatalog>(`/api/providers/${encodeURIComponent(profileId)}/models${query}`, {
        signal: controller.signal
      });
      if (controller.signal.aborted || requestId !== modelCatalogRequestIdRef.current || providerProfileIdRef.current !== profileId) {
        return;
      }
      setModelCatalog(catalog);
      setModelCatalogState("loaded");
      const profile = providers.find((item) => item.id === profileId) ?? null;
      const agent = profileDefaultsApplyToProvider(
        agents.find((item) => item.id === agentId) ?? null,
        profileId,
        defaultProviderProfileId,
        Boolean(providerProfileId)
      )
        ? agents.find((item) => item.id === agentId) ?? null
        : null;
      const nextModelOverride = reconcileModelOverride(catalog, modelOverrideRef.current);
      setModelOverride(nextModelOverride);
      setReasoningEffort((current) => reconcileReasoningEffort(catalog, profile, agent, nextModelOverride, current));
    } catch (requestError) {
      if (controller.signal.aborted || requestId !== modelCatalogRequestIdRef.current) {
        return;
      }
      setModelCatalogState("error");
      setModelCatalogError(toErrorMessage(requestError));
    }
  }

  async function loadAgents() {
    try {
      const response = await requestJson<AgentListResponse>("/api/agents");
      setAgents(response.agents);
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
    const loadId = pendingPermissionsLoadIdRef.current + 1;
    const generation = sessionGenerationRef.current;
    pendingPermissionsLoadIdRef.current = loadId;
    try {
      const response = await requestJson<PermissionListResponse>("/api/permissions?status=pending");
      if (loadId !== pendingPermissionsLoadIdRef.current || generation !== sessionGenerationRef.current) {
        return;
      }
      setPendingPermissions(response.permissions);
    } catch (requestError) {
      if (loadId === pendingPermissionsLoadIdRef.current && generation === sessionGenerationRef.current) {
        setError(toErrorMessage(requestError));
      }
    }
  }

  function selectSession(sessionId: string | null) {
    if (sessionId !== selectedSessionIdRef.current) {
      sessionGenerationRef.current += 1;
      workingDirectoryRequestIdRef.current += 1;
      runStartRequestIdRef.current += 1;
      contextPreviewRequestIdRef.current += 1;
      sessionAgentRequestIdRef.current += 1;
      permissionActionTokenRef.current += 1;
      selectedSessionIdRef.current = sessionId;
      setRunStartPending(false);
      setPermissionActionId(null);
    }
    setSelectedSessionId(sessionId);
  }

  function changeTab(nextTab: Tab) {
    if (activeTab === "settings" && nextTab !== "settings") {
      if (settingsEditorState.busy) {
        window.alert("Wait for the Agent Profile mutation to finish before leaving Settings.");
        return;
      }
      if (settingsEditorState.dirty && !window.confirm("Discard unsaved Agent Profile changes and leave Settings?")) {
        return;
      }
      setSettingsEditorState({ dirty: false, busy: false });
    }
    setActiveTab(nextTab);
  }

  function isCurrentSessionGeneration(sessionId: string, generation: number): boolean {
    return isCurrentSessionRequest(selectedSessionIdRef.current, sessionGenerationRef.current, sessionId, generation);
  }

  function isCurrentSessionOperation(
    sessionId: string | null,
    generation: number,
    requestId: number,
    currentRequestId: number
  ): boolean {
    return isCurrentSessionOperationRequest(
      selectedSessionIdRef.current,
      sessionGenerationRef.current,
      currentRequestId,
      sessionId,
      generation,
      requestId
    );
  }

  function isCurrentCancelRequest(sessionId: string, generation: number, runId: string): boolean {
    return isCurrentTrackedRunRequest(
      selectedSessionIdRef.current,
      sessionGenerationRef.current,
      trackedRunIdRef.current,
      sessionId,
      generation,
      runId
    );
  }

  async function createSession() {
    setError(null);
    try {
      const session = await requestJson<Session>("/api/sessions", { method: "POST" });
      setSessions((current) => [session, ...current]);
      selectSession(session.id);
    } catch (requestError) {
      setError(toErrorMessage(requestError));
    }
  }

  async function saveSessionWorkingDirectory() {
    const sessionId = selectedSessionId;
    if (!sessionId) {
      setWorkingDirectoryError("Select or create a session before changing its working directory.");
      return;
    }
    if (sessionAgentSaveState === "saving") {
      setWorkingDirectoryError("Wait for the session agent change to finish.");
      return;
    }
    const workingDirectory = workingDirectoryDraft.trim();
    if (!workingDirectory) {
      setWorkingDirectoryError("Working directory is required.");
      return;
    }

    const generation = sessionGenerationRef.current;
    const requestId = workingDirectoryRequestIdRef.current + 1;
    workingDirectoryRequestIdRef.current = requestId;
    setWorkingDirectorySaveState("saving");
    setWorkingDirectoryError(null);
    try {
      const session = await requestJson<Session>(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workingDirectory })
      });
      if (
        session.id !== sessionId ||
        !isCurrentSessionOperation(sessionId, generation, requestId, workingDirectoryRequestIdRef.current)
      ) {
        return;
      }
      setSessions((current) =>
        current.map((item) => (item.id === session.id ? mergeSessionMutation(item, session, ["workingDirectory"]) : item))
      );
      setWorkingDirectoryDraft(session.workingDirectory);
      setWorkingDirectorySaveState("saved");
    } catch (requestError) {
      if (isCurrentSessionOperation(sessionId, generation, requestId, workingDirectoryRequestIdRef.current)) {
        setWorkingDirectorySaveState("idle");
        setWorkingDirectoryError(toErrorMessage(requestError));
      }
    }
  }

  async function updateSessionAgent(agentId: string) {
    const session = selectedSession;
    if (!session || activeRun || workingDirectorySaveState === "saving") {
      return;
    }
    const generation = sessionGenerationRef.current;
    const requestId = sessionAgentRequestIdRef.current + 1;
    sessionAgentRequestIdRef.current = requestId;
    setSessionAgentSaveState("saving");
    setSessionAgentError(null);
    try {
      const updated = await requestJson<Session>(`/api/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId })
      });
      if (
        updated.id !== session.id ||
        !isCurrentSessionOperation(session.id, generation, requestId, sessionAgentRequestIdRef.current)
      ) {
        return;
      }
      setSessions((current) => current.map((item) => (item.id === updated.id ? mergeSessionMutation(item, updated, ["agentId"]) : item)));
      setProviderProfileId("");
      setModelOverride("");
      setReasoningEffort("");
      setTemperature("");
      setSessionAgentSaveState("saved");
    } catch (requestError) {
      if (isCurrentSessionOperation(session.id, generation, requestId, sessionAgentRequestIdRef.current)) {
        setSessionAgentSaveState("idle");
        setSessionAgentError(toErrorMessage(requestError));
      }
    }
  }

  async function startRun() {
    const text = input.trim();
    if (
      !text ||
      activeRun ||
      runStartPending ||
      sessionAgentSaveState === "saving" ||
      workingDirectorySaveState === "saving"
    ) {
      return;
    }

    let sessionId = selectedSessionIdRef.current;
    let generation = sessionGenerationRef.current;
    let requestId = runStartRequestIdRef.current + 1;
    runStartRequestIdRef.current = requestId;
    setRunStartPending(true);
    setError(null);
    try {
      const runOptions = buildRunOptionsFromForm(modelOverride, reasoningEffort, temperature);
      followLatestMessages();
      if (!sessionId) {
        const session = await requestJson<Session>("/api/sessions", { method: "POST" });
        if (!isCurrentSessionOperation(null, generation, requestId, runStartRequestIdRef.current)) {
          return;
        }
        setSessions((current) => [session, ...current]);
        selectSession(session.id);
        sessionId = session.id;
        generation = sessionGenerationRef.current;
        requestId = runStartRequestIdRef.current + 1;
        runStartRequestIdRef.current = requestId;
        setRunStartPending(true);
      }

      setInput("");
      setContextPreview(null);
      const response = await requestJson<CreateRunResponse>(`/api/sessions/${sessionId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          providerProfileId: providerProfileId || undefined,
          runOptions: hasRunOptions(runOptions) ? runOptions : undefined
        })
      });
      if (
        response.run.sessionId !== sessionId ||
        !isCurrentSessionOperation(sessionId, generation, requestId, runStartRequestIdRef.current)
      ) {
        return;
      }
      setLastProviderResolution(response.providerResolution);
      setLastRunOptions(response.runOptions);
      setLastRunUsage(response.usage);
      setLastUnsupportedRunOptions(response.unsupportedRunOptions);
      setProviderNotice(providerResolutionNotice(response.providerResolution));
      setRunRecoveryWarning(null);
      beginRunTracking(response.run, true);
      void loadSessions();
    } catch (requestError) {
      if (!isCurrentSessionOperation(sessionId, generation, requestId, runStartRequestIdRef.current)) {
        return;
      }
      const existingRun = activeRunFromError(requestError);
      if (existingRun && existingRun.sessionId === sessionId) {
        setRunRecoveryWarning("Another interface already has active work in this session. Reconnected to that run instead.");
        beginRunTracking(existingRun, true);
      } else {
        setError(toErrorMessage(requestError));
      }
      setInput(text);
    } finally {
      if (isCurrentSessionOperation(sessionId, generation, requestId, runStartRequestIdRef.current)) {
        setRunStartPending(false);
      }
    }
  }

  async function cancelRun() {
    if (!activeRun || cancelRequestRunIdRef.current) {
      return;
    }

    const run = activeRun;
    const generation = sessionGenerationRef.current;
    cancelRequestRunIdRef.current = run.id;
    setCancelPending(true);
    setActiveRun((current) =>
      current?.id === run.id ? { ...current, status: "cancelling", currentPhase: "cancelling" } : current
    );
    setError(null);
    try {
      const snapshot = await requestJson<PublicRunSummary>(`/api/runs/${run.id}/cancel`, { method: "POST" });
      if (isCurrentCancelRequest(run.sessionId, generation, run.id)) {
        applyRunSnapshot(snapshot);
      }
    } catch (requestError) {
      try {
        const snapshot = await requestJson<PublicRunSummary>(`/api/runs/${run.id}`);
        if (isCurrentCancelRequest(run.sessionId, generation, run.id)) {
          applyRunSnapshot(snapshot);
        }
      } catch {
        if (isCurrentCancelRequest(run.sessionId, generation, run.id)) {
          setActiveRun((current) => (current?.id === run.id ? run : current));
          setError(toErrorMessage(requestError));
        }
      }
    } finally {
      if (cancelRequestRunIdRef.current === run.id) {
        cancelRequestRunIdRef.current = null;
        setCancelPending(false);
      }
    }
  }

  async function previewContext() {
    const sessionId = selectedSessionId;
    if (!sessionId) {
      setError("Create or select a session before previewing context.");
      return;
    }

    const generation = sessionGenerationRef.current;
    const requestId = contextPreviewRequestIdRef.current + 1;
    contextPreviewRequestIdRef.current = requestId;
    setContextPreviewState("loading");
    setError(null);
    try {
      const runOptions = buildRunOptionsFromForm(modelOverride, reasoningEffort, temperature);
      const response = await requestJson<ContextPreviewResponse>(`/api/sessions/${sessionId}/context/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerProfileId: providerProfileId || undefined,
          runOptions: hasRunOptions(runOptions) ? runOptions : undefined,
          text: input.trim() || undefined
        })
      });
      if (!isCurrentSessionOperation(sessionId, generation, requestId, contextPreviewRequestIdRef.current)) {
        return;
      }
      setContextPreview(response);
      setContextPreviewState("idle");
    } catch (requestError) {
      if (isCurrentSessionOperation(sessionId, generation, requestId, contextPreviewRequestIdRef.current)) {
        setContextPreviewState("error");
        setError(toErrorMessage(requestError));
      }
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
    const requestId = shellRequestIdRef.current + 1;
    shellRequestIdRef.current = requestId;
    let generation = sessionGenerationRef.current;
    try {
      if (!sessionId) {
        const session = await requestJson<Session>("/api/sessions", { method: "POST" });
        setSessions((current) => [session, ...current]);
        selectSession(session.id);
        sessionId = session.id;
      }
      generation = sessionGenerationRef.current;

      const timeoutMs = parseShellTimeout(shellTimeoutMs);
      const response = await requestJson<InvokeToolResponse>(`/api/sessions/${sessionId}/tools/shell.exec?async=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command,
          cwd: shellCwd.trim() || undefined,
          timeoutMs
        })
      });
      if (requestId !== shellRequestIdRef.current || !isCurrentSessionGeneration(sessionId, generation)) {
        return;
      }
      shellRunIdRef.current = response.run.id;
      setLastShellResponse(response);
      setShellToolState(shellToolStateFromResponse(response));
      upsertMessage(response.message);
      if (isTerminalRunStatus(response.run.status)) {
        void loadMessages(sessionId);
      } else {
        beginRunTracking(response.run, true);
      }
      void loadSessions();
      void loadPendingPermissions();
    } catch (requestError) {
      if (requestId === shellRequestIdRef.current && sessionId && isCurrentSessionGeneration(sessionId, generation)) {
        setShellToolState("failed");
        setError(toErrorMessage(requestError));
      }
    }
  }

  async function approvePermission(requestId: string) {
    const permissionRequest = pendingPermissions.find((permission) => permission.id === requestId);
    const requestSessionId = permissionRequest?.sessionId;
    const generation = sessionGenerationRef.current;
    const actionToken = permissionActionTokenRef.current + 1;
    permissionActionTokenRef.current = actionToken;
    setPermissionActionId(requestId);
    setError(null);
    try {
      const response = await requestJson<InvokeToolResponse>(`/api/permissions/${requestId}/approve`, { method: "POST" });
      if (
        permissionActionTokenRef.current !== actionToken ||
        !permissionRequest ||
        !requestSessionId ||
        !isCurrentSessionGeneration(requestSessionId, generation) ||
        !isMatchingPermissionResponse(
          permissionRequest,
          response,
          trackedRunIdRef.current,
          response.invocation.caller === "manual" ? shellRunIdRef.current : null
        )
      ) {
        return;
      }
      if (response.invocation.caller === "manual") {
        shellRunIdRef.current = response.run.id;
        setLastShellResponse(response);
        setShellToolState(shellToolStateFromResponse(response));
      }
      upsertMessage(response.message);
      const resumedAgentRun = openRunEventsIfAgentResume(response);
      if (!resumedAgentRun && response.message.sessionId === selectedSessionId) {
        void loadMessages(response.message.sessionId);
      }
      void loadSessions();
      await loadPendingPermissions();
    } catch (requestError) {
      if (
        permissionActionTokenRef.current === actionToken &&
        requestSessionId &&
        isCurrentSessionGeneration(requestSessionId, generation)
      ) {
        setError(toErrorMessage(requestError));
      }
    } finally {
      if (permissionActionTokenRef.current === actionToken) {
        setPermissionActionId(null);
      }
    }
  }

  async function denyPermission(requestId: string) {
    const permissionRequest = pendingPermissions.find((permission) => permission.id === requestId);
    const requestSessionId = permissionRequest?.sessionId;
    const generation = sessionGenerationRef.current;
    const actionToken = permissionActionTokenRef.current + 1;
    permissionActionTokenRef.current = actionToken;
    setPermissionActionId(requestId);
    setError(null);
    try {
      const response = await requestJson<InvokeToolResponse>(`/api/permissions/${requestId}/deny`, { method: "POST" });
      if (
        permissionActionTokenRef.current !== actionToken ||
        !permissionRequest ||
        !requestSessionId ||
        !isCurrentSessionGeneration(requestSessionId, generation) ||
        !isMatchingPermissionResponse(
          permissionRequest,
          response,
          trackedRunIdRef.current,
          response.invocation.caller === "manual" ? shellRunIdRef.current : null
        )
      ) {
        return;
      }
      if (response.invocation.caller === "manual") {
        shellRunIdRef.current = response.run.id;
        setLastShellResponse(response);
        setShellToolState(shellToolStateFromResponse(response));
      }
      upsertMessage(response.message);
      const resumedAgentRun = openRunEventsIfAgentResume(response);
      if (!resumedAgentRun && response.message.sessionId === selectedSessionId) {
        void loadMessages(response.message.sessionId);
      }
      void loadSessions();
      await loadPendingPermissions();
    } catch (requestError) {
      if (
        permissionActionTokenRef.current === actionToken &&
        requestSessionId &&
        isCurrentSessionGeneration(requestSessionId, generation)
      ) {
        setError(toErrorMessage(requestError));
      }
    } finally {
      if (permissionActionTokenRef.current === actionToken) {
        setPermissionActionId(null);
      }
    }
  }

  function beginRunTracking(run: PublicRunSummary, resetMessages: boolean) {
    if (run.sessionId !== selectedSessionIdRef.current || isTerminalRunStatus(run.status)) {
      return;
    }
    detachRunEvents();
    trackedRunIdRef.current = run.id;
    runEventCursorRef.current = 0;
    setActiveRun(run);
    setRunTerminalNotice(null);
    setRunConnectionState("connecting");
    if (resetMessages) {
      setMessages((current) => prepareMessagesForRunReplay(current, run.id));
    }
    openRunEvents(run.id);
  }

  function openRunEvents(runId: string) {
    let source: EventSource;
    try {
      source = new EventSource(`/api/runs/${runId}/events?after=${runEventCursorRef.current}`);
    } catch (streamError) {
      setRunConnectionState("reconnecting");
      setError(toErrorMessage(streamError));
      return;
    }
    eventsRef.current = source;

    source.onopen = () => {
      if (eventsRef.current === source && trackedRunIdRef.current === runId) {
        setRunConnectionState("connected");
      }
    };
    source.onmessage = (messageEvent) => {
      if (eventsRef.current !== source || trackedRunIdRef.current !== runId) {
        return;
      }
      try {
        const runEvent = JSON.parse(messageEvent.data) as RunEvent;
        if (runEvent.sessionId !== selectedSessionIdRef.current) {
          return;
        }
        if (!shouldApplyRunEvent(runEventCursorRef.current, runId, runEvent)) {
          return;
        }
        runEventCursorRef.current = runEvent.seq;
        applyRunEvent(runEvent);
      } catch (streamError) {
        setError(`Run event could not be applied: ${toErrorMessage(streamError)}`);
      }
    };
    source.onerror = () => {
      if (eventsRef.current === source && trackedRunIdRef.current === runId) {
        setRunConnectionState("reconnecting");
      }
    };
  }

  function detachRunEvents() {
    eventsRef.current?.close();
    eventsRef.current = null;
    trackedRunIdRef.current = null;
    runEventCursorRef.current = 0;
  }

  function applyRunEvent(event: RunEvent) {
    setMessages((current) => applyRunEventToMessages(current, event));
    setActiveRun((current) => (current?.id === event.runId ? updateRunFromEvent(current, event) : current));

    if (event.type === "run_started") {
      const payload = event.payload as {
        providerResolution?: PublicProviderResolution;
        runOptions?: RunOptions;
        unsupportedRunOptions?: string[];
        usage?: RunUsage;
      };
      if (payload.providerResolution) {
        setLastProviderResolution(payload.providerResolution);
        setProviderNotice(providerResolutionNotice(payload.providerResolution));
      }
      setLastRunOptions(payload.runOptions ?? null);
      setLastRunUsage((current) => payload.usage ?? current);
      setLastUnsupportedRunOptions(payload.unsupportedRunOptions ?? []);
      return;
    }

    if (event.type === "user_message_created" || event.type === "assistant_message_created" || event.type === "assistant_message_updated") {
      if (event.type === "assistant_message_updated") {
        const message = (event.payload as { message?: Message }).message;
        if (message?.usage) {
          setLastRunUsage(message.usage);
        }
        if (message && shellRunIdRef.current === event.runId) {
          setLastShellResponse((current) => (current?.run.id === event.runId ? { ...current, message } : current));
        }
      }
      return;
    }

    if (event.type === "delta") {
      return;
    }

    if (event.type === "tool_call.created" || event.type === "tool_result.created") {
      return;
    }

    if (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed") {
      const payload = event.payload as { error?: string; status?: string };
      if (shellRunIdRef.current === event.runId) {
        if (event.type === "tool.completed") {
          setShellToolState("completed");
        } else if (event.type === "tool.failed") {
          setShellToolState(payload.status === "cancelled" ? "cancelled" : "failed");
        }
      }
      if (payload.error && payload.status !== "cancelled") {
        setError(payload.error);
      }
      return;
    }

    if (event.type === "tool.stdout.delta" || event.type === "tool.stderr.delta") {
      return;
    }

    if (event.type === "permission.requested" || event.type === "permission.approved" || event.type === "permission.denied") {
      void loadPendingPermissions();
      return;
    }

    if (event.type === "run_waiting_permission") {
      setInspectorOpen(true);
      void loadPendingPermissions();
      return;
    }

    if (event.type === "run_cancelling") {
      setCancelPending(true);
      return;
    }

    const terminalNotice = terminalNoticeFromEvent(event);
    if (terminalNotice) {
      const payload = event.payload as { messageId?: string; error?: string; metadata?: Message["metadata"]; usage?: RunUsage };
      if (payload.usage) {
        setLastRunUsage(payload.usage);
      }
      if (terminalNotice.status === "failed" && payload.error) {
        setError(payload.error);
      }
      if (shellRunIdRef.current === event.runId) {
        setShellToolState(
          terminalNotice.status === "completed"
            ? "completed"
            : terminalNotice.status === "cancelled"
              ? "cancelled"
              : "failed"
        );
      }
      finishTrackedRun(terminalNotice, event.sessionId);
    }
  }

  function applyRunSnapshot(snapshot: PublicRunSummary) {
    if (snapshot.sessionId !== selectedSessionIdRef.current) {
      return;
    }
    setLastRunOptions(snapshot.runOptions);
    setLastRunUsage(snapshot.usage);
    if (isTerminalRunStatus(snapshot.status)) {
      finishTrackedRun({ status: snapshot.status, error: snapshot.error }, snapshot.sessionId);
      return;
    }
    setActiveRun(snapshot);
    if (snapshot.status === "waiting_permission") {
      setInspectorOpen(true);
      void loadPendingPermissions();
    }
  }

  function finishTrackedRun(notice: RunTerminalNotice, sessionId: string) {
    detachRunEvents();
    setActiveRun(null);
    setRunConnectionState("idle");
    setRunTerminalNotice(notice);
    setCancelPending(false);
    cancelRequestRunIdRef.current = null;
    void loadSessions();
    void loadPendingPermissions();
    if (sessionId === selectedSessionIdRef.current) {
      const recoveryId = sessionRecoveryIdRef.current + 1;
      sessionRecoveryIdRef.current = recoveryId;
      setRunDiscoveryPending(true);
      void restoreSessionState(sessionId, recoveryId);
    }
  }

  function upsertMessage(message: Message) {
    setMessages((current) => {
      const exists = current.some((item) => item.id === message.id);
      const next = exists ? current.map((item) => (item.id === message.id ? message : item)) : [...current, message];
      return next.sort(compareMessages);
    });
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent;
    if (composerIsComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return;
    }
    if (event.key !== "Enter" || event.altKey) {
      return;
    }

    const usesSubmitShortcut = event.ctrlKey || event.metaKey;
    const usesPlainEnter = sendOnEnter && !event.shiftKey;
    if (!usesSubmitShortcut && !usesPlainEnter) {
      return;
    }
    if (event.repeat) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function handleMessagesScroll() {
    const container = messagesScrollRef.current;
    if (!container) {
      return;
    }
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    messagesShouldFollowRef.current = distanceFromBottom <= MESSAGE_BOTTOM_THRESHOLD_PX;
  }

  function followLatestMessages() {
    messagesShouldFollowRef.current = true;
    scheduleMessagesToBottom();
  }

  function scheduleMessagesToBottom() {
    if (messagesScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(messagesScrollFrameRef.current);
    }
    messagesScrollFrameRef.current = window.requestAnimationFrame(() => {
      messagesScrollFrameRef.current = null;
      if (!messagesShouldFollowRef.current) {
        return;
      }
      const container = messagesScrollRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  function openRunEventsIfAgentResume(response: InvokeToolResponse): boolean {
    if (response.run.provider.startsWith("tool:")) {
      return false;
    }
    if (response.run.status === "running" || response.run.status === "waiting_permission" || response.run.status === "cancelling") {
      beginRunTracking(response.run, true);
      return true;
    }
    return false;
  }

  const shellTool = tools.find((tool) => tool.id === "shell.exec") ?? null;
  const displayedRunStatus = runDiscoveryPending
    ? { label: "checking active runs", tone: "reconnecting" as const }
    : runDisplayStatus(activeRun, runConnectionState, runTerminalNotice, Boolean(selectedSession));
  const runControlsDisabled =
    Boolean(activeRun) ||
    runDiscoveryPending ||
    runStartPending ||
    sessionAgentSaveState === "saving" ||
    workingDirectorySaveState === "saving";

  return (
    <main
      className={`appShell ${activeTab === "chat" ? `chatLayout ${inspectorOpen ? "inspectorOpen" : "inspectorClosed"}` : "settingsLayout"}`}
    >
      <aside className="sidebar">
        <div className="sidebarHeader">
          <div>
            <span className="eyebrow">Local workspace</span>
            <h1>Agent Platform</h1>
          </div>
          {activeTab === "chat" && <button onClick={createSession}>New session</button>}
        </div>

        <nav className="tabList" aria-label="Dashboard sections">
          <button className={activeTab === "chat" ? "tab active" : "tab"} onClick={() => changeTab("chat")}>
            Chat
          </button>
          <button className={activeTab === "settings" ? "tab active" : "tab"} onClick={() => changeTab("settings")}>
            Settings
          </button>
        </nav>

        {activeTab === "chat" ? (
          <section className="sidebarSessions" aria-label="Sessions">
            <div className="sidebarSectionHeading">
              <strong>Sessions</strong>
              <span>{sessions.length}</span>
            </div>
            {loadState === "loading" && <p className="muted">Loading sessions...</p>}
            <div className="sessionList">
              {sessions.map((session) => (
                <button
                  className={session.id === selectedSessionId ? "session active" : "session"}
                  key={session.id}
                  onClick={() => selectSession(session.id)}
                  aria-current={session.id === selectedSessionId ? "page" : undefined}
                >
                  <strong className="sessionTitle">{session.title}</strong>
                  <span className="sessionCwd monospace" title={session.workingDirectory}>
                    {session.workingDirectory}
                  </span>
                  <span className="sessionUpdated">Updated {new Date(session.updatedAt).toLocaleDateString()}</span>
                </button>
              ))}
              {loadState !== "loading" && sessions.length === 0 && <p className="muted sidebarEmpty">No sessions yet.</p>}
            </div>
          </section>
        ) : (
          <p className="muted sidebarNote">Daemon lifecycle stays in the CLI. Settings and registries live here.</p>
        )}
      </aside>

      {activeTab === "chat" ? (
        <>
          <section className="chatWorkspace">
            <ChatHeader
              session={selectedSession}
              provider={selectedProvider}
              modelOverride={modelOverride}
              activeRunId={activeRunId}
              statusLabel={displayedRunStatus.label}
              statusTone={displayedRunStatus.tone}
              lastProviderResolution={lastProviderResolution}
              lastUnsupportedRunOptions={lastUnsupportedRunOptions}
              inspectorOpen={inspectorOpen}
              inspectorModal={inspectorModal}
              pendingPermissionCount={selectedPendingPermissions.length}
              inspectorToggleRef={inspectorToggleRef}
              onToggleInspector={() => setInspectorOpen((current) => !current)}
            />

            {error && (
              <div className="chatAlertArea">
                <div className="error">{error}</div>
              </div>
            )}
            {runRecoveryWarning && (
              <div className="chatAlertArea">
                <div className="runRecoveryWarning">{runRecoveryWarning}</div>
              </div>
            )}

            <div className="messages" ref={messagesScrollRef} onScroll={handleMessagesScroll}>
              <div className="messageStream">
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
            </div>

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void startRun();
              }}
            >
              <div className="composerInner">
                <textarea
                  value={input}
                  placeholder="Send a message..."
                  onChange={(event) => setInput(event.target.value)}
                  onCompositionStart={() => {
                    composerIsComposingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    composerIsComposingRef.current = false;
                  }}
                  onKeyDown={handleComposerKeyDown}
                  disabled={runControlsDisabled}
                  rows={3}
                />
                <div className="composerActions">
                  <label className="composerPreference">
                    <input
                      type="checkbox"
                      checked={sendOnEnter}
                      aria-describedby="composer-keyboard-hint"
                      onChange={(event) => setSendOnEnter(event.target.checked)}
                    />
                    <span>Enter로 전송</span>
                  </label>
                  <span className="composerKeyboardHint" id="composer-keyboard-hint">
                    {sendOnEnter ? "Shift+Enter 줄바꿈" : "Ctrl/⌘+Enter 전송"}
                  </span>
                  <RunActionButton
                    activeRun={activeRun}
                    cancelPending={cancelPending}
                    runDisabled={
                      !input.trim() ||
                      runDiscoveryPending ||
                      runStartPending ||
                      sessionAgentSaveState === "saving" ||
                      workingDirectorySaveState === "saving"
                    }
                    onCancel={() => void cancelRun()}
                  />
                  {activeRun && <span className="cancelHint">Cancellation is best-effort; completed side effects remain.</span>}
                </div>
              </div>
            </form>
          </section>

          {inspectorOpen && (
            <>
              {inspectorModal && (
                <button type="button" className="inspectorBackdrop" aria-label="Close run inspector" onClick={() => setInspectorOpen(false)} />
              )}
              <RunInspector
                onClose={() => setInspectorOpen(false)}
                modal={inspectorModal}
                returnFocusRef={inspectorToggleRef}
                setup={{
                  agents,
                  agentId,
                  agentSaveState: sessionAgentSaveState,
                  agentError: sessionAgentError,
                  providers,
                  providerProfileId,
                  effectiveProviderProfileId,
                  defaultProviderProfileId,
                  modelOverride,
                  reasoningEffort,
                  temperature,
                  disabled: runControlsDisabled,
                  modelCatalog,
                  modelCatalogState,
                  modelCatalogError,
                  onRefreshModelCatalog: () => void loadProviderModelCatalog(effectiveProviderProfileId, true),
                  onAgentChange: (value) => void updateSessionAgent(value),
                  onProviderChange: (value) => {
                    setProviderProfileId(value);
                    setModelOverride("");
                    setReasoningEffort("");
                    setTemperature("");
                    setProviderNotice(null);
                  },
                  onModelOverrideChange: (value) => {
                    setModelOverride(value);
                    const profile = providers.find((item) => item.id === effectiveProviderProfileId) ?? null;
                    const candidateAgent = agents.find((item) => item.id === agentId) ?? null;
                    const agent = profileDefaultsApplyToProvider(
                      candidateAgent,
                      effectiveProviderProfileId,
                      defaultProviderProfileId,
                      Boolean(providerProfileId)
                    )
                      ? candidateAgent
                      : null;
                    setReasoningEffort((current) => reconcileReasoningEffort(modelCatalog, profile, agent, value, current));
                  },
                  onReasoningEffortChange: setReasoningEffort,
                  onTemperatureChange: setTemperature
                }}
                sessionContext={{
                  session: selectedSession,
                  workingDirectoryDraft,
                  saveState: workingDirectorySaveState,
                  error: workingDirectoryError,
                  disabled: runControlsDisabled,
                  onWorkingDirectoryChange: (value) => {
                    setWorkingDirectoryDraft(value);
                    setWorkingDirectorySaveState("idle");
                    setWorkingDirectoryError(null);
                  },
                  onSaveWorkingDirectory: () => void saveSessionWorkingDirectory()
                }}
                runStatus={{
                  activeRun,
                  statusLabel: displayedRunStatus.label,
                  statusTone: displayedRunStatus.tone,
                  connectionState: runConnectionState,
                  terminalNotice: runTerminalNotice,
                  recoveryWarning: runRecoveryWarning,
                  cancelPending,
                  onCancel: () => void cancelRun(),
                  providerNotice,
                  lastProviderResolution,
                  lastRunOptions,
                  lastRunUsage,
                  lastUnsupportedRunOptions
                }}
                permissions={{
                  items: selectedPendingPermissions,
                  busyRequestId: permissionActionId,
                  onRefresh: () => void loadPendingPermissions(),
                  onApprove: (requestId) => void approvePermission(requestId),
                  onDeny: (requestId) => void denyPermission(requestId)
                }}
                advanced={{
                  contextPreview,
                  contextPreviewState,
                  onPreviewContext: () => void previewContext(),
                  shellTool,
                  sessionWorkingDirectory: selectedSession?.workingDirectory ?? null,
                  shellCommand,
                  shellCwd,
                  shellTimeoutMs,
                  shellToolState,
                  lastShellResponse,
                  shellDisabled: runControlsDisabled,
                  onShellCommandChange: setShellCommand,
                  onShellCwdChange: setShellCwd,
                  onShellTimeoutChange: setShellTimeoutMs,
                  onRunShell: () => void executeShellTool()
                }}
              />
            </>
          )}
        </>
      ) : (
        <SettingsPanel onAgentsChanged={setAgents} onEditorStateChange={setSettingsEditorState} />
      )}
    </main>
  );
}

function readSendOnEnterPreference(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    return window.localStorage.getItem(COMPOSER_SEND_ON_ENTER_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeSendOnEnterPreference(sendOnEnter: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(COMPOSER_SEND_ON_ENTER_STORAGE_KEY, String(sendOnEnter));
  } catch {
    return;
  }
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const updateMatch = () => setMatches(mediaQuery.matches);
    updateMatch();
    mediaQuery.addEventListener("change", updateMatch);
    return () => mediaQuery.removeEventListener("change", updateMatch);
  }, [query]);

  return matches;
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

function providerResolutionNotice(resolution: PublicProviderResolution): string | null {
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

function activeRunFromError(error: unknown): PublicRunSummary | null {
  if (!(error instanceof ApiRequestError) || error.code !== "active_run_exists") {
    return null;
  }
  const value = error.body?.run;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const run = value as Partial<PublicRunSummary>;
  return typeof run.id === "string" && typeof run.sessionId === "string" && run.status && isActiveRunStatus(run.status)
    ? (run as PublicRunSummary)
    : null;
}
