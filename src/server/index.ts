import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { resolve } from "node:path";
import { RunEventBus } from "../kernel/event-bus";
import { Kernel, KernelError } from "../kernel/kernel";
import { createDefaultProviderRegistry } from "../providers/registry";
import { SQLiteStore } from "../store/sqlite";
import type { CreateRunRequest, RunEvent } from "../shared/types";

const port = Number(process.env.PORT || 8787);
const dbPath = resolve(process.cwd(), "data", "app.db");

const store = new SQLiteStore({ dbPath });
const eventBus = new RunEventBus();
const providers = createDefaultProviderRegistry(process.env);
const kernel = new Kernel({ store, eventBus, providers });
const app = express();

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, dbPath, time: new Date().toISOString() });
});

app.get("/api/sessions", (_req, res) => {
  res.json(kernel.listSessions());
});

app.post("/api/sessions", (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title : undefined;
  res.status(201).json(kernel.createSession(title));
});

app.get("/api/sessions/:id/messages", (req, res, next) => {
  try {
    res.json(kernel.listMessages(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:id/runs", (req, res, next) => {
  try {
    const body = req.body as Partial<CreateRunRequest> | undefined;
    const text = typeof body?.text === "string" ? body.text : "";
    const provider = typeof body?.provider === "string" ? body.provider : undefined;
    res.status(202).json(kernel.startRun(req.params.id, text, provider));
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:id/events", (req, res, next) => {
  try {
    const runId = req.params.id;
    kernel.getRun(runId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write("retry: 1000\n\n");

    const seenEventIds = new Set<string>();
    const send = (event: RunEvent): void => {
      if (seenEventIds.has(event.id) || res.writableEnded) {
        return;
      }
      seenEventIds.add(event.id);
      res.write(`id: ${event.seq}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = kernel.subscribeRunEvents(runId, send);
    for (const event of kernel.listRunEvents(runId)) {
      send(event);
    }

    const ping = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": ping\n\n");
      }
    }, 15_000);

    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/runs/:id/cancel", (req, res, next) => {
  try {
    res.json(kernel.cancelRun(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof KernelError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : "Unknown error";
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({ error: message });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Agent platform prototype server listening on http://127.0.0.1:${port}`);
  console.log(`SQLite database: ${dbPath}`);
});
