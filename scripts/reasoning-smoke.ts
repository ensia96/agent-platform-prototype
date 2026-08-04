import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBody } from "../src/client/MessageBody";
import { buildContext } from "../src/kernel/context-builder";
import { RunEventBus } from "../src/kernel/event-bus";
import { RunWriter } from "../src/kernel/run-writer";
import { buildCodexRequestPayload, parseOpenAIChatGPTStream } from "../src/providers/openai-chatgpt";
import { parseOpenAICompatibleStream } from "../src/providers/openai-compatible";
import type {
  ProviderReasoningDetailRecord,
  ProviderReasoningSummaryRecord,
  ProviderRunContext,
  ProviderRunInput,
  ProviderRunWriter
} from "../src/providers/types";
import type { JsonObject, Message, MessagePart, RunUsage } from "../src/shared/types";
import { SQLiteStore } from "../src/store/sqlite";

function verifyChatGPTSummaryRequest(): void {
  const now = new Date(0).toISOString();
  const input: ProviderRunInput = {
    session: {
      id: "fixture-session",
      title: "fixture",
      workingDirectory: "/fixture",
      createdAt: now,
      updatedAt: now
    },
    context: {
      agent: {
        id: "main",
        name: "Fixture",
        description: null,
        systemPrompt: "Answer directly.",
        modelProfileId: null,
        defaultRunOptions: null,
        skillIds: [],
        toolIds: [],
        metadata: {},
        createdAt: now,
        updatedAt: now
      },
      systemPrompt: "Answer directly.",
      workingDirectory: "/fixture",
      messages: [{ role: "user", content: "Hello" }],
      availableTools: [],
      runOptions: { model: "fixture-model", reasoningEffort: "high" },
      metadata: {}
    },
    messages: [{ role: "user", content: "Hello" }],
    sourceMessages: [],
    profile: {
      id: "openai-chatgpt",
      name: "Fixture ChatGPT",
      type: "openai-chatgpt",
      vendor: "openai",
      runtime: "chatgpt-codex",
      authMode: "oauth-device",
      billingSource: "consumer-subscription",
      source: "builtin",
      enabled: true,
      model: "fixture-model",
      status: { state: "connected", message: "fixture", credentialStatus: "present" }
    },
    credential: { oauth: { type: "oauth", access: "fixture-access" } },
    requestedRunOptions: { model: "fixture-model", reasoningEffort: "high" },
    runOptions: { model: "fixture-model", reasoningEffort: "high" },
    unsupportedRunOptions: []
  };

  const payload = buildCodexRequestPayload(input);
  assert.deepEqual(payload.reasoning, { summary: "auto", effort: "high" });
  assert.equal(input.context.runOptions.reasoningEffort, "high", "building the request must not mutate the selected run options");

  input.context.runOptions.reasoningEffort = "none";
  assert.deepEqual(buildCodexRequestPayload(input).reasoning, { summary: "auto", effort: "none" }, "none must be explicit");
  delete input.context.runOptions.reasoningEffort;
  assert.deepEqual(buildCodexRequestPayload(input).reasoning, { summary: "auto" }, "blank effort must be omitted");
}

async function verifyChatGPTReasoningParser(): Promise<void> {
  const writer = new RecordingWriter();
  const toolCalls = await parseOpenAIChatGPTStream(
    sseStream([
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" }
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "Draft segment"
      },
      {
        type: "response.reasoning_summary_text.done",
        output_index: 0,
        summary_index: 0,
        text: "Done segment"
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 1,
        delta: "Second draft"
      },
      {
        type: "response.reasoning_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "Draft detail"
      },
      {
        type: "response.reasoning_text.done",
        output_index: 0,
        content_index: 0,
        text: "Done detail"
      },
      {
        type: "response.reasoning_text.delta",
        output_index: 0,
        content_index: 1,
        delta: "Second detail draft"
      },
      { type: "response.analysis.delta", delta: "RAW_ANALYSIS" },
      { type: "response.thinking.delta", delta: "RAW_THINKING" },
      { type: "response.reasoning_content.delta", delta: "UNOFFICIAL_RESPONSE_REASONING_CONTENT" },
      {
        type: "response.hidden_content.delta",
        delta: "UNRECOGNIZED_HIDDEN_DELTA",
        choices: [{ delta: { content: "UNRECOGNIZED_HIDDEN_CHOICE" } }]
      },
      {
        type: "response.output_text.delta",
        delta: "Visible answer",
        choices: [{ delta: { reasoning_content: "UNOFFICIAL_REASONING_CONTENT" } }]
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "function_call",
          id: "function-item-1",
          call_id: "call-1",
          name: "shell_exec",
          arguments: "{\"command\":\"pwd\"}"
        }
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "reasoning-item-1",
          encrypted_content: "OPAQUE_ENCRYPTED_SENTINEL",
          summary: [
            { type: "summary_text", text: "Final segment A" },
            { type: "summary_text", text: "Final segment B" }
          ],
          content: [
            { type: "reasoning_text", text: "Final detail A" },
            { type: "reasoning_text", text: "Final detail B" },
            { type: "analysis_text", text: "UNSUPPORTED_FINAL_ANALYSIS" }
          ]
        },
        usage: {
          input_tokens: 10,
          output_tokens: 6,
          total_tokens: 16,
          output_tokens_details: { reasoning_tokens: 4 }
        }
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "reasoning-item-1",
        output_index: 0,
        summary_index: 1,
        delta: "LATE_DELTA_AFTER_FINAL"
      },
      {
        type: "response.reasoning_text.delta",
        item_id: "reasoning-item-1",
        output_index: 0,
        content_index: 1,
        delta: "LATE_DETAIL_AFTER_FINAL"
      }
    ]),
    providerContext(writer)
  );

  assert.equal(writer.text, "Visible answer");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "shell_exec");
  assert.equal(writer.summaries.at(-1)?.summary, "Final segment A\n\nFinal segment B");
  assert.equal(writer.summaries.at(-1)?.provenance.nativeEventType, "response.output_item.done");
  assert.equal(writer.summaries.at(-1)?.provenance.itemId, "reasoning-item-1");
  assert.equal(writer.summaries.at(-1)?.provenance.authoritative, true);
  assert.deepEqual(writer.summaries.at(-1)?.provenance.summaryIndexes, [0, 1]);
  assert.equal(writer.summaries.some((record) => record.summary === "Done segment"), true, "summary done text must replace its delta");
  assert.equal(writer.summaries.some((record) => record.summary?.includes("Draft segmentDone segment")), false);
  assert.equal(writer.details.at(-1)?.detail, "Final detail A\n\nFinal detail B");
  assert.equal(writer.details.at(-1)?.provenance.nativeEventType, "response.output_item.done");
  assert.equal(writer.details.at(-1)?.provenance.itemId, "reasoning-item-1");
  assert.equal(writer.details.at(-1)?.provenance.authoritative, true);
  assert.deepEqual(writer.details.at(-1)?.provenance.contentIndexes, [0, 1]);
  assert.equal(writer.details.some((record) => record.detail === "Done detail"), true, "detail done text must replace its delta");
  assert.equal(writer.details.some((record) => record.detail?.includes("Draft detailDone detail")), false);
  const recorded = JSON.stringify({ summaries: writer.summaries, details: writer.details });
  for (const forbidden of [
    "RAW_ANALYSIS",
    "RAW_THINKING",
    "UNOFFICIAL_RESPONSE_REASONING_CONTENT",
    "UNRECOGNIZED_HIDDEN_DELTA",
    "UNRECOGNIZED_HIDDEN_CHOICE",
    "UNOFFICIAL_REASONING_CONTENT",
    "OPAQUE_ENCRYPTED_SENTINEL",
    "UNSUPPORTED_FINAL_ANALYSIS",
    "LATE_DELTA_AFTER_FINAL",
    "LATE_DETAIL_AFTER_FINAL"
  ]) {
    assert.equal(recorded.includes(forbidden), false, `${forbidden} must not be stored as a reasoning part`);
  }
  assert.deepEqual(writer.usage.at(-1), { inputTokens: 10, outputTokens: 6, reasoningTokens: 4, totalTokens: 16 });
  assert.deepEqual(writer.summaries.at(-1)?.usage, { inputTokens: 10, outputTokens: 6, reasoningTokens: 4, totalTokens: 16 });
  assert.deepEqual(writer.details.at(-1)?.usage, { inputTokens: 10, outputTokens: 6, reasoningTokens: 4, totalTokens: 16 });
}

async function verifyOpenAICompatibleUsageOnly(): Promise<void> {
  const writer = new RecordingWriter();
  await parseOpenAICompatibleStream(
    sseStream([
      {
        choices: [{ delta: { content: "Compatible answer", reasoning_content: "UNOFFICIAL_COMPATIBLE_REASONING" } }],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 5,
          total_tokens: 12,
          completion_tokens_details: { reasoning_tokens: 2 }
        }
      }
    ]),
    providerContext(writer)
  );

  assert.equal(writer.text, "Compatible answer");
  assert.equal(writer.summaries.length, 0, "Chat Completions reasoning_content must not become a summary");
  assert.equal(writer.details.length, 0, "Chat Completions reasoning_content must not become a detail part");
  assert.deepEqual(writer.usage.at(-1), { inputTokens: 7, outputTokens: 5, reasoningTokens: 2, totalTokens: 12 });
}

async function verifyChatGPTDetailWithoutSummary(): Promise<void> {
  const writer = new RecordingWriter();
  await parseOpenAIChatGPTStream(
    sseStream([
      {
        type: "response.reasoning_text.delta",
        item_id: "detail-only-item",
        output_index: 0,
        content_index: 0,
        delta: "Detail draft"
      },
      {
        type: "response.reasoning_text.done",
        item_id: "detail-only-item",
        output_index: 0,
        content_index: 0,
        text: "Detail without summary"
      },
      { type: "response.analysis.delta", delta: "RAW_ANALYSIS_WITHOUT_SUMMARY" },
      { type: "response.output_text.delta", delta: "Answer without summary" }
    ]),
    providerContext(writer)
  );

  assert.equal(writer.text, "Answer without summary");
  assert.equal(writer.summaries.length, 0, "a response without summary events must not create a summary part");
  assert.equal(writer.details.at(-1)?.detail, "Detail without summary");
  assert.equal(JSON.stringify(writer.details).includes("RAW_ANALYSIS_WITHOUT_SUMMARY"), false);
}

async function verifyMalformedRawEventIsNotReflected(): Promise<void> {
  const sentinel = "MALFORMED_RAW_REASONING_SENTINEL";
  await assert.rejects(
    parseOpenAIChatGPTStream(
      rawSseStream(`data: {"type":"response.analysis.delta","delta":"${sentinel}"\n\n`),
      providerContext(new RecordingWriter())
    ),
    (error: unknown) => error instanceof Error && error.message.includes("Failed to parse OpenAI ChatGPT SSE event") && !error.message.includes(sentinel)
  );
}

function verifyReasoningUi(): void {
  const now = new Date(0).toISOString();
  const summaryPart: MessagePart = {
    id: "reasoning-summary-part",
    messageId: "assistant",
    seq: 1,
    type: "reasoning_summary",
    text: "Provider summary",
    content: { summary: "Provider summary" },
    metadata: {
      providerSupplied: true,
      provider: "openai-chatgpt",
      nativeEventType: "response.reasoning_summary_text.done"
    },
    createdAt: now,
    updatedAt: now
  };
  const detailPart: MessagePart = {
    id: "reasoning-detail-part",
    messageId: "assistant",
    seq: 2,
    type: "reasoning_detail",
    text: "Provider detail",
    content: { detail: "Provider detail" },
    metadata: {
      providerSupplied: true,
      provider: "openai-chatgpt",
      nativeEventType: "response.reasoning_text.done"
    },
    createdAt: now,
    updatedAt: now
  };
  const html = renderToStaticMarkup(createElement(MessageBody, { message: fixtureMessage([summaryPart, detailPart], now) }));
  assert.equal(html.match(/<details[^>]*\sopen(?:="")?/g)?.length, 2, "both reasoning parts must be expanded by default");
  assert.equal(html.includes("추론 요약 · openai-chatgpt"), true);
  assert.equal(html.includes("추론 상세 · openai-chatgpt"), true);
  assert.equal(html.includes("response.reasoning_summary_text.done"), true);
  assert.equal(html.includes("response.reasoning_text.done"), true);
  assert.equal(html.includes("Provider summary"), true);
  assert.equal(html.includes("Provider detail"), true);
  assert.equal(html.includes("reasoningDisclaimer"), false);
  assert.equal(html.includes("내부 추론"), false);

  const emptySummaryPart: MessagePart = {
    ...summaryPart,
    id: "empty-reasoning-summary-part",
    text: "LEGACY_REASONING_METADATA_FALLBACK",
    content: { usage: { reasoningTokens: 3 } }
  };
  const emptyDetailPart: MessagePart = {
    ...detailPart,
    id: "empty-reasoning-detail-part",
    text: "LEGACY_REASONING_DETAIL_FALLBACK",
    content: {}
  };
  const emptyHtml = renderToStaticMarkup(createElement(MessageBody, { message: fixtureMessage([emptySummaryPart, emptyDetailPart], now) }));
  assert.equal(emptyHtml.includes("추론 요약"), false, "an empty summary part must not render a block");
  assert.equal(emptyHtml.includes("추론 상세"), false, "an empty detail part must not render a block");
  assert.equal(emptyHtml.includes("LEGACY_REASONING_METADATA_FALLBACK"), false);
  assert.equal(emptyHtml.includes("LEGACY_REASONING_DETAIL_FALLBACK"), false);
}

function fixtureMessage(parts: MessagePart[], now: string): Message {
  return {
    id: "assistant",
    sessionId: "fixture-session",
    runId: "fixture-run",
    role: "assistant",
    status: "completed",
    error: null,
    metadata: {},
    model: "fixture-model",
    runOptions: null,
    usage: null,
    createdAt: now,
    updatedAt: now,
    parts
  };
}

function verifyRunWriterPersistenceAndEvents(): void {
  const directory = mkdtempSync(join(tmpdir(), "agent-platform-reasoning-"));
  try {
    const dbPath = join(directory, "reasoning.db");
    const store = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    const now = new Date().toISOString();
    const session = store.createSession({ id: "session", title: "reasoning", workingDirectory: directory, createdAt: now, updatedAt: now });
    const run = store.createRun({
      id: "run",
      sessionId: session.id,
      provider: "mock",
      status: "running",
      metadata: { runOptions: { reasoningEffort: "future-tier" } },
      createdAt: now,
      updatedAt: now
    });
    assert.equal(run.runOptions?.reasoningEffort, "future-tier", "provider-defined efforts must survive SQLite decoding");
    const message = store.createMessage({
      id: "assistant-1",
      sessionId: session.id,
      runId: run.id,
      role: "assistant",
      status: "streaming",
      createdAt: now,
      updatedAt: now
    });
    const eventBus = new RunEventBus();
    const events: string[] = [];
    const updatedReasoningPartTypes: string[][] = [];
    eventBus.subscribe(run.id, (event) => {
      events.push(event.type);
      if (event.type === "assistant_message_updated") {
        const payload = event.payload as { message?: Message };
        updatedReasoningPartTypes.push(
          payload.message?.parts
            .filter((part) => part.type === "reasoning_summary" || part.type === "reasoning_detail")
            .map((part) => part.type)
            .sort() ?? []
        );
      }
    });
    const writer = new RunWriter({ store, eventBus, run, assistantMessageId: message.id });

    assert.equal(
      writer.writeReasoningSummary({ summary: "   ", provenance: { provider: "openai-chatgpt" } }),
      null,
      "empty summary must not be stored"
    );
    assert.equal(
      writer.writeReasoningDetail({ detail: "   ", provenance: { provider: "openai-chatgpt" } }),
      null,
      "empty detail must not be stored"
    );
    const summaryFirst = writer.writeReasoningSummary({
      summary: "First snapshot",
      provenance: {
        provider: "openai-chatgpt",
        nativeEventType: "response.reasoning_summary_text.delta",
        itemId: "reasoning-item-1",
        summaryIndexes: [0],
        authoritative: false
      }
    });
    const summarySecond = writer.writeReasoningSummary({
      summary: "Authoritative snapshot",
      usage: { reasoningTokens: 3 },
      provenance: {
        provider: "openai-chatgpt",
        nativeEventType: "response.reasoning_summary_text.done",
        itemId: "reasoning-item-1",
        summaryIndexes: [0],
        authoritative: true
      }
    });
    const detailFirst = writer.writeReasoningDetail({
      detail: "First detail snapshot",
      provenance: {
        provider: "openai-chatgpt",
        nativeEventType: "response.reasoning_text.delta",
        itemId: "reasoning-item-1",
        contentIndexes: [0],
        authoritative: false
      }
    });
    const detailSecond = writer.writeReasoningDetail({
      detail: "Authoritative detail",
      usage: { reasoningTokens: 3 },
      provenance: {
        provider: "openai-chatgpt",
        nativeEventType: "response.reasoning_text.done",
        itemId: "reasoning-item-1",
        contentIndexes: [0],
        authoritative: true
      }
    });
    assert.ok(summaryFirst && summarySecond && detailFirst && detailSecond);
    assert.equal(summaryFirst.id, summarySecond.id, "reasoning summary must upsert within one provider turn");
    assert.equal(detailFirst.id, detailSecond.id, "reasoning detail must upsert within one provider turn");
    assert.notEqual(summarySecond.id, detailSecond.id, "summary and detail must remain separate parts");
    const reasoningParts = store.getMessage(message.id)?.parts.filter((part) => part.type === "reasoning_summary" || part.type === "reasoning_detail");
    assert.deepEqual(reasoningParts?.map((part) => part.type).sort(), ["reasoning_detail", "reasoning_summary"]);
    assert.deepEqual(events, [
      "assistant_message_updated",
      "assistant_message_updated",
      "assistant_message_updated",
      "assistant_message_updated"
    ]);
    assert.deepEqual(updatedReasoningPartTypes.at(-1), ["reasoning_detail", "reasoning_summary"]);

    writer.writeUsage({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15 });
    writer.writeUsage({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15 });
    const secondMessage = store.createMessage({
      id: "assistant-2",
      sessionId: session.id,
      runId: run.id,
      role: "assistant",
      status: "streaming",
      createdAt: new Date(Date.parse(now) + 1).toISOString(),
      updatedAt: new Date(Date.parse(now) + 1).toISOString()
    });
    const secondWriter = new RunWriter({ store, eventBus, run: store.getRun(run.id)!, assistantMessageId: secondMessage.id });
    secondWriter.writeUsage({ inputTokens: 7, outputTokens: 3, reasoningTokens: 1, totalTokens: 10 });
    secondWriter.writeUsage({ inputTokens: 7, outputTokens: 3, reasoningTokens: 1, totalTokens: 10 });
    assert.deepEqual(store.getRun(run.id)?.usage, { inputTokens: 17, outputTokens: 8, reasoningTokens: 3, totalTokens: 25 });

    store.transitionMessageStatus(message.id, ["streaming"], "completed", new Date().toISOString(), null);
    const reloadedStore = new SQLiteStore({ dbPath, defaultWorkingDirectory: directory });
    assert.equal(reloadedStore.getRun(run.id)?.runOptions?.reasoningEffort, "future-tier");
    const reloadedMessage = reloadedStore.getMessage(message.id)!;
    const summaryPart = reloadedMessage.parts.find((part) => part.type === "reasoning_summary");
    const detailPart = reloadedMessage.parts.find((part) => part.type === "reasoning_detail");
    assert.equal(summaryPart?.content.summary, "Authoritative snapshot");
    assert.equal(summaryPart?.metadata.provider, "openai-chatgpt");
    assert.equal(summaryPart?.metadata.nativeEventType, "response.reasoning_summary_text.done");
    assert.equal(summaryPart?.metadata.authoritative, true);
    assert.equal(detailPart?.content.detail, "Authoritative detail");
    assert.equal(detailPart?.metadata.provider, "openai-chatgpt");
    assert.equal(detailPart?.metadata.nativeEventType, "response.reasoning_text.done");
    assert.deepEqual(detailPart?.metadata.contentIndexes, [0]);
    assert.equal(detailPart?.metadata.authoritative, true);

    const context = buildContext({
      session,
      agent: {
        id: "main",
        name: "Mango",
        description: null,
        systemPrompt: "Answer directly.",
        modelProfileId: null,
        defaultRunOptions: null,
        skillIds: [],
        toolIds: [],
        metadata: {},
        createdAt: now,
        updatedAt: now
      },
      messages: [reloadedMessage]
    });
    assert.equal(JSON.stringify(context.context.messages).includes("Authoritative snapshot"), false, "reasoning summary must stay out of model context");
    assert.equal(JSON.stringify(context.context.messages).includes("Authoritative detail"), false, "reasoning detail must stay out of model context");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

class RecordingWriter implements ProviderRunWriter {
  text = "";
  usage: RunUsage[] = [];
  summaries: ProviderReasoningSummaryRecord[] = [];
  details: ProviderReasoningDetailRecord[] = [];

  writeDelta(text: string): void {
    this.text += text;
  }

  writeUsage(usage: RunUsage): void {
    this.usage.push({ ...usage });
  }

  writeMetadata(_metadata: JsonObject): void {}

  writeReasoningSummary(summary: ProviderReasoningSummaryRecord): MessagePart | null {
    this.summaries.push({
      ...summary,
      provenance: {
        ...summary.provenance,
        summaryIndexes: summary.provenance.summaryIndexes ? [...summary.provenance.summaryIndexes] : undefined
      },
      usage: summary.usage ? { ...summary.usage } : undefined
    });
    return null;
  }

  writeReasoningDetail(detail: ProviderReasoningDetailRecord): MessagePart | null {
    this.details.push({
      ...detail,
      provenance: {
        ...detail.provenance,
        contentIndexes: detail.provenance.contentIndexes ? [...detail.provenance.contentIndexes] : undefined
      },
      usage: detail.usage ? { ...detail.usage } : undefined
    });
    return null;
  }
}

function providerContext(writer: ProviderRunWriter): ProviderRunContext {
  return { signal: new AbortController().signal, writer };
}

function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}

function rawSseStream(data: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    }
  });
}

verifyChatGPTSummaryRequest();
await verifyChatGPTReasoningParser();
await verifyChatGPTDetailWithoutSummary();
await verifyMalformedRawEventIsNotReflected();
await verifyOpenAICompatibleUsageOnly();
verifyRunWriterPersistenceAndEvents();
verifyReasoningUi();

console.log("Reasoning smoke passed: summary/detail parser, redaction, persistence/context/usage, and UI");
