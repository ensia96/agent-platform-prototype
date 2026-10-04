import type { JsonObject } from "./types";
import { redactPublicSecrets } from "./public-text";

export interface ChildProgressPart { id: string; messageId: string; type: string; text: string; content: JsonObject }
function bounded(value: string, limit: number): string {
  const safe = redactPublicSecrets(value);
  return safe.length <= limit ? safe : `${safe.slice(0,Math.floor(limit/2))}\n[bounded progress]\n${safe.slice(-Math.floor(limit/2))}`;
}
const string = (object: JsonObject, key: string) => typeof object[key] === "string" ? object[key] as string : "";

/** Facts only: no LLM call, no reasoning, and no full child transcript copied to the parent. */
export function childProgressSummary(runId: string, status: string, parts: ChildProgressPart[]): string {
  const assistantText = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const calls = parts.filter((p) => p.type === "tool_call");
  const results = calls.map((call) => ({call,result:parts.find((p) => p.messageId === call.messageId && p.type === "tool_result" && p.content.callId === call.content.callId)}));
  const outcome = (item: typeof results[number]) => string(item.result?.content ?? item.call.content,"status");
  const counts = {completed:0,failed:0,cancelled:0,unfinished:0};
  for (const item of results) {
    const value = outcome(item);
    if (value === "completed" || value === "failed" || value === "cancelled") counts[value]++;
    else counts.unfinished++;
  }
  const last = results.at(-1);
  const completed = [...results].reverse().find((item) => outcome(item) === "completed");
  const outputParts = completed ? parts.filter((p) => p.messageId === completed.call.messageId && p.type === "command_output" && p.content.callId === completed.call.content.callId) : [];
  const output = outputParts.map((p) => string(p.content,"text") || p.text).join("\n");
  return [
    status === "completed" ? "Child status: completed." : `Child ended: ${status}. Partial progress below is not a successful completion.`,
    `Tool progress: completed=${counts.completed}; failed=${counts.failed}; cancelled=${counts.cancelled}; unfinished=${counts.unfinished}.`,
    last ? bounded(`Last tool: ${string(last.call.content,"toolId")} · ${outcome(last)} · message=${last.call.messageId} · part=${last.call.id}`,400) : "Tools: none recorded.",
    completed ? bounded(`Last completed tool: ${string(completed.call.content,"toolId")} · ${string(completed.result?.content ?? {},"outputSummary")} · message=${completed.call.messageId}`,500) : "",
    output ? `Last completed output:\n${bounded(output,1200)}` : "",
    assistantText ? bounded(assistantText,3500) : "Assistant answer: none. This does not imply that no tools ran.",
    `Source child Run: ${runId}`
  ].filter(Boolean).join("\n");
}
