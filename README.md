# Agent Platform Prototype

Local-first experiment for an agent platform daemon. The intended shape is a single local process that acts as both:

- runtime core server for sessions, runs, providers, store, events, and future adapters
- web dashboard host for chat, settings, provider profiles, adapter registry, diagnostics, and control-plane UI

During development the React dashboard still runs through Vite and proxies `/api` to the Express daemon. The prototype daemon lifecycle is intentionally just package-script power switches: `start`, `status`, and `stop`. Provider/adapters/settings operations should move into the web dashboard rather than expanding CLI surface area.

## Stack

- TypeScript
- React + Vite
- Express local API server
- SQLite via `better-sqlite3`
- Server-Sent Events for run streaming
- Provider profiles: built-in mock, env-backed OpenAI-compatible `/chat/completions`, and experimental OpenAI ChatGPT/Codex OAuth

## Setup

```bash
npm install
cp .env.example .env # optional; mock works without an API key
npm run dev
```

- Client: http://127.0.0.1:5173
- Server: http://127.0.0.1:8787
- SQLite DB: `data/app.db` (created on server start)
- Runtime daemon files: `.agent-platform/` (created by `npm run start`, ignored by git)

## Scripts

```bash
npm run dev        # development mode: Vite dashboard + watched Express server
npm run dev:server # watched Express server only
npm run dev:client # Vite dashboard only
npm run build      # build the React dashboard into dist/client
npm run start      # build dashboard, then start the local daemon in the background
npm run status     # check daemon.pid and GET /api/status
npm run stop       # send SIGTERM and clean daemon pid/metadata after exit
npm run typecheck  # TypeScript check
npm run smoke:agent-profiles # profile CRUD/session binding/run snapshot/tool-allowlist fixtures (no real provider calls)
npm run smoke:context-budget # context capability/estimate/plan/trimming fixtures (no real provider calls)
npm run smoke:interrupt     # run lease/cancel/restart/recovery/SSE/permission/provider/tool interruption fixtures
npm run smoke:model-catalog # provider model parser/cache/request fixtures (no real provider calls)
npm run smoke:reasoning     # reasoning payload/stream/persistence fixtures
```

The same scripts work with Yarn:

```bash
yarn dev
yarn start
yarn status
yarn stop
```

`npm run dev` / `yarn dev` is the development mode: Vite serves the dashboard at http://127.0.0.1:5173 and proxies `/api` to the watched Express server at http://127.0.0.1:8787.

`npm run start` / `yarn start` first builds the dashboard into `dist/client`, then runs `tsx src/server/index.ts` as a detached background daemon. In daemon mode the Express server hosts both `/api/*` and the built dashboard, so open http://127.0.0.1:8787 in your browser after start.

The daemon writes runtime state under `.agent-platform/`:

```text
.agent-platform/
  daemon.pid
  daemon.json
  credentials/openai-chatgpt.json
  logs/daemon.log
```

If the pid file is stale, `status` reports it clearly and removes stale pid/metadata when safe. `stop` sends `SIGTERM`, waits for the server to close, and avoids force-killing on timeout. Independently of the pid file, the SQLite database contains an exclusive daemon lease: a second process cannot serve or reconcile the same DB while its owner is live. The lease heartbeat is refreshed every five seconds, and takeover requires both a heartbeat older than 15 seconds and a dead recorded local PID.

Useful environment variables:

- `PORT`: daemon API port (default `8787`)
- `AGENT_PLATFORM_DB_PATH` or `DB_PATH`: override SQLite path (default `data/app.db`)
- `OPENAI_API_KEY`: optional API key for the env-backed OpenAI-compatible profile
- `OPENAI_BASE_URL`: optional OpenAI-compatible base URL (default `https://api.openai.com/v1`)
- `OPENAI_MODEL`: optional chat model (default `gpt-4o-mini`)
- `OPENAI_CHATGPT_MODEL`: optional experimental ChatGPT/Codex model (default `gpt-5.5`)
- `OPENAI_CHATGPT_ENDPOINT`: optional experimental ChatGPT/Codex endpoint override (default `https://chatgpt.com/backend-api/codex/responses`)
- `OPENAI_CHATGPT_AUTH_ISSUER`: optional auth issuer override (default `https://auth.openai.com`)
- `OPENAI_CHATGPT_DEBUG=1`: optional sanitized runtime diagnostics for request shape and provider failures; OAuth tokens/account values are redacted

## API

- `GET /api/health`
- `GET /api/status`
- `GET /api/settings`
- `PATCH /api/settings` body JSON object, stored in SQLite `app_settings` as key/value JSON
- `GET /api/tool-settings` returns the user-configurable shell permission policy and built-in shell timeout/output settings
- `PATCH /api/tool-settings` updates Tool Settings after server-side JavaScript RegExp and shell numeric setting validation
- `GET /api/agents` returns persisted agent definitions; the default is `main`
- `GET /api/agents/:id` returns one agent definition
- `POST /api/agents` creates a profile from `name`, `systemPrompt`, optional `description`, `modelProfileId`, `defaultRunOptions`, `contextPolicy`, `skillIds`, `toolIds`, and sanitized user metadata
- `PATCH /api/agents/:id` updates safe profile fields and requires `expectedRevision` in the body. A real change advances the revision; an empty/no-op patch does not. A stale draft returns `409 agent_revision_conflict` with only the latest safe ID/name/revision/timestamp summary
- `POST /api/agents/:id/clone` body `{ "expectedRevision": 3 }` creates an independent copy with a unique name
- `DELETE /api/agents/:id` body `{ "expectedRevision": 3 }` deletes an unused non-main profile. `main` is protected, and a profile referenced by sessions returns `409 agent_in_use` with safe session IDs/titles
- `POST /api/context/preview` body `{ "sessionId": "...", "agentId": "main", "providerProfileId": "mock", "text": "optional current input", "runOptions": { ... } }`
- `POST /api/sessions/:id/context/preview` previews the provider-neutral context for a session without starting a run
- `GET /api/providers` returns provider profiles, credential/status details, and the default profile id
- `GET /api/providers/:id/models` returns the canonical model catalog; add `?refresh=1` to bypass a valid cached result. Responses use `Cache-Control: no-store`
- `POST /api/providers/:id/test` tests a provider profile without storing secrets
- `POST /api/providers/openai-chatgpt/auth/start` starts the experimental ChatGPT/Codex device authorization flow
- `POST /api/providers/openai-chatgpt/auth/poll` body `{ "attemptId": "..." }` polls/completes that device authorization flow
- `POST /api/providers/openai-chatgpt/logout` removes the local ChatGPT OAuth credential file
- `GET /api/tools` returns registered tool definitions. The only built-in tool today is `shell.exec`
- `GET /api/permissions?status=pending` returns tool permission requests, primarily pending manual shell approvals
- `POST /api/permissions/:id/approve` approves a pending permission request and runs the stored invocation
- `POST /api/permissions/:id/deny` denies a pending permission request without running the stored invocation
- `GET /api/sessions`
- `POST /api/sessions` body optional `{ "title": "...", "workingDirectory": "/absolute/project/path", "agentId": "..." }`; omitted `agentId` binds the new session to `main`, and omitted `workingDirectory` uses the daemon-compatible default home directory
- `GET /api/sessions/:id`
- `PATCH /api/sessions/:id` accepts `workingDirectory` and/or `agentId`. The profile binding persists in SQLite; changing it affects future runs only
- `GET /api/sessions/:id/messages`
- `GET /api/sessions/:id/runs` returns public persisted run summaries; add `?active=1` for `running`, `waiting_permission`, and `cancelling` only
- `GET /api/sessions/:id/runs/active` is the explicit active-run form of the same public-summary query used by dashboard recovery
- `POST /api/sessions/:id/tools/shell.exec` body `{ "command": "echo hello", "cwd": "optional", "timeoutMs": 60000 }` preserves the original synchronous contract by default: an allowed invocation waits and returns `200` with its final result, while ask/deny decisions return immediately. Add `?async=1` to opt into cancellable execution; an allowed invocation then returns `202` with `state: "running"`, and the returned public run is followed through SSE and cancelled through the normal run cancel endpoint. The dashboard uses this async form. `cwd` is optional; when omitted, the session `workingDirectory` is used. Relative `cwd` values resolve from the session `workingDirectory`; absolute values resolve as-is. `timeoutMs` is optional; when omitted, Tool Settings `shell.defaultTimeoutMs` is used.
- `POST /api/sessions/:id/runs` body `{ "text": "...", "agentId": "optional-explicit-override", "providerProfileId": "optional-explicit-override", "runOptions": { "model": "...", "reasoningEffort": "provider-defined-value", "temperature": 0.2 } }`. Agent resolution is explicit override → session binding → `main`; a session with existing active work returns `409` with `error=active_run_exists` and its public run summary
- `GET /api/runs/:id` returns a public run summary
- `GET /api/runs/:id/events` SSE stream; `?after=<non-negative-seq>` and `Last-Event-ID` resume strictly after a persisted event sequence. On native reconnect, a valid `Last-Event-ID` takes precedence over the original query. An active stream whose initial cursor is ahead of storage emits a named `run_cursor` transport event with the canonical latest `id`; native EventSource remembers that id while the dashboard's run-event reducer ignores the named control event. A terminal run with no later event still returns `204` before SSE headers.
- `POST /api/runs/:id/cancel` requests cancellation and returns the latest public run summary
- `POST /api/runs/:id/resume` resumes a run that is waiting for already-resolved tool permission

The OpenAI-compatible profile is env-backed. Only the credential reference (`env:OPENAI_API_KEY`) is surfaced through the API/UI; the API key value is read by the server process at runtime and is not stored in SQLite.

Run lookup/list, start/resume/cancel, manual-tool, permission, and replay responses use explicit public projections. Public run summaries allow only identifiers, provider/status, model/run options, usage, current phase, timestamps, and sanitized error. Public messages retain display content and usage but remove internal message/part metadata; provider resolution omits base URLs and credential references. Raw execution input and internal command metadata/context/credentials are excluded. A sanitized user-visible command may still be shown because permission approval and the tool timeline require it.

If `OPENAI_API_KEY` is missing, the default provider profile is `mock`. When starting new work, an explicit `openai-compatible` request without a key falls back to mock and includes fallback metadata in the run response and `run_started` event. An already-created run never uses that fallback during resume; it fails explicitly if its saved provider can no longer be resolved exactly. To try an OpenAI-compatible endpoint, set:

```env
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

Then send runs with provider profile `openai-compatible` from the UI selector or API. Use `GET /api/providers` or the Settings → Providers panel to inspect profile status and run a `/models` connection test.

### Provider model catalogs

The Chat Run Inspector lazily loads models only for the selected provider. Settings → Providers does not call model endpoints automatically; use **Load models** or **Refresh models** on a provider card. Exact provider model IDs are preserved rather than normalized or guessed.

- `openai-compatible`: requests `GET {baseUrl}/models` and exposes valid `data[].id`, `owned_by`, and `created` fields. The standard `/models` response does not declare chat compatibility, reasoning support, or a context window, so those capabilities remain unknown; model names are never used to guess them.
- `openai-chatgpt`: requests the experimental internal `GET https://chatgpt.com/backend-api/codex/models?client_version=<local-adapter-version>` endpoint with the same OAuth/account headers as the Codex runtime. Entries whose backend visibility is exactly `list` are exposed as suggestions ordered by advertised priority. Reasoning choices are enabled only for an exact catalog match. Positive integer `context_window`/`max_context_window` values are accepted as provider-reported capability; when both exist, the smaller value is used conservatively because the unsupported backend semantics may change.
- `mock`: returns its single built-in model and an adapter-verified 32,768-token context window without network access.

Successful remote catalogs are cached in memory for five minutes. Concurrent callers share one request; `refresh=1` bypasses a valid cached result. A failed refresh returns the last successful catalog as `stale`, or the configured default model as a `configured-only` fallback when no successful result exists. Cache entries are invalidated after ChatGPT connect/reconnect/logout. Raw provider error bodies, credentials, and unrecognized backend fields are not copied into the canonical API response.

### Run cancellation, daemon shutdown, and restart

Runs use compare-and-set lifecycle transitions. An explicit `POST /api/runs/:id/cancel` moves an active run to `cancelling`, expires any pending permission for that run, and aborts the shared provider/tool signal. The run becomes `cancelled` after active work exits, including when daemon shutdown overlaps an explicit cancel. A shutdown-only interruption becomes `interrupted`. Terminal run state, streaming assistant-message state, pending tool-call cleanup, pending-permission expiry, and the one terminal event are committed together, so a late provider/tool completion cannot overwrite termination or append a second terminal event. Cancelling an already-terminal run is an idempotent no-op.

Closing a browser tab, switching sessions, or losing an SSE connection only removes or pauses that event subscription; it does not cancel daemon work. On load and session selection, the dashboard discovers persisted active runs, rebuilds that run's messages from canonical event sequence zero, and reconnects with sequence cursors thereafter. Waiting-permission and usage changes emit complete assistant-message snapshots, so replay includes pending tool status, command-output placeholders, safe metadata shape, and usage without a separate message fetch. Transient EventSource failures show `reconnecting` while native retry continues. Only the explicit Cancel control calls the cancel API.

New work is limited to one active run per session (`running`, `waiting_permission`, or `cancelling`) inside the SQLite create transaction. If legacy data contains more than one active run, the dashboard clearly warns and tracks the most recently updated run rather than silently choosing an arbitrary row; after it terminates, discovery runs again. Cancel is best-effort and cannot roll back provider, command, filesystem, or network effects that already completed.

On graceful daemon shutdown, running work receives an interruption signal and is given a bounded period to exit. Startup reconciliation runs only after the process has acquired the exclusive DB lease and successfully started listening. Persisted `running` and `cancelling` rows left by an ungraceful stop are then finalized as `interrupted`; pending permissions attached to any already-terminal legacy run are expired. A valid `waiting_permission` run and its pending request remain intact so the user can resolve or cancel them after restart.

Cancellation is cooperative outside the built-in shell executor and cannot undo provider requests, filesystem writes, network calls, or other side effects that already happened. `shell.exec` sends SIGTERM to the spawned POSIX process group, waits briefly, then sends SIGKILL to the group; Windows uses a best-effort child-process fallback. This stops local work but still cannot roll back effects produced before termination.

### Run options and usage visibility

Chat runs accept optional `runOptions` (or legacy-compatible `options`) for model override, reasoning effort, and temperature. Provider support is intentionally conservative:

- `openai-compatible`: model override and temperature are sent to `/chat/completions`; reasoning effort is recorded in run metadata only and is not sent because the standard catalog does not advertise a compatible request contract.
- `openai-chatgpt`: model override, `reasoning.summary: "auto"`, and a selected advertised reasoning effort are sent to the experimental ChatGPT/Codex payload. An empty selection omits `reasoning.effort`; `none` is sent explicitly. Temperature remains unsupported.
- `mock`: options are accepted for UI/API consistency but are not sent to a model runtime.

Reasoning effort is a validated provider-defined string rather than a closed application enum (non-empty after trimming, at most 64 characters, and no control characters). The run-level picker only offers efforts advertised for the exact selected ChatGPT/Codex model and clears an incompatible run override when the provider/model changes; persisted Profile values are retained with a warning instead of being silently deleted.

When a run explicitly overrides the Agent Profile's provider with a different provider profile, provider-specific Agent defaults (`model`, `reasoningEffort`, and `temperature`) are not inherited. Explicit per-run options still apply, followed by the override provider's defaults. Settings and Run Inspector retain saved catalog values but warn when a model or reasoning effort is not currently advertised.

If a provider response or stream includes usage metadata, the daemon normalizes and stores available `inputTokens`, `outputTokens`, `reasoningTokens`, and `totalTokens`, then displays them in the Chat UI.

`openai-chatgpt` maps explicit Responses-style provider summary and reasoning-text events to `reasoning_summary` (**추론 요약**) and `reasoning_detail` (**추론 상세**) parts. Either part may be absent when the provider omits it, and both are excluded from subsequent model context. `openai-compatible` records reported reasoning-token usage but does not map non-standard fields such as `reasoning_content`; generic analysis/thinking events and opaque or encrypted reasoning artifacts are not stored as reasoning parts.

### Structured messages and tool event model

Messages are no longer limited to a single text projection. `message_parts` keeps a backward-compatible `text` fallback and can also store structured `content_json` plus safe `metadata_json` for these part types:

- `text`
- `error`
- `reasoning_summary` (explicit provider summary plus sanitized provenance/usage)
- `reasoning_detail` (explicit provider-visible reasoning text plus sanitized provenance/usage)
- `tool_call`
- `tool_result`
- `command_output`
- `file_ref`

The run event log remains append-only and now uses/reserves event names for tool and permission runtime flow: `tool_call.created`, `tool_call.updated`, `tool_call.delta`, `tool.started`, `tool.stdout.delta`, `tool.stderr.delta`, `tool.completed`, `tool.failed`, `tool_result.created`, `permission.requested`, `permission.approved`, `permission.denied`, `run_waiting_permission`, `run_cancelling`, and terminal `run_interrupted`.

Structured payloads and metadata must stay sanitized: API keys, OAuth tokens, credential material, and raw chain-of-thought must not be stored in message parts or events.

### Built-in `shell.exec` tool

`shell.exec` is the first real tool. It can be invoked manually from the debug Shell Tool panel/API and is also exposed to model providers as a single canonical function tool (`shell_exec`) when the run's Agent Profile explicitly includes `shell.exec`.

Input:

```json
{ "command": "echo hello", "cwd": "optional/path", "timeoutMs": 60000 }
```

Output records `exitCode`, `stdout`, `stderr`, `durationMs`, `timedOut`, and truncation flags. The executor uses Node `child_process.spawn` with `shell: true`, stores stdout/stderr deltas as tool events, and writes `tool_call`, `command_output`, and `tool_result` message parts to the session. Output is size-limited before persistence. Timeout remains a failed tool result with `timedOut: true`; an external run cancellation is recorded as a cancelled tool result.

The current agent tool loop is intentionally minimal and only supports this one provider-facing tool, but the kernel treats tool use as a normal capability of an agent run. If a model emits a `shell_exec` tool call, the kernel maps it back to canonical `shell.exec`, first enforces the run snapshot's Agent Profile hard allowlist, then evaluates Tool Settings permission, executes or denies the invocation, injects the resulting tool output back into context, and calls the model again. A provider cannot bypass an empty profile allowlist by emitting an unadvertised tool call. There is no core tool-iteration cap; long-running loops are controlled through user cancel/interruption and the permission flow rather than by a fixed kernel limit.

The default cwd is the session `workingDirectory`. New sessions and legacy DB rows without a stored value default to the user's home directory to preserve the prototype daemon's previous shell behavior. cwd is treated as execution context, not a Tool Settings value: omitted cwd uses the session `workingDirectory`, relative cwd resolves from it, and absolute cwd resolves as-is. There is no home-subtree hard deny; cwd is only checked for existence and directory type. `shell.exec` still runs real local commands in your environment, so avoid commands that print secrets or mutate important files unless you intend that.

### Tool Settings regex permission policy and built-in shell settings

Manual and model-requested `shell.exec` calls pass through the user-configurable **Tool Settings** policy before execution. Tool Settings are stored in SQLite `app_settings` under `toolSettings` and can be edited in Settings → Tool Settings or through `GET/PATCH /api/tool-settings`.

```ts
{
  defaultAction: "allow" | "ask" | "deny";
  denyPatternsText: string;
  askPatternsText: string;
  allowPatternsText: string;
  shell: {
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    maxOutputChars: number;
  };
}
```

- `defaultAction` applies when no pattern matches. `allow` runs immediately, `ask` creates a pending permission request, and `deny` blocks without execution. For model-requested tool calls, allow/deny results are fed back to the model; ask moves the run to `waiting_permission` until approval/denial resolves it.
- Agent Profile `toolIds` and Tool Settings are separate layers: `toolIds` is the hard model-tool capability boundary, while this global policy decides allow/ask/deny for allowed model calls and manual operator calls. Profile `toolIds` never blocks the manual tool API.
- Per-profile allow/ask/deny rules are intentionally not implemented yet; they require a future generic permission-policy interface that can also cover file and MCP operations.
- Pattern text fields are stored as multiline text exactly as entered.
- Before saving and before command evaluation, the server splits lines, trims each line, ignores empty lines and lines starting with `#`, and validates each remaining line with `new RegExp(line)`.
- Evaluation order is **Deny → Ask → Allow → Default**.
- Use `.*` to match every command.
- Only JavaScript regular expressions are supported for now. Glob patterns such as `*` are not supported yet.
- `shell.defaultTimeoutMs` is used when an invocation omits `timeoutMs`.
- `shell.maxTimeoutMs` is a local stability ceiling; invocation timeout overrides above it fail validation.
- `shell.maxOutputChars` limits captured stdout/stderr per stream before persistence.
- These shell settings are for the built-in `shell.exec` tool only. Custom tool packages keep their own defaults and behavior; the kernel does not expose common `executionDefaults` or `configurable` fields for registered tools.

Example:

```text
# ask before package and git mutations
^npm\s+install\b
^git\s+push\b
```

Permission activity is stored in SQLite `permission_requests` and recorded in the run event log as `permission.requested`, `permission.approved`, and `permission.denied`. The table keeps the raw pending invocation server-side so approval can run the original command, while API/UI surfaces use the sanitized public input/summary.

When a model-requested permission is approved or denied, the approval API records the tool result and automatically resumes the run. `POST /api/runs/:id/resume` exists as a manual fallback for a waiting run after all pending permissions have already been resolved.

This permission layer is **not a security sandbox**. It is a user-configurable guardrail for the prototype. Approved commands still execute with the daemon process's local user privileges; keep using the tool carefully.

### Agent Profiles, session binding, and immutable run snapshots

Every run now passes through a provider-neutral Context Builder before the provider adapter is called. The builder combines:

- the selected session and text message history (`messages`/`message_parts`)
- the resolved `AgentDefinition` (explicit run override → persisted session binding → `main`)
- the agent system prompt
- canonical available tools (`shell.exec` as provider function `shell_exec` for the main agent by default)
- provider profile selection and effective run options
- optional current, unsent input for preview requests
- the current session `workingDirectory`, which is appended to the system/runtime context so the model can see the default execution path

The output is a `BuiltContext`/canonical context with `agent`, `systemPrompt`, `workingDirectory`, `messages`, `availableTools`, structured safe context part summaries, `runOptions`, `providerProfileId`, and metadata. Text parts are included as before. `tool_result`, `command_output`, and `file_ref` parts have conservative text conversion rules so they can later be re-injected into model context; error parts, failed tool results, tool calls without results, and reasoning parts are skipped by default. During a live tool loop, the kernel adds synthetic tool-result context for the in-progress assistant message so the provider can produce the final answer. Provider adapters are responsible for translating this context and `availableTools` into their native request shape, and for converting provider-native tool/function-call responses back into canonical tool-call events. OpenAI-compatible receives a chat `system` message plus context messages and native function tools, while the experimental ChatGPT/Codex adapter maps the system prompt to `instructions`, text history to `input`, and tools to its experimental function schema.

Agent Profiles are persisted in SQLite `agent_definitions`; each session stores its selected profile in `sessions.agent_id`. New and migrated sessions default to `main`. Settings → Agent Profiles supports create, clone, edit, and guarded delete, while Chat → Run Inspector changes the current session binding. Profile provider/model/options become defaults rather than hidden per-session React state:

1. provider/model/run-option override supplied for this run
2. Agent Profile default, only when the effective provider matches the profile provider
3. effective provider/application default

At run creation, the kernel stores an internal versioned snapshot containing the resolved profile ID/revision, system prompt, exact resolved provider profile ID, effective model/options, skill IDs, and tool IDs. Provider follow-up turns and permission resume use the persisted effective values without recomputing current provider defaults, even if the profile, provider default, or session binding changes later. Resume resolves that exact saved provider identity; a missing/disabled provider, unavailable credential, or missing adapter fails the run rather than silently switching to mock or another provider. Credential values are never snapshotted. Future runs use the latest profile revision. Legacy runs without a snapshot use their recorded/current profile as an explicit compatibility fallback and record that fallback internally. Internal snapshots and system prompts are excluded from public run, event, and message projections.

Agent updates and guarded deletes use revision compare-and-set. The Settings editor sends the revision on which its draft is based, preserves the draft on conflict, locks relevant controls during mutations, and asks before discarding dirty edits on profile/refresh/tab changes. Session cwd and Agent binding updates write and merge only their own fields so reverse HTTP completion order cannot restore a stale sibling field.

### Context capability, estimation, and deterministic trimming

Before preview or run creation, the same runtime resolution path lazily loads the exact provider catalog and resolves the usable context window in this order:

1. Agent Profile `contextWindowTokensOverride` (`user`)
2. exact provider catalog report (`provider`)
3. adapter-verified capability such as mock (`adapter`)
4. conservative 16,384-token instance assumption (`assumed`)

Successful catalogs use a five-minute in-memory TTL. If refresh later fails, the last-good provider value remains usable with `capabilityStale=true`; a cold cache/catalog failure falls through to an adapter value or the assumption without guessing from the model name. Consequently, clicking **Load models** in Settings cannot change runtime planning. The assumed value is a safety policy, not a claim about an unknown model. Agent Profiles may also override reserved output tokens and the safety-margin ratio. The output reserve only reduces the planner's input budget: it is not a provider output cap, and adapters do not send one unless a separate supported option is implemented. A reserve plus margin that consumes the window fails preview/run preflight as `invalid_context_policy`. Automatic summary/compaction is intentionally not part of this phase.

The deterministic `conservative-utf8-v1` estimator separates provider-neutral content from provider-native overhead. Neutral content covers the complete runtime/system prompt, projected message text, tool schemas, current input, and tool/command output. Each adapter supplies credential-free static wrapper/message/tool-envelope overhead; ChatGPT also declares its required default Codex instructions. OpenAI-compatible's fixed native overhead is explicitly the sum of transport framing and one mandatory native system-message wrapper, while subsequent message role wrappers use the per-message component. Tool schemas are estimated once as content plus their native envelope. The estimator uses UTF-8 size plus code/punctuation/line density; estimates are not guaranteed to equal provider tokenizer usage. The input budget is:

```text
context window - reserved output - safety margin
```

The planner groups persisted history into finalized atomic user-led turns and selects only a contiguous newest suffix. Once a newest-to-oldest scan reaches a turn that cannot fit, that turn and every older turn are omitted, preventing chronological holes. A completed assistant finalizes a historical turn; user-only failed/interrupted attempts are explicitly omitted without consuming a recent-completed slot, and orphan/streaming/failed assistants are excluded. The current run's user input is always required.

System/current/tool-schema context and the complete ordered active tool call/result chain are required. Every provider follow-up and permission resume performs a full replan: newly active results are deterministically head/tail bounded first, then compressible historical suffix turns are removed as needed. Historical command output is projected once by `callId`: `command_output` owns raw output while its `tool_result` contributes status/summary only. The same projection is estimated and sent. SQLite/UI originals are unchanged. If required input alone does not fit, the API returns typed `context_budget_exceeded` before creating a run rather than silently truncating it.

Context Preview exposes safe candidate kinds/source IDs/estimates, window source/staleness, content/native-overhead totals, output reserve, safety margin, input budget, suffix watermark/boundaries, included/omitted reasons, estimator version, and trimming state. The actual run uses that same planner. Run-level metadata alone owns one initial full context snapshot and bounded immutable `ContextPlanRecord` entries for each provider turn/tool iteration/resume; the first record is the initial plan, and the latest record is the context sent on the latest provider turn. Records contain IDs, estimates, and reasons but no raw context. Assistant message metadata stores only local state/references and never duplicates the run snapshot or plans. Public run summaries use the latest record and identify its plan/provider-turn/tool-iteration. Recognizable HTTP or top-level/nested SSE provider overflow responses are classified as `context_length_exceeded` without exposing the raw error body; this phase does not automatically retry or summarize.

### Context segments and automatic compaction

A Session remains one logical conversation. Context compaction does not create a new Session or use future parent/child Sub-session semantics. Instead, every Session owns exactly one active `ContextSegment`; sealed segments retain their original Messages, Runs, Parts, and Events for local audit. New and migrated Sessions receive ordinal-zero active segments, and Message/Run rows carry their physical segment ID.

When the pre-trim estimate reaches 82% of the input budget or deterministic trimming is required, `ContextPlan.compactionRecommended` records the reason. Agent Profiles default to automatic compaction unless `automaticCompaction` is explicitly disabled. After the main provider answer, and before that run becomes terminal, the kernel may summarize only an old finalized contiguous prefix. It always preserves at least two recent completed turns plus the current/in-flight run. Manual **Compact now** is available only with no active run or permission request.

Compaction reuses the selected exact provider/model through a tool-free internal collector. Its structured prompt requests goals, decisions, constraints, current implementation/files, validation, open work, and important tool results. Input includes the previous completed cumulative summary plus only the newly selected prefix; provider reasoning, credentials, and raw payloads are not persisted. Source projections use the same command/tool-output deduplication as normal context. Oversized source input is reduced at whole-turn boundaries, and no omitted turn is sealed. Output is rejected when empty, tool-calling, over 12,000 characters, or conservatively over 3,072 estimated tokens.

After successful generation, one immediate SQLite transaction seals the source segment, writes the completed artifact, creates the next active segment, moves the preserved suffix/current Messages and Runs, updates `Session.activeSegmentId`, and links the artifact target. Active-segment/message membership and Session identity are checked again in that transaction, so concurrent runs or rotations cannot silently produce a hole. Failure, cancellation, shutdown, provider errors, malformed output, and CAS loss write at most a sanitized failed artifact and leave the current segment active. The already-produced main answer remains successful and future requests retain deterministic trimming fallback.

Run creation also uses `expectedActiveSegmentId`. Capability/catalog awaits may race with manual compaction, so the Store verifies the Session pointer and active Segment before creating a Run. The kernel replans once against the new active Segment before returning typed `context_segment_changed` on a second conflict. Once the Run exists it blocks external rotation; general Message creation additionally rejects sealed/foreign Segment writes and requires any referenced Run to belong to the same active Segment. Rotation verifies exact source+preserved Message and Run set equality, rejects duplicate/foreign IDs and split Runs, and validates artifact session/source/status/lineage.

Prefix classification does not let old terminal failures or orphan audit rows block progress. Successful user-led turns carry normal projected content; failed/cancelled/interrupted attempts carry user intent plus terminal status/sanitized error; standalone completed tool runs carry projected operation/status/result; corrupt completed orphan records are sealed as audit-only entries without raw content. Streaming/running/waiting/cancelling work remains a hard boundary. Artifact `sourceCategories` records the category, status, Run ID, and exact Message IDs for every sealed entry.

If a later Agent/model/window change makes an inherited summary itself exceed required input budget, Preview/Run returns typed `context_summary_exceeds_budget` with the artifact ID and does not silently call a provider. **Compact now** then performs summary-only recovery using the current Session provider/model: it sends only a deterministically reduced form of the previous completed summary, never all sealed raw messages, and atomically swaps the active Segment's inherited artifact through artifact/segment CAS. The recovery artifact preserves lineage via `previousArtifactId`; failure, cancellation, oversized output, or CAS loss leaves the previous inherited artifact active.

The next provider context consists of the latest completed cumulative `compaction_summary` artifact as protected required context plus only active-segment history/current tool-loop messages. Sealed source text is absent unless a user explicitly opens the local timeline accordion; reading old text in the UI does not reinclude it in model context. Segment/artifact APIs are no-store and expose public Messages, summary/source IDs, bounded estimates, strategy, provider/model, and usage without internal run metadata.

Provider catalog last-good capability cache is intentionally memory-only in this phase. After daemon restart, catalog failure cannot claim a stale provider value: resolution falls back to adapter capability or the explicitly marked 16,384-token assumption and emits the existing assumed-capability warning. Model names are never guessed. Every artifact retains its creation-time resolved window/source snapshot, and an inherited summary that no longer fits can use summary-only recovery.

Fresh databases seed `main` with `shell.exec` and `subsession.start`. The Store-owned `main_subsession_default_v1` migration adds delegation only to an existing `main` whose allowlist is exactly the old `["shell.exec"]` default. It increments revision when changed, preserves empty/custom lists and all other profiles, and runs exactly once via `schema_migrations`, not user-editable metadata. Revision covers all profile edits and cannot tell whether an identical shell-only list was explicitly chosen: this one-time migration intentionally treats that exact list as the legacy default under the approved default change. A later explicit shell-only or empty choice stays unchanged on restart. New custom profiles still default to no tools unless chosen by the user. The older implicit-empty-list migration retains its existing legacy compatibility behavior.

The protected default profile is seeded as:

```text
id: main
name: Mango
```

Edit it in Settings → Agent Profiles or with:

```bash
curl -X PATCH http://127.0.0.1:8787/api/agents/main \
  -H 'Content-Type: application/json' \
  -d '{"expectedRevision":1,"name":"Mango","systemPrompt":"You are Mango, a helpful local assistant. Be concise and safe."}'
```

Use the Chat tab's **Context Preview** button to inspect the system prompt, text messages, available model tools, and effective run options that would be sent for the selected session/agent/provider. Preview responses never include API keys, OAuth tokens, or credential values.

`skillIds` remain persisted placeholders only: there is no skill registry, injection, or loader in this MVP. Model tools currently include `shell.exec` and `subsession.start`. Steering, file tools and path policy, MCP, attachments, and SDK integration remain separate future work.

### Independent Sub-sessions

A **ContextSegment** is a temporal compression boundary inside a Session. A **Sub-session** is a separate child Session with its own Agent profile, transcript, active segment, and owned Run. Delegation never copies the parent's transcript or system prompt: only the explicit task (at most 12,000 characters) is submitted to the child. The child's working directory is copied from the parent's run-time cwd snapshot. **This is shared filesystem access, not a sandbox or file isolation.** There are no automatic worktrees.

Admitted child starts and later resumes use the Run's stored cwd even if the Session cwd is edited before execution or while waiting. Legacy Runs without a stored cwd fall back to current Session cwd, as on resume; new Runs also use current Session cwd. The execution view never rewrites the editable Session row.

`main` includes delegation by default. A root Session (no `parentSessionId`) may use **Start child session** when its Agent tool allowlist permits it. This is tool access, not an approval bypass. A child Session cannot delegate, regardless of its profile name or `toolIds`: its provider schema omits the tool, forged native calls are rejected by the Kernel, and the Store independently rejects child admissions. The provider name is `subsession_start`, with `{ agentId, task, title? }` arguments. A successful admission returns `{ delegationId, rootRunId, childSessionId, childRunId, status, capacity }` immediately and starts independent child execution without waiting for completion.

Every spawn requires explicit approval of the exact **target Agent revision, task, and target tool list**, even if global shell policy is `allow`. Regex policy applies only to shell commands; there is no generic file/permission framework. All existing profiles are eligible targets, but a changed/deleted target cannot pass an earlier approval. After admission, its immutable Agent/provider defaults snapshot is retained. Other tools use the child's chosen profile (not a parent/child intersection), subject to the root-only delegation rule; child shell approval is separate. There is no attach/detach/reuse of arbitrary child Sessions or steering input UI. Profile CRUD and profile-based tool access are unchanged in this stage.

Each **owning root Run** may have at most **four unfinished child tasks**; the root is excluded. Admission in progress, `running`, `waiting_permission`, `waiting_children`, and `cancelling` all reserve capacity. A child returns capacity only when its Run is terminal—not when a provider Promise yields, permission is requested, or abort is signalled. This is not a Session-lifetime or cumulative Run limit: after a terminal child, fifth/sixth/later admissions may succeed.

**There is no automatic execution queue or FIFO dispatcher.** At capacity, the admission transaction throws `subsession_capacity_exhausted` with safe `limit`, `active`, `available`, and active child handles. It creates no child Session, Run, or work row. The structured failure is projected back into the model's tool result. Successful handles and result handoffs also include current capacity, so the root can wait and decide whether to request more work. Approval and resume use the existing single-flight execution paths directly. The existing pending provider-tool batch behind a permission gate is not a child execution queue.

Admission is transactional and idempotent on `(parentRunId, invocationId)`: root identity, running owner/active segment, target revision and unfinished-child count are checked before committing the child Session/segment, reserved Run, task/snapshot and ownership. Cancellation during provider capability resolution cannot execute an unowned late Run. Starting the admitted Run continues to enforce active segment CAS and one-active-Run-per-Session invariants.

The parent can emit an intermediate answer but cannot settle while children are unfinished or results have not been delivered to a provider turn. It enters active nonterminal **`waiting_children`**. Child completion/failure/cancellation/interruption commits a bounded result in the same transaction as the child's terminal status; startup also reconciles terminal children and message-less interrupted admissions. Wake requests coalesce and only transition waiting parents at a safe boundary. Child results never bypass `waiting_permission` and never create overlapping parent provider calls.

A result is materialized transactionally as one canonical `tool_result` handoff part containing child Session/Run references, terminal status, and bounded text (roughly 6,000 characters). Generic tools do not create fake `command_output` parts. The same handoff projection is used in the active provider loop, later history, and compaction. Delivery is acknowledged after the parent provider turn returns. A crash after handoff materialization but before provider return may repeat that provider request on restart; it does not duplicate the handoff part. **This is durable admission/delivery deduplication, not exactly-once external model/tool execution.** Side-effect tool calls are never automatically replayed on restart.

The bounded child result now includes deterministic progress facts: terminal status, completed/failed/cancelled/unfinished tool counts, last tool/source references, last completed output when available, and any assistant answer/partial text. No assistant answer is explicitly distinguished from no tool execution. Recognizable credentials are redacted before bounding, and cancellation never adds a summary/model request. Raw child history is not merged into the parent. An asynchronous child completion is a provenance-bearing user notification in the parent context, **not a second native result for the earlier `subsession_start` call**.

Root Cancel cancels its owned unfinished children; child Cancel leaves siblings and unrelated/future Runs alone. A small ownership cleanup traversal remains only for legacy nested relations—it cannot admit or schedule recursive work. Late results remain auditable without resurrecting terminal parents. **Cancel never requests an additional LLM summary.** Existing partial text is retained and its bounded handoff explicitly says cancelled/interrupted rather than implying success. Choosing a child to interrupt/adjust via root-interpreted user instructions is future Steering work, not implemented here.

Browser/SSE disconnection does not cancel work. On graceful shutdown, waiting parents/permissions persist; executing work is interrupted. Startup after the daemon lease reconciles children and wakes parents from the **durable result inbox**, which is retained and distinct from the removed execution queue. Tools are not blindly replayed.

For development databases created by the earlier recursive/FIFO drafts, `subsessions-root-only-schema-v3` only installs needed admission/audit columns. After the lease, the one-time `subsessions-root-only-v3` startup reconciliation marks legacy queued Runs and nonterminal nested descendant Runs interrupted, expires pending approvals, cancels active tool-call states and appends terminal events. Old Session/Run/delegation relations, raw message content, original events and any existing `subsession_work` audit rows are retained; no queued approval/task is resumed. Fresh databases do not create `subsession_work`, and there is no queue-v2 creation/dispatch code. The common runtime has no `queued` state; the client ignores immutable old queue notifications rather than restoring that state. Legacy direct children already above the new limit block further admission until enough become terminal.

The root session list excludes children. The conversation's compact **자식 작업** section shows child status/result delivery and opens child conversations; child conversations link back to their parent. The existing active-run discovery, SSE replay, reconnect, Cancel, and approval APIs remain in use. `GET /api/sessions/:id/subsessions` is `no-store` and returns safe references/status/bounded results, never internal run metadata, credentials, or profile snapshots.

The child panel is adjacent to the chat header, outside the scrolling transcript and independent of Inspector visibility. Its pending-approval badge stays visible; new relevant permissions expand the compact panel. It shows bounded child name/task, status, tool/input summary, risk/reason, and child-only Approve/Deny/Cancel actions. These actions are scoped to exact parent Run → child Session/Run → permission IDs and do not replace the parent's messages, active Run, SSE connection, provider/model, or context. Session/navigation generations invalidate stale responses, and resolved permission IDs cannot be resurrected by an older poll. A 409 triggers a canonical refresh. Approval means the request was handled, not that the child has completed.

Run `npm run smoke:subsessions` for local fake-provider tests, including `scripts/subsessions-admission-smoke.ts`: root-only schema/forged-call denial, four unfinished reservations, fifth rejection without rows, fifth/sixth success after terminals, permission/cancel accounting, cwd snapshots, non-replaying legacy upgrades, migration defaults, handoff integrity, API redaction and UI guards/SSR. No actual provider account is needed. Fixed orchestrator/worker specifications, capability flags and Profile CRUD simplification are later stages, not implemented here; Steering remains unimplemented.

### Provider adapter tool translation

- `openai-compatible`: sends Chat Completions `tools` with `tool_choice: "auto"`, parses streaming native calls, and replays each complete batch as `assistant.tool_calls` followed by `role: "tool"` messages with matching `tool_call_id`. Pre-tool assistant text and exact native arguments are retained. It tracks reasoning-token usage but does not map `reasoning_content` to a reasoning part.
- `openai-chatgpt`: sends experimental Codex Responses-style schemas and replays complete batches as original `function_call` items plus `function_call_output` items with exact `call_id`. The optional original native item ID is retained separately from runtime invocation IDs. Provider-supplied visible reasoning summary/detail are still handled separately; opaque/encrypted reasoning continuation is not invented or replayed. Additional requirements of particular live Codex backends remain unverified.
- `mock`: text-only; it does not synthesize tool calls and otherwise keeps existing chat behavior.

The kernel does not centrally decide whether a provider "supports tools". It always passes `BuiltContext.availableTools` to the selected adapter, executes any canonical tool calls the adapter returns, and treats provider/backend incompatibility as an adapter/provider error path.

Modern live continuation is reconstructed from persisted canonical parts, including raw native argument JSON, native call/name IDs and provider-batch identity. Permission-split batches are paired before the next provider call; pending/unmatched calls are not injected. Deny/error results are explicit outputs. Missing native IDs fail before execution, and repeated IDs fail rather than executing the same call again. Large runtime IDs use collision-resistant internal keys without changing the native ID replayed to the provider.

Each provider response owns a distinct assistant message. A permission resume completes the message holding the remaining old-batch calls/results before creating the next response writer. Persisted `providerResponseBatchId` identifies its assistant text. Child handoffs are input notifications and replay before the response/verification calls that consumed them, even though streaming text retains storage sequence zero; display ordering follows the same input-before-response rule without rewriting stored parts. Legacy mixed-batch rows replay every batch when text ownership is known (or no text needs attribution). Ambiguous text ownership or unresolved calls in mixed rows fail with `ambiguous_native_tool_batches` rather than silently omitting calls or inventing ordering. Legacy source rows are not automatically rewritten.

`BuiltContext` carries a provider-neutral `toolExchange` for complete active batches. The planner counts its content and per-call/result native envelopes, not an additional readable synthetic copy. Output bounding preserves call IDs, arguments, pairing and ordering; required overflow remains a typed failure. Old rows lacking native fields keep explicit readable compatibility context, and completed historical turns/compaction use their projected summaries. No silent provider retry loop was added.

`npm run smoke:native-continuation` exercises both real adapters against strict localhost fake HTTP/SSE servers (allow/approve/deny/error, multiple calls/iterations, SQLite permission resume, child completion notifications, malformed arguments and invalid IDs). The fake returns a final answer only when native outputs contain the actual tool sentinel and correct IDs/arguments. This closes the prior text-only mock gap; it does **not** prove that a live model will never repeat a request. Browser E2E and live-provider behavior remain separate manual verification tasks.

### Experimental OpenAI ChatGPT/Codex OAuth profile

`openai-chatgpt` is a separate OpenAI provider channel from `openai-compatible`:

| Profile | Runtime/channel | Auth | Billing/quota source |
| --- | --- | --- | --- |
| `openai-compatible` | OpenAI-compatible `/chat/completions` | `OPENAI_API_KEY` env var | OpenAI Platform API credits/billing |
| `openai-chatgpt` | ChatGPT/Codex backend (`https://chatgpt.com/backend-api/codex/responses`) | OAuth device authorization via `auth.openai.com` | ChatGPT/Codex consumer subscription quota |

This path is experimental and may break if OpenAI changes the ChatGPT/Codex backend, OAuth device endpoints, required headers, model availability, or policy. It does **not** scrape browser cookies or read web session tokens; it only uses the OAuth/device flow.

To connect:

1. Start the daemon/dev server.
2. Open Settings → Providers → OpenAI ChatGPT.
3. Click **Connect**.
4. Open the returned verification URL and enter the displayed user code.
5. Click **Poll / Complete** until the status becomes connected.
6. Select `OpenAI ChatGPT` in the Chat provider selector and run a message.

OAuth access/refresh tokens are written only to `.agent-platform/credentials/openai-chatgpt.json` with `0600` file permissions. The SQLite DB stores no token values; API/UI responses expose only `credentialRef=file:openai-chatgpt` and status such as `needs_auth`, `connected`, `expired`, or `error`. If the access token expires, test/run attempts refresh it with the stored refresh token and rewrite the credential file. Refresh HTTP work has its own bounded timeout; cancelling a run stops that run from waiting for a shared refresh without aborting refresh work that another caller may still need.

If `openai-chatgpt` is selected before connecting, the run fails explicitly with an auth-required error. It does not silently fall back to mock. Failed assistant messages expose the stored run/provider error instead of only showing `failed`.

## Architecture

```text
Package scripts
  -> local daemon lifecycle only: start/status/stop

Browser dashboard
  -> Express daemon API/SSE
  -> Kernel
      -> ContextBuilder (AgentDefinition + system prompt + message history + run options)
      -> ProviderRegistry (env/file-backed profiles, credential resolution, fallback metadata)
      -> ProviderAdapter (mock/openai-compatible/openai-chatgpt)
      -> StoreAdapter (SQLite)
      -> agent_definitions, session agent bindings, run snapshots, and app_settings JSON
```

The kernel deals in store/provider interfaces, the provider-neutral context builder, and an event bus. SQLite details live under `src/store`; provider HTTP/SSE parsing lives under `src/providers`.

## Dashboard

The React UI has two tabs:

- `Chat`: persisted Session Agent binding, run-level provider/model/effort overrides, existing run streaming, agent tool-call/result rendering, pending shell permission approvals, and a debug/manual Shell Tool panel for `shell.exec`
- `Settings`: Agent Profile create/clone/edit/delete, provider/model defaults and hard model-tool allowlists, daemon status, global Tool Settings, provider profiles with credential presence, manual model catalog load/refresh, OpenAI ChatGPT OAuth connect/disconnect, connection tests, adapter registry placeholders (`opencode`, `claude-code`, `codex`, `gemini-cli`), and a small stored setting editor

## Notes

- The event log is append-only in `events`.
- Tool permission decisions are stored in `permission_requests`; Tool Settings are a user-configurable guardrail and should not be treated as a sandbox.
- `messages` and structured `message_parts` are the current read projection used to restore sessions after reload/reopen.
- `agent_definitions` stores the protected `main` profile and user-created Agent Profiles; it must not contain API keys, OAuth tokens, or credential material.
- `provider_profiles` exists as a raw SQLite table for future user-managed profiles. Current env secrets and OAuth token values are never written there.
- `.agent-platform/` contains local runtime pid/metadata/log/credential files and is ignored by git.
- One live daemon owns a SQLite DB through the `daemon_lease` row before startup reconciliation. This is local single-owner protection, not distributed or multi-host run coordination.
- This is a prototype with no auth and no general migration framework; narrowly scoped named schema migrations protect compatibility invariants such as the legacy main-tool transition.

## Next TODO

- Add a safe `restart` lifecycle command if it becomes necessary.
- Promote provider profiles from env/builtin records to user-managed persisted records.
- Validate the experimental `openai-chatgpt` runtime against a real ChatGPT/Codex subscription login and adjust the request/stream payload if OpenAI changes the backend contract.
- Add token counting/trimming and explicit context budget controls to the Context Builder.
- Add Steering, skills, file tools, message/turn lifecycle, MCP, attachments, and SDK support as separate follow-up work.
- Add adapter install/status flows behind dashboard APIs.
