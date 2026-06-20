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
- Provider profiles: built-in mock and env-backed OpenAI-compatible `/chat/completions`

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
  logs/daemon.log
```

If the pid file is stale, `status` reports it clearly and removes stale pid/metadata when safe. `stop` sends `SIGTERM`, waits for the server to close, and avoids force-killing on timeout.

Useful environment variables:

- `PORT`: daemon API port (default `8787`)
- `AGENT_PLATFORM_DB_PATH` or `DB_PATH`: override SQLite path (default `data/app.db`)
- `OPENAI_API_KEY`: optional API key for the env-backed OpenAI-compatible profile
- `OPENAI_BASE_URL`: optional OpenAI-compatible base URL (default `https://api.openai.com/v1`)
- `OPENAI_MODEL`: optional chat model (default `gpt-4o-mini`)

## API

- `GET /api/health`
- `GET /api/status`
- `GET /api/settings`
- `PATCH /api/settings` body JSON object, stored in SQLite `app_settings` as key/value JSON
- `GET /api/providers` returns provider profiles, status, and the default profile id
- `POST /api/providers/:id/test` tests a provider profile without storing secrets
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id/messages`
- `POST /api/sessions/:id/runs` body `{ "text": "...", "providerProfileId": "mock" | "openai-compatible" }`
- `GET /api/runs/:id/events` SSE stream
- `POST /api/runs/:id/cancel`

The initial OpenAI-compatible profile is env-backed. Only the credential reference (`env:OPENAI_API_KEY`) is surfaced through the API/UI; the API key value is read by the server process at runtime and is not stored in SQLite.

If `OPENAI_API_KEY` is missing, the default provider profile is `mock`. If a run explicitly requests `openai-compatible` without a key, the kernel falls back to mock and includes fallback metadata in the run response and `run_started` event. To try an OpenAI-compatible endpoint, set:

```env
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

Then send runs with provider profile `openai-compatible` from the UI selector or API. Use `GET /api/providers` or the Settings → Providers panel to inspect profile status and run a `/models` connection test.

## Architecture

```text
Package scripts
  -> local daemon lifecycle only: start/status/stop

Browser dashboard
  -> Express daemon API/SSE
  -> Kernel
      -> ProviderRegistry (env-backed profiles, credential resolution, fallback metadata)
      -> ProviderAdapter (mock/openai-compatible)
      -> StoreAdapter (SQLite)
      -> app_settings key/value JSON
```

The kernel deals in store/provider interfaces and an event bus. SQLite details live under `src/store`; provider HTTP/SSE parsing lives under `src/providers`.

## Dashboard

The React UI has two tabs:

- `Chat`: existing session/run streaming flow
- `Settings`: daemon status, provider profiles with credential presence and connection tests, adapter registry placeholders (`opencode`, `claude-code`, `codex`, `gemini-cli`), and a small stored setting editor

## Notes

- The event log is append-only in `events`.
- `messages` and `message_parts` are the current read projection used to restore sessions after reload/reopen.
- `provider_profiles` exists as a raw SQLite table for future user-managed profiles. Current env secrets are never written there.
- `.agent-platform/` contains local runtime pid/metadata/log files and is ignored by git.
- This is a prototype: no auth, no migration framework, and no multi-process run coordination.

## Next TODO

- Add a safe `restart` lifecycle command if it becomes necessary.
- Promote provider profiles from env/builtin records to user-managed persisted records.
- Add adapter install/status flows behind dashboard APIs.
