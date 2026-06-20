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

If the pid file is stale, `status` reports it clearly and removes stale pid/metadata when safe. `stop` sends `SIGTERM`, waits for the server to close, and avoids force-killing on timeout.

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
- `GET /api/agents` returns persisted agent definitions; the default is `main`
- `GET /api/agents/:id` returns one agent definition
- `PATCH /api/agents/:id` updates safe agent fields such as `name`, `systemPrompt`, `modelProfileId`, `defaultRunOptions`, `skillIds`, and `toolIds` (no credential/token storage)
- `POST /api/context/preview` body `{ "sessionId": "...", "agentId": "main", "providerProfileId": "mock", "text": "optional current input", "runOptions": { ... } }`
- `POST /api/sessions/:id/context/preview` previews the provider-neutral context for a session without starting a run
- `GET /api/providers` returns provider profiles, status, and the default profile id
- `POST /api/providers/:id/test` tests a provider profile without storing secrets
- `POST /api/providers/openai-chatgpt/auth/start` starts the experimental ChatGPT/Codex device authorization flow
- `POST /api/providers/openai-chatgpt/auth/poll` body `{ "attemptId": "..." }` polls/completes that device authorization flow
- `POST /api/providers/openai-chatgpt/logout` removes the local ChatGPT OAuth credential file
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id/messages`
- `POST /api/sessions/:id/runs` body `{ "text": "...", "agentId": "main", "providerProfileId": "mock" | "openai-compatible" | "openai-chatgpt", "runOptions": { "model": "...", "reasoningEffort": "minimal" | "low" | "medium" | "high" | "xhigh", "temperature": 0.2 } }`
- `GET /api/runs/:id/events` SSE stream
- `POST /api/runs/:id/cancel`

The OpenAI-compatible profile is env-backed. Only the credential reference (`env:OPENAI_API_KEY`) is surfaced through the API/UI; the API key value is read by the server process at runtime and is not stored in SQLite.

If `OPENAI_API_KEY` is missing, the default provider profile is `mock`. If a run explicitly requests `openai-compatible` without a key, the kernel falls back to mock and includes fallback metadata in the run response and `run_started` event. To try an OpenAI-compatible endpoint, set:

```env
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

Then send runs with provider profile `openai-compatible` from the UI selector or API. Use `GET /api/providers` or the Settings → Providers panel to inspect profile status and run a `/models` connection test.

### Run options and usage visibility

Chat runs accept optional `runOptions` (or legacy-compatible `options`) for model override, reasoning effort, and temperature. Provider support is intentionally conservative:

- `openai-compatible`: model override and temperature are sent to `/chat/completions`; reasoning effort is recorded in run metadata only unless a future profile capability explicitly supports it.
- `openai-chatgpt`: model override is sent to the experimental ChatGPT/Codex payload; reasoning effort and temperature are currently metadata-only/unsupported to avoid breaking the known-good backend contract.
- `mock`: options are accepted for UI/API consistency but are not sent to a model runtime.

If a provider response or stream includes usage metadata, the daemon normalizes and stores available `inputTokens`, `outputTokens`, `reasoningTokens`, and `totalTokens`, then displays them in the Chat UI. The prototype does **not** store or render raw chain-of-thought/thinking text; only provider-reported usage/reasoning token counts or future provider-provided summaries should be surfaced.

### Structured messages and tool event model

Messages are no longer limited to a single text projection. `message_parts` keeps a backward-compatible `text` fallback and can also store structured `content_json` plus safe `metadata_json` for these part types:

- `text`
- `error`
- `reasoning_summary` (sanitized summary/usage metadata only; no raw thinking)
- `tool_call`
- `tool_result`
- `command_output`
- `file_ref`

The run event log remains append-only and now reserves event names for future tool and permission runtime flow: `tool_call.created`, `tool_call.updated`, `tool_call.delta`, `tool.started`, `tool.stdout.delta`, `tool.stderr.delta`, `tool.completed`, `tool.failed`, `tool_result.created`, `permission.requested`, `permission.approved`, and `permission.denied`.

This is only the container for future capabilities. Shell execution, MCP connections, skill manifests, permission approval UI, and subagents are intentionally not implemented yet. Structured payloads and metadata must stay sanitized: API keys, OAuth tokens, credential material, and raw chain-of-thought must not be stored in message parts or events.

### Context Builder and main agent

Every run now passes through a provider-neutral Context Builder before the provider adapter is called. The builder combines:

- the selected session and text message history (`messages`/`message_parts`)
- the selected `AgentDefinition` (defaults to `main`)
- the agent system prompt
- provider profile selection and effective run options
- optional current, unsent input for preview requests

The output is a `BuiltContext`/canonical context with `agent`, `systemPrompt`, `messages`, structured safe context part summaries, `runOptions`, `providerProfileId`, and metadata. Text parts are included as before. `tool_result`, `command_output`, and `file_ref` parts have conservative text conversion rules so they can later be re-injected into model context; error parts, failed tool results, tool calls without results, and reasoning metadata are skipped by default. Provider adapters then translate that context into their native request shape: OpenAI-compatible receives a chat `system` message plus context messages, while the experimental ChatGPT/Codex adapter maps the system prompt to `instructions` and text history to `input`.

The default agent is persisted in SQLite `agent_definitions`:

```text
id: main
name: Mango
```

Edit it in Settings → Main Agent or with:

```bash
curl -X PATCH http://127.0.0.1:8787/api/agents/main \
  -H 'Content-Type: application/json' \
  -d '{"name":"Mango","systemPrompt":"You are Mango, a helpful local assistant. Be concise and safe."}'
```

Use the Chat tab's **Context Preview** button to inspect the system prompt, text messages, and effective run options that would be sent for the selected session/agent/provider. Preview responses never include API keys, OAuth tokens, or credential values.

Tools, skills, files, MCP, permissions, and subagents are intentionally not implemented yet. `AgentDefinition`, structured message parts, reserved run events, and `BuiltContext` keep the slots needed for those control-plane layers to be added later without changing the provider contract again.

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

OAuth access/refresh tokens are written only to `.agent-platform/credentials/openai-chatgpt.json` with `0600` file permissions. The SQLite DB stores no token values; API/UI responses expose only `credentialRef=file:openai-chatgpt` and status such as `needs_auth`, `connected`, `expired`, or `error`. If the access token expires, test/run attempts refresh it with the stored refresh token and rewrites the credential file.

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
      -> agent_definitions and app_settings JSON
```

The kernel deals in store/provider interfaces, the provider-neutral context builder, and an event bus. SQLite details live under `src/store`; provider HTTP/SSE parsing lives under `src/providers`.

## Dashboard

The React UI has two tabs:

- `Chat`: existing session/run streaming flow
- `Settings`: daemon status, main agent/system prompt editor, provider profiles with credential presence, OpenAI ChatGPT OAuth connect/disconnect, connection tests, adapter registry placeholders (`opencode`, `claude-code`, `codex`, `gemini-cli`), and a small stored setting editor

## Notes

- The event log is append-only in `events`.
- `messages` and structured `message_parts` are the current read projection used to restore sessions after reload/reopen.
- `agent_definitions` stores the default `main` agent and future agent rows; it must not contain API keys, OAuth tokens, or credential material.
- `provider_profiles` exists as a raw SQLite table for future user-managed profiles. Current env secrets and OAuth token values are never written there.
- `.agent-platform/` contains local runtime pid/metadata/log/credential files and is ignored by git.
- This is a prototype: no auth, no migration framework, and no multi-process run coordination.

## Next TODO

- Add a safe `restart` lifecycle command if it becomes necessary.
- Promote provider profiles from env/builtin records to user-managed persisted records.
- Validate the experimental `openai-chatgpt` runtime against a real ChatGPT/Codex subscription login and adjust the request/stream payload if OpenAI changes the backend contract.
- Add token counting/trimming and explicit context budget controls to the Context Builder.
- Add real shell tools, MCP providers, skills, permission gates, files, and subagents on top of the structured message/event container.
- Add adapter install/status flows behind dashboard APIs.
