import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
  ProviderModelCatalog,
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
import { ChatHeader } from "./ChatHeader";
import { compareParts, MessageBody, partText } from "./MessageBody";
import { reconcileModelOverride, reconcileReasoningEffort, type ModelCatalogLoadState } from "./model-catalog";
import { RunInspector } from "./RunInspector";
import { SettingsPanel } from "./SettingsPanel";
import { shellToolStateFromResponse, type ShellToolState } from "./ToolPanels";

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
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [agentId, setAgentId] = useState("main");
  const [providerProfileId, setProviderProfileId] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">("");
  const [temperature, setTemperature] = useState("");
  const [modelCatalog, setModelCatalog] = useState<ProviderModelCatalog | null>(null);
  const [modelCatalogState, setModelCatalogState] = useState<ModelCatalogLoadState>("idle");
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
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
  const [inspectorOpen, setInspectorOpen] = useState(
    () => typeof window === "undefined" || !window.matchMedia(INSPECTOR_OVERLAY_QUERY).matches
  );
  const inspectorModal = useMediaQuery(INSPECTOR_OVERLAY_QUERY);
  const eventsRef = useRef<EventSource | null>(null);
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
  providerProfileIdRef.current = providerProfileId;
  modelOverrideRef.current = modelOverride;
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;
  const selectedProvider = providers.find((profile) => profile.id === providerProfileId) ?? null;
  const selectedAgent = agents.find((agent) => agent.id === agentId) ?? null;

  useEffect(() => {
    void loadSessions();
    void loadProviders();
    void loadAgents();
    void loadTools();
    void loadPendingPermissions();
    return () => eventsRef.current?.close();
  }, []);

  useEffect(() => {
    messagesShouldFollowRef.current = true;
    if (!selectedSessionId) {
      messagesLoadIdRef.current += 1;
      setMessages([]);
      return;
    }
    void loadMessages(selectedSessionId, true);
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
    if (activeTab === "chat" && pendingPermissions.length > 0) {
      setInspectorOpen(true);
    }
  }, [activeTab, pendingPermissions.length]);

  useEffect(() => {
    modelCatalogAbortRef.current?.abort();
    setModelCatalog(null);
    setModelCatalogError(null);
    setReasoningEffort("");
    if (!providerProfileId) {
      setModelCatalogState("idle");
      return;
    }
    void loadProviderModelCatalog(providerProfileId);
    return () => modelCatalogAbortRef.current?.abort();
  }, [providerProfileId]);

  useEffect(() => {
    if (!modelCatalog) {
      return;
    }
    setReasoningEffort((current) => reconcileReasoningEffort(modelCatalog, selectedProvider, selectedAgent, modelOverride, current));
  }, [modelCatalog, modelOverride, selectedAgent, selectedProvider]);

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
      setSelectedSessionId((current) => current ?? nextSessions[0]?.id ?? null);
      setLoadState("idle");
    } catch (requestError) {
      setLoadState("error");
      setError(toErrorMessage(requestError));
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
      setMessages(nextMessages);
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
      setProviderProfileId((current) =>
        response.providers.some((profile) => profile.id === current) ? current : response.defaultProviderProfileId
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
      const agent = agents.find((item) => item.id === agentId) ?? null;
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
      followLatestMessages();
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

  function openRunEventsIfAgentResume(response: InvokeToolResponse) {
    if (response.run.provider.startsWith("tool:")) {
      return;
    }
    if (response.run.status === "running" || response.run.status === "waiting_permission") {
      setActiveRunId(response.run.id);
      openRunEvents(response.run.id);
    }
  }

  const shellTool = tools.find((tool) => tool.id === "shell.exec") ?? null;
  const waitingForApproval = Boolean(
    activeRunId && pendingPermissions.some((permission) => !permission.runId || permission.runId === activeRunId)
  );

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
          <button className={activeTab === "chat" ? "tab active" : "tab"} onClick={() => setActiveTab("chat")}>
            Chat
          </button>
          <button className={activeTab === "settings" ? "tab active" : "tab"} onClick={() => setActiveTab("settings")}>
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
                  onClick={() => setSelectedSessionId(session.id)}
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
              waitingForApproval={waitingForApproval}
              lastProviderResolution={lastProviderResolution}
              lastUnsupportedRunOptions={lastUnsupportedRunOptions}
              inspectorOpen={inspectorOpen}
              inspectorModal={inspectorModal}
              pendingPermissionCount={pendingPermissions.length}
              inspectorToggleRef={inspectorToggleRef}
              onToggleInspector={() => setInspectorOpen((current) => !current)}
            />

            {error && (
              <div className="chatAlertArea">
                <div className="error">{error}</div>
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
                  disabled={Boolean(activeRunId)}
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
                  providers,
                  providerProfileId,
                  modelOverride,
                  reasoningEffort,
                  temperature,
                  disabled: Boolean(activeRunId),
                  modelCatalog,
                  modelCatalogState,
                  modelCatalogError,
                  onRefreshModelCatalog: () => void loadProviderModelCatalog(providerProfileId, true),
                  onAgentChange: (value) => {
                    setAgentId(value);
                    const profile = providers.find((item) => item.id === providerProfileId) ?? null;
                    const agent = agents.find((item) => item.id === value) ?? null;
                    setReasoningEffort((current) => reconcileReasoningEffort(modelCatalog, profile, agent, modelOverride, current));
                  },
                  onProviderChange: (value) => {
                    setProviderProfileId(value);
                    setModelOverride("");
                    setReasoningEffort("");
                    setTemperature("");
                    setProviderNotice(null);
                  },
                  onModelOverrideChange: (value) => {
                    setModelOverride(value);
                    const profile = providers.find((item) => item.id === providerProfileId) ?? null;
                    const agent = agents.find((item) => item.id === agentId) ?? null;
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
                  disabled: Boolean(activeRunId),
                  onWorkingDirectoryChange: (value) => {
                    setWorkingDirectoryDraft(value);
                    setWorkingDirectorySaveState("idle");
                    setWorkingDirectoryError(null);
                  },
                  onSaveWorkingDirectory: () => void saveSessionWorkingDirectory()
                }}
                runStatus={{
                  activeRunId,
                  waitingForApproval,
                  providerNotice,
                  lastProviderResolution,
                  lastRunOptions,
                  lastRunUsage,
                  lastUnsupportedRunOptions
                }}
                permissions={{
                  items: pendingPermissions,
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
                  shellDisabled: Boolean(activeRunId),
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
        <SettingsPanel />
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
