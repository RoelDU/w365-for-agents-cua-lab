import express, { type Express, type Request, type Response } from "express";
import cors, { type CorsOptions } from "cors";
import type { OrchestratorConfig } from "./config";
import { HandoffStore } from "./store";
import { validateCallContext, validatePrefill, formatErrors } from "./schemas";
import { derivePrefill, writePrefill, clearOutFiles } from "./handoff";
import type { CallContext, HandoffStatusPayload } from "./types";

const HEARTBEAT_MS = 15000;

function corsOptions(config: OrchestratorConfig): CorsOptions {
  if (config.allowedOrigins === "*") {
    return { origin: true, methods: ["GET", "POST", "OPTIONS"] };
  }
  const allow = new Set([...config.allowedOrigins, "null"]);
  return {
    methods: ["GET", "POST", "OPTIONS"],
    origin(origin, callback) {
      // No Origin header (curl, same-origin, server-to-server) is always allowed.
      if (!origin || allow.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by ALLOWED_ORIGINS.`));
    }
  };
}

export interface AppContext {
  config: OrchestratorConfig;
  store: HandoffStore;
  listeningSince: string;
}

export function createApp(ctx: AppContext): Express {
  const { config, store } = ctx;
  const app = express();

  app.use(cors(corsOptions(config)));
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      handoff_dir: config.handoffDir,
      listening_since: ctx.listeningSince
    });
  });

  app.post("/handoff", async (req: Request, res: Response) => {
    const body = req.body as unknown;
    if (!validateCallContext(body)) {
      res.status(400).json({
        error: "Invalid CallContext payload.",
        details: formatErrors(validateCallContext)
      });
      return;
    }
    const ctxBody = body as CallContext;

    // Single-flight: the legacy app reads a fixed-name prefill.json, so only one
    // handoff may be in flight at a time. A re-post of the SAME id is allowed.
    const active = store.activeRequestId();
    if (active && active !== ctxBody.request_id) {
      res.status(409).json({
        error: "Another handoff is already in progress.",
        active_request_id: active
      });
      return;
    }

    const prefill = derivePrefill(ctxBody);
    if (!validatePrefill(prefill)) {
      res.status(500).json({
        error: "Derived prefill failed schema validation.",
        details: formatErrors(validatePrefill)
      });
      return;
    }

    try {
      await clearOutFiles(config);
      await writePrefill(config, prefill);
    } catch (err) {
      res.status(500).json({
        error: "Could not write prefill to the handoff folder.",
        details: err instanceof Error ? err.message : String(err)
      });
      return;
    }

    // Set state BEFORE responding so the desktop's immediate status/SSE poll
    // always finds the request.
    store.apply({
      request_id: ctxBody.request_id,
      status: "prefilled",
      policy_number: ctxBody.policy_number ?? undefined,
      timestamp: new Date().toISOString()
    });

    // The desktop keys its status polling on `handoff_id`. This orchestrator
    // uses the CallContext `request_id` as the durable handoff id (the file-drop
    // contract is single-flight, fixed-name), so the two are the same value and
    // `/handoff/{handoff_id}/status` resolves the request. Returning `handoff_id`
    // keeps the shared handoff contract identical across the MCS and Foundry backends.
    res.status(202).json({
      request_id: ctxBody.request_id,
      handoff_id: ctxBody.request_id,
      status: "prefilled",
      status_url: `/handoff/${encodeURIComponent(ctxBody.request_id)}/status`
    });
  });

  app.get("/handoff/:requestId/status", (req: Request, res: Response) => {
    const payload = store.get(req.params.requestId);
    if (!payload) {
      res.status(404).json({ error: `Unknown request_id ${req.params.requestId}.` });
      return;
    }
    res.json(payload);
  });

  app.get("/handoff/:requestId/stream", (req: Request, res: Response) => {
    const { requestId } = req.params;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const send = (payload: HandoffStatusPayload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Emit current state immediately so a late subscriber catches up.
    const current = store.get(requestId);
    if (current) send(current);

    const unsubscribe = store.subscribe(requestId, send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return app;
}
