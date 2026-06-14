# Agent Platform Prototype

Local-first experiment for an agent platform kernel. It is intentionally a single repo, but the source tree keeps boundaries between `client`, `server`, `kernel`, `providers`, `store`, and `shared`.

## Stack

- TypeScript
- React + Vite
- Express local API server
- SQLite via `better-sqlite3`
- Server-Sent Events for run streaming
- Provider adapters: mock and OpenAI-compatible `/chat/completions`

## Setup

```bash
npm install
cp .env.example .env # optional; mock works without an API key
npm run dev
```

- Client: http://127.0.0.1:5173
- Server: http://127.0.0.1:8787
- SQLite DB: `data/app.db` (created on server start)

## Scripts

```bash
npm run dev          # client + server
npm run dev:server   # Express server only
npm run dev:client   # Vite client only
npm run typecheck    # TypeScript check
```

## API

- `GET /api/health`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id/messages`
- `POST /api/sessions/:id/runs` body `{ "text": "...", "provider": "mock" | "openai-compatible" }`
- `GET /api/runs/:id/events` SSE stream
- `POST /api/runs/:id/cancel`

If `OPENAI_API_KEY` is missing, or the requested provider is `mock`, the kernel uses the mock streaming provider. To try an OpenAI-compatible endpoint, set:

```env
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

Then send runs with provider `openai-compatible` from the UI selector or API.

## Architecture

```text
React UI
  -> Express API
  -> Kernel
      -> ProviderAdapter (mock/openai-compatible)
      -> StoreAdapter (SQLite)
```

The kernel deals in store/provider interfaces and an event bus. SQLite details live under `src/store`; provider HTTP/SSE parsing lives under `src/providers`.

## Notes

- The event log is append-only in `events`.
- `messages` and `message_parts` are the current read projection used to restore sessions after reload/reopen.
- This is a prototype: no auth, no migration framework, no production build serving, and no multi-process run coordination.
