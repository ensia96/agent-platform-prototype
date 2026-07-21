import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { RunEventBus } from "../src/kernel/event-bus";
import { Kernel } from "../src/kernel/kernel";
import type { ProviderRegistry } from "../src/providers/registry";
import type { ProviderAdapter, ProviderCredential, ProviderRunContext, ProviderRunInput } from "../src/providers/types";
import { toolSettingsSettingKey } from "../src/shared/tool-settings";
import type { JsonObject, ProviderProfile, ProviderTestResponse, RunEvent, RunEventType, ToolSettings } from "../src/shared/types";
import { SQLiteStore } from "../src/store/sqlite";
import { ToolRegistry } from "../src/tools/registry";

type Scenario = "allow" | "approve" | "deny";

async function runScenario(scenario: Scenario): Promise<string> {
  const workingDirectory = mkdtempSync(join(tmpdir(), `agent-platform-kernel-${scenario}-`));
  try {
    const store = new SQLiteStore({ dbPath: ":memory:", defaultWorkingDirectory: workingDirectory });
    const eventBus = new RunEventBus();
    const executedCwds: string[] = [];
    const tools = createFakeToolRegistry(executedCwds);
    const provider = new ScriptedToolProvider(scenario, workingDirectory);
    const kernel = new Kernel({
      store,
      eventBus,
      providers: createFakeProviderRegistry(provider),
      tools,
      toolExecutionCwd: workingDirectory
    });
    store.setSetting(toolSettingsSettingKey, toolSettingsFor(scenario), new Date().toISOString());

    const session = kernel.createSession({ title: scenario, workingDirectory });
    const created = kernel.startRun(session.id, `run ${scenario}`);

    if (scenario === "allow") {
      await waitForRunStatus(kernel, created.run.id, "completed");
    } else {
      await waitForRunStatus(kernel, created.run.id, "waiting_permission");
      const [request] = kernel.listPermissionRequests("pending");
      assert.ok(request, `${scenario}: permission request missing`);

      if (scenario === "approve") {
        const response = await kernel.approvePermissionRequest(request.id);
        assert.equal(response.state, "executed");
        assert.equal(response.result?.status, "completed");
      } else {
        const response = kernel.denyPermissionRequest(request.id);
        assert.equal(response.state, "denied");
        assert.equal(response.result?.status, "failed");
      }
      await waitForRunStatus(kernel, created.run.id, "completed");
    }

    const events = kernel.listRunEvents(created.run.id);
    assertIncreasingEventSequence(events, scenario);
    assertScenarioEventOrder(events, scenario);
    assertMessagePartOrder(kernel.listMessages(session.id), created.run.id, scenario);

    if (scenario === "deny") {
      assert.deepEqual(executedCwds, [], "deny: denied tool must not execute");
    } else {
      assert.deepEqual(executedCwds, [workingDirectory], `${scenario}: session workingDirectory must be the default tool cwd`);
    }

    const assistantMessages = kernel
      .listMessages(session.id)
      .filter((message) => message.runId === created.run.id && message.role === "assistant");
    assert.equal(assistantMessages.length, 2, `${scenario}: follow-up assistant message missing`);
    assert.match(assistantMessages[1].parts.map((part) => part.text).join(""), new RegExp(`follow-up:${scenario}`));
    assert.equal(provider.turns, 2, `${scenario}: provider follow-up turn missing`);
    return `${scenario}(${events.length} events)`;
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

class ScriptedToolProvider implements ProviderAdapter {
  readonly id = "fake-tool-provider";
  readonly label = "Fake tool-loop provider";
  turns = 0;

  constructor(
    private readonly scenario: Scenario,
    private readonly expectedWorkingDirectory: string
  ) {}

  async test(profile: ProviderProfile, _credential: ProviderCredential): Promise<ProviderTestResponse> {
    const checkedAt = new Date().toISOString();
    return {
      ok: true,
      profile,
      status: profile.status,
      message: "fake provider",
      checkedAt
    };
  }

  async run(input: ProviderRunInput, context: ProviderRunContext) {
    this.turns += 1;
    assert.equal(input.context.workingDirectory, this.expectedWorkingDirectory);

    if (this.turns === 1) {
      return {
        toolCalls: [
          {
            id: `call-${this.scenario}`,
            name: "shell_exec",
            arguments: { command: `fake-${this.scenario}` }
          }
        ]
      };
    }

    const syntheticContext = input.context.messages
      .filter((message) => message.source === "synthetic")
      .map((message) => message.content)
      .join("\n");
    assert.match(syntheticContext, /\[tool result · (completed|failed)\]/, `${this.scenario}: tool result was not re-injected`);
    if (this.scenario !== "deny") {
      assert.match(syntheticContext, new RegExp(`stdout:${escapeRegExp(this.expectedWorkingDirectory)}`));
    }
    await context.writer.writeDelta(`follow-up:${this.scenario}`);
    return { toolCalls: [] };
  }
}

function createFakeProviderRegistry(adapter: ProviderAdapter): ProviderRegistry {
  const profile: ProviderProfile = {
    id: "mock",
    name: "Fake tool-loop provider",
    type: "mock",
    vendor: "local",
    runtime: "mock",
    authMode: "none",
    billingSource: "local",
    source: "builtin",
    enabled: true,
    status: {
      state: "available",
      message: "fake provider",
      credentialStatus: "not_required"
    }
  };

  return {
    resolveRun(selection: { provider?: string; providerProfileId?: string }) {
      return {
        adapter,
        profile,
        credential: {},
        providerResolution: {
          requestedProvider: selection.provider ?? null,
          requestedProviderProfileId: selection.providerProfileId ?? null,
          providerProfileId: profile.id,
          providerProfileName: profile.name,
          providerType: profile.type,
          fallback: null
        }
      };
    }
  } as unknown as ProviderRegistry;
}

function createFakeToolRegistry(executedCwds: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      id: "shell.exec",
      name: "Fake Shell",
      description: "Fake shell tool for kernel smoke tests.",
      source: "builtin",
      inputSchema: {},
      outputSchema: {},
      metadata: {}
    },
    executor: {
      validateInput(input, context) {
        const command = typeof input.command === "string" ? input.command : "";
        const cwdValue = typeof input.cwd === "string" ? input.cwd.trim() : "";
        const cwd = cwdValue ? (isAbsolute(cwdValue) ? resolve(cwdValue) : resolve(context.cwd, cwdValue)) : context.cwd;
        return { command, cwd };
      },
      toPublicInput(input) {
        return input;
      },
      async execute(input, context) {
        const cwd = String(input.cwd);
        executedCwds.push(cwd);
        await context.emit({
          invocationId: context.invocation.id,
          toolId: context.invocation.toolId,
          type: "tool.stdout.delta",
          createdAt: new Date().toISOString(),
          payload: { text: `stdout:${cwd}` }
        });
        return {
          exitCode: 0,
          stdout: `stdout:${cwd}`,
          stderr: "",
          durationMs: 1,
          timedOut: false,
          cwd,
          stdoutTruncated: false,
          stderrTruncated: false
        };
      }
    }
  });
  return registry;
}

function toolSettingsFor(scenario: Scenario): ToolSettings & JsonObject {
  return {
    defaultAction: scenario === "allow" ? "allow" : "ask",
    denyPatternsText: "",
    askPatternsText: "",
    allowPatternsText: "",
    shell: {
      defaultTimeoutMs: 1_000,
      maxTimeoutMs: 5_000,
      maxOutputChars: 4_000
    }
  };
}

async function waitForRunStatus(kernel: Kernel, runId: string, status: "completed" | "waiting_permission"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = kernel.getRun(runId);
    if (run.status === status) {
      return;
    }
    if (run.status === "failed" || run.status === "cancelled") {
      throw new Error(`Run ${runId} reached ${run.status}: ${run.error ?? "unknown error"}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Run ${runId} did not reach ${status}.`);
}

function assertIncreasingEventSequence(events: RunEvent[], scenario: Scenario): void {
  assert.ok(events.length > 0, `${scenario}: no events recorded`);
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].seq > events[index - 1].seq, `${scenario}: event sequence is not increasing`);
  }
}

function assertScenarioEventOrder(events: RunEvent[], scenario: Scenario): void {
  const commonBeforePermission: RunEventType[] = ["run_started", "tool_call.created"];
  const followUp: RunEventType[] = ["tool_result.created", "assistant_message_updated", "assistant_message_created", "delta", "run_completed"];
  if (scenario === "allow") {
    assertOrdered(events, [...commonBeforePermission, "tool.started", "tool.stdout.delta", "tool.completed", ...followUp], scenario);
    return;
  }
  if (scenario === "approve") {
    assertOrdered(
      events,
      [...commonBeforePermission, "permission.requested", "run_waiting_permission", "permission.approved", "tool.started", "tool.stdout.delta", "tool.completed", ...followUp],
      scenario
    );
    return;
  }
  assertOrdered(
    events,
    [...commonBeforePermission, "permission.requested", "run_waiting_permission", "permission.denied", ...followUp],
    scenario
  );
  assert.equal(events.some((event) => event.type === "tool.started"), false, "deny: denied tool unexpectedly started");
}

function assertOrdered(events: RunEvent[], expected: RunEventType[], scenario: Scenario): void {
  const types = events.map((event) => event.type);
  let priorIndex = -1;
  for (const type of expected) {
    const index = types.indexOf(type, priorIndex + 1);
    assert.notEqual(index, -1, `${scenario}: missing event ${type}`);
    priorIndex = index;
  }
}

function assertMessagePartOrder(messages: ReturnType<Kernel["listMessages"]>, runId: string, scenario: Scenario): void {
  const toolMessage = messages.find(
    (message) => message.runId === runId && message.role === "assistant" && message.parts.some((part) => part.type === "tool_call")
  );
  assert.ok(toolMessage, `${scenario}: tool message missing`);
  const toolPartTypes = toolMessage.parts
    .filter((part) => part.type === "tool_call" || part.type === "command_output" || part.type === "tool_result")
    .map((part) => part.type);
  assert.deepEqual(toolPartTypes, ["tool_call", "command_output", "tool_result"], `${scenario}: message part order changed`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const summaries = [];
for (const scenario of ["allow", "approve", "deny"] as const) {
  summaries.push(await runScenario(scenario));
}

console.log(`Kernel smoke passed: ${summaries.join(", ")}`);
