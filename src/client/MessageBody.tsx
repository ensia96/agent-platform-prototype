import type { Message, MessagePart, RunUsage } from "../shared/types";
import { MarkdownBody } from "./MarkdownBody";

export function MessageBody({ message }: { message: Message }) {
  const timeline = buildMessageTimeline(message.parts);
  const renderTextAsMarkdown = message.role === "user" || message.role === "assistant";
  return (
    <>
      {message.error && (
        <div className="messageError">
          <strong>Provider error</strong>
          <pre>{message.error}</pre>
        </div>
      )}
      <div className="messageParts">
        {timeline.map((item) =>
          item.kind === "tool" ? (
            <ToolTimelineGroup key={`tool-${item.callId}-${item.parts[0]?.id ?? "part"}`} parts={item.parts} />
          ) : (
            <MessagePartView key={item.part.id} part={item.part} renderTextAsMarkdown={renderTextAsMarkdown} />
          )
        )}
      </div>
      {message.usage && <UsageSummary usage={message.usage} />}
    </>
  );
}

type MessageTimelineItem =
  | { kind: "part"; part: MessagePart }
  | { kind: "tool"; callId: string; parts: MessagePart[] };

function buildMessageTimeline(parts: MessagePart[]): MessageTimelineItem[] {
  const sortedParts = [...parts].sort(compareParts);
  const consumedPartIds = new Set<string>();
  const timeline: MessageTimelineItem[] = [];

  for (const part of sortedParts) {
    if (consumedPartIds.has(part.id)) {
      continue;
    }

    if (!isToolTimelinePart(part)) {
      consumedPartIds.add(part.id);
      timeline.push({ kind: "part", part });
      continue;
    }

    const callId = partString(part, "callId");
    if (!callId) {
      consumedPartIds.add(part.id);
      timeline.push({ kind: "part", part });
      continue;
    }

    const toolParts = sortedParts.filter((candidate) => isToolTimelinePart(candidate) && partString(candidate, "callId") === callId);
    for (const toolPart of toolParts) {
      consumedPartIds.add(toolPart.id);
    }
    timeline.push({ kind: "tool", callId, parts: toolParts });
  }

  return timeline;
}

function isToolTimelinePart(part: MessagePart): boolean {
  return part.type === "tool_call" || part.type === "command_output" || part.type === "tool_result";
}

function ToolTimelineGroup({ parts }: { parts: MessagePart[] }) {
  const sortedParts = [...parts].sort(compareParts);
  const callPart = sortedParts.find((part) => part.type === "tool_call") ?? null;
  const resultPart = [...sortedParts].reverse().find((part) => part.type === "tool_result") ?? null;
  const outputParts = sortedParts.filter((part) => part.type === "command_output");
  const primaryPart = callPart ?? resultPart ?? sortedParts[0];
  const callId = primaryPart ? partString(primaryPart, "callId") : "";
  const toolLabel = toolTimelineLabel(callPart, resultPart, callId);
  const status = toolTimelineStatus(callPart, resultPart);
  const statusClass = toolStatusClass(status);
  const inputSummary = callPart ? partString(callPart, "inputSummary") || callPart.text : "";
  const resultSummary = resultPart ? partString(resultPart, "outputSummary") || partString(resultPart, "output") || resultPart.text : "";
  const resultError = resultPart ? partString(resultPart, "error") : "";

  return (
    <details className={`messagePart toolTimelineBlock ${statusClass}`} open>
      <summary className="toolTimelineSummary">
        <span className="toolTimelineKind">Tool</span>
        <span className="toolTimelineName">{toolLabel}</span>
        <span className={`toolStatus ${statusClass}`}>{status}</span>
      </summary>
      {callPart && (
        <dl className="partDetails compactDetails">
          <dt>Call ID</dt>
          <dd>{callId || "unknown"}</dd>
          {partString(callPart, "provider") && (
            <>
              <dt>Provider</dt>
              <dd>{partString(callPart, "provider")}</dd>
            </>
          )}
        </dl>
      )}
      {inputSummary && <pre className="toolTimelineInput">{inputSummary}</pre>}
      {callPart && <JsonPreview value={callPart.content.input} label="Input" />}
      {outputParts.map((outputPart) => {
        const outputText = partString(outputPart, "text") || outputPart.text;
        return (
          <div className="toolTimelineOutput" key={outputPart.id}>
            <strong>
              Command output{partString(outputPart, "stream") ? ` · ${partString(outputPart, "stream")}` : ""}
              {partNumber(outputPart, "exitCode") !== null ? ` · exit ${partNumber(outputPart, "exitCode")}` : ""}
              {partBoolean(outputPart, "timedOut") ? " · timed out" : ""}
              {partBoolean(outputPart, "truncated") ? " · truncated" : ""}
            </strong>
            {partString(outputPart, "cwd") && <span className="muted monospace">cwd: {partString(outputPart, "cwd")}</span>}
            {outputText.trim() ? <pre>{outputText}</pre> : <p className="muted">No command output yet.</p>}
          </div>
        );
      })}
      {resultPart && (
        <div className="toolTimelineResult">
          <strong>Result · {partString(resultPart, "status") || "completed"}</strong>
          {resultSummary && <pre>{resultSummary}</pre>}
          {resultError && <pre className="partErrorText">{resultError}</pre>}
        </div>
      )}
    </details>
  );
}

function MessagePartView({ part, renderTextAsMarkdown }: { part: MessagePart; renderTextAsMarkdown: boolean }) {
  if (part.type === "text") {
    const text = partText(part);
    if (!text) {
      return null;
    }
    return renderTextAsMarkdown ? <MarkdownBody className="messageTextPart" content={text} /> : <pre className="messageTextPart">{text}</pre>;
  }

  if (part.type === "error") {
    return (
      <div className="messagePart messagePartError">
        <strong>Error</strong>
        <pre>{partString(part, "message") || part.text || "Unknown error"}</pre>
      </div>
    );
  }

  if (part.type === "reasoning_summary" || part.type === "reasoning_detail") {
    const contentKey = part.type === "reasoning_summary" ? "summary" : "detail";
    const label = part.type === "reasoning_summary" ? "추론 요약" : "추론 상세";
    const usage = usageFromPart(part);
    const content = partString(part, contentKey).trim();
    if (!content) {
      return null;
    }
    const provider = metadataString(part, "provider");
    const nativeEventType = metadataString(part, "nativeEventType");
    return (
      <details className="messagePart messagePartReasoning" open>
        <summary>{label}{provider ? ` · ${provider}` : ""}</summary>
        {nativeEventType && <p className="reasoningProvenance monospace">source: {nativeEventType}</p>}
        <MarkdownBody className="reasoningMarkdown" content={content} />
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

export function formatUsage(usage: RunUsage | null | undefined): string {
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

function toolTimelineLabel(callPart: MessagePart | null, resultPart: MessagePart | null, callId: string): string {
  const sourcePart = callPart ?? resultPart;
  return sourcePart ? partString(sourcePart, "toolName") || partString(sourcePart, "toolId") || callId || "unknown" : callId || "unknown";
}

function toolTimelineStatus(callPart: MessagePart | null, resultPart: MessagePart | null): string {
  return (resultPart ? partString(resultPart, "status") : "") || (callPart ? partString(callPart, "status") : "") || "created";
}

function toolStatusClass(status: string): string {
  if (status === "completed") {
    return "success";
  }
  if (status === "failed" || status === "cancelled") {
    return "failure";
  }
  if (status === "pending" || status === "pending_permission") {
    return "pending";
  }
  if (status === "running") {
    return "running";
  }
  return "created";
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

export function partText(part: MessagePart): string {
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

function metadataString(part: MessagePart, key: string): string {
  const value = part.metadata[key];
  return typeof value === "string" ? value : "";
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

export function compareParts(a: MessagePart, b: MessagePart): number {
  return a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
