import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody, safeMarkdownUrl } from "../src/client/MarkdownBody";
import { MessageBody } from "../src/client/MessageBody";
import type { Message, MessagePart, MessagePartType, MessageRole } from "../src/shared/types";

const markdown = `# Heading

Paragraph with *emphasis*, **strong text**, and ~~strikethrough~~.

- unordered
- [x] completed task
- [ ] open task

1. first
2. second

> quoted text

[external](https://example.com/docs) [relative](./guide) [anchor](#heading)
[unsafe-js](javascript:alert(1)) [unsafe-data](data:text/plain,blocked) [unsafe-file](file:///tmp/blocked) [protocol-relative](//example.com)

![remote diagram](https://images.example.com/diagram.png)
![unsafe image](data:image/png;base64,blocked)

Inline \`code()\`.

\`\`\`ts
const value = 1;
\`\`\`

| Name | Value |
| --- | ---: |
| one | 1 |

---

single line one
single line two

<span id="raw-html-marker">raw text</span>
<script>globalThis.rawHtmlExecuted = true</script>`;

verifyMarkdownSyntaxAndSecurity();
verifyMessageRenderingBoundaries();
verifyIncompleteMarkdown();

console.log("Markdown smoke passed: GFM/breaks, safe links/images, reasoning Markdown, and raw tool output");

function verifyMarkdownSyntaxAndSecurity(): void {
  const html = renderToStaticMarkup(createElement(MarkdownBody, { content: markdown }));

  for (const expected of [
    "<h1>Heading</h1>",
    "<em>emphasis</em>",
    "<strong>strong text</strong>",
    "<del>strikethrough</del>",
    "<ul",
    "<ol",
    "task-list-item",
    "type=\"checkbox\"",
    "<blockquote>",
    "<code>code()</code>",
    "<pre><code class=\"language-ts\">const value = 1;",
    "<table>",
    "<hr/>",
    "single line one<br/>\nsingle line two"
  ]) {
    assert.equal(html.includes(expected), true, `missing Markdown output: ${expected}`);
  }

  const externalTag = html.match(/<a[^>]*href="https:\/\/example\.com\/docs"[^>]*>/)?.[0] ?? "";
  assert.equal(externalTag.includes("target=\"_blank\""), true, "external links must open in a new tab");
  assert.equal(externalTag.includes("rel=\"noreferrer noopener\""), true, "external links must isolate the opener");

  const relativeTag = html.match(/<a[^>]*href="\.\/guide"[^>]*>/)?.[0] ?? "";
  assert.equal(relativeTag.includes("target="), false, "relative links must stay in the current tab");
  assert.equal(html.includes("href=\"#heading\""), true, "anchor links must be preserved");

  assert.equal(html.includes("javascript:"), false);
  assert.equal(html.includes("data:text"), false);
  assert.equal(html.includes("file:"), false);
  assert.equal(html.includes("href=\"//example.com\""), false);
  assert.equal(html.includes("<span class=\"markdownBlockedLink\">unsafe-js</span>"), true);
  assert.equal(html.includes("<img"), false, "Markdown images must never auto-fetch");
  assert.equal(html.includes("Image: <a href=\"https://images.example.com/diagram.png\""), true, "safe images must become links");
  assert.equal(html.includes("unsafe image (blocked)"), true, "unsafe image URLs must be blocked");

  assert.equal(html.includes("<span id=\"raw-html-marker\""), false, "raw HTML elements must not be inserted");
  assert.equal(html.includes("<script"), false, "raw scripts must not be inserted");
  assert.equal(html.includes("rawHtmlExecuted"), false, "raw script contents must not be reflected");

  assert.equal(safeMarkdownUrl("javascript:alert(1)"), "");
  assert.equal(safeMarkdownUrl("data:text/html,blocked"), "");
  assert.equal(safeMarkdownUrl("file:///tmp/blocked"), "");
  assert.equal(safeMarkdownUrl("//example.com/path"), "");
  assert.equal(safeMarkdownUrl("https://example.com/path"), "https://example.com/path");
  assert.equal(safeMarkdownUrl("../relative/path"), "../relative/path");
  assert.equal(safeMarkdownUrl("#anchor"), "#anchor");
}

function verifyMessageRenderingBoundaries(): void {
  const now = new Date(0).toISOString();
  const userHtml = renderToStaticMarkup(
    createElement(MessageBody, {
      message: fixtureMessage("user", [fixturePart("user-text", 0, "text", "**User bold**", { text: "**User bold**" }, now)], now)
    })
  );
  assert.equal(userHtml.includes("<strong>User bold</strong>"), true, "user text must render Markdown");

  const systemHtml = renderToStaticMarkup(
    createElement(MessageBody, {
      message: fixtureMessage("system", [fixturePart("system-text", 0, "text", "**SYSTEM_RAW**", { text: "**SYSTEM_RAW**" }, now)], now)
    })
  );
  assert.equal(systemHtml.includes("<pre class=\"messageTextPart\">**SYSTEM_RAW**</pre>"), true, "system text must remain raw");

  const parts: MessagePart[] = [
    fixturePart("assistant-text", 0, "text", "# Assistant heading\n- item", { text: "# Assistant heading\n- item" }, now),
    fixturePart("summary", 1, "reasoning_summary", "**Summary bold**\nnext", { summary: "**Summary bold**\nnext" }, now),
    fixturePart("detail", 2, "reasoning_detail", "## Detail heading\n~~detail~~", { detail: "## Detail heading\n~~detail~~" }, now),
    fixturePart(
      "tool-call",
      3,
      "tool_call",
      "**INPUT_RAW**",
      { callId: "call-1", toolName: "shell.exec", inputSummary: "**INPUT_RAW**", input: { raw: "**JSON_RAW**" } },
      now
    ),
    fixturePart(
      "tool-output",
      4,
      "command_output",
      "**TOOL_RAW_SENTINEL**",
      { callId: "call-1", stream: "stdout", text: "**TOOL_RAW_SENTINEL**" },
      now
    ),
    fixturePart(
      "tool-result",
      5,
      "tool_result",
      "# TOOL_RESULT_RAW",
      { callId: "call-1", toolName: "shell.exec", status: "completed", outputSummary: "# TOOL_RESULT_RAW" },
      now
    )
  ];
  const assistantHtml = renderToStaticMarkup(
    createElement(MessageBody, { message: { ...fixtureMessage("assistant", parts, now), error: "**ERROR_RAW**" } })
  );

  for (const expected of [
    "<h1>Assistant heading</h1>",
    "<strong>Summary bold</strong>",
    "<h2>Detail heading</h2>",
    "<del>detail</del>",
    "<pre>**ERROR_RAW**</pre>",
    "<pre class=\"toolTimelineInput\">**INPUT_RAW**</pre>",
    "**JSON_RAW**",
    "<pre>**TOOL_RAW_SENTINEL**</pre>",
    "<pre># TOOL_RESULT_RAW</pre>"
  ]) {
    assert.equal(assistantHtml.includes(expected), true, `missing message output: ${expected}`);
  }
  assert.equal(assistantHtml.includes("<strong>TOOL_RAW_SENTINEL</strong>"), false, "tool output must remain raw");
  assert.equal(assistantHtml.includes("<h1>TOOL_RESULT_RAW</h1>"), false, "tool result must remain raw");
}

function verifyIncompleteMarkdown(): void {
  const html = renderToStaticMarkup(createElement(MarkdownBody, { content: "Streaming fragment\n\n```ts\nconst unfinished = true" }));
  assert.equal(html.includes("Streaming fragment"), true);
  assert.equal(html.includes("const unfinished = true"), true);
  assert.equal(html.includes("<pre><code class=\"language-ts\">"), true);
}

function fixtureMessage(role: MessageRole, parts: MessagePart[], now: string): Message {
  return {
    id: `${role}-message`,
    sessionId: "fixture-session",
    runId: "fixture-run",
    role,
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

function fixturePart(
  id: string,
  seq: number,
  type: MessagePartType,
  text: string,
  content: MessagePart["content"],
  now: string
): MessagePart {
  return {
    id,
    messageId: "assistant-message",
    seq,
    type,
    text,
    content,
    metadata: {},
    createdAt: now,
    updatedAt: now
  };
}
