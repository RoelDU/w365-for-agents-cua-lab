import type { CallContext, HandoffStatusPayload } from "@/types/contracts";

export class OrchestratorError extends Error {
  status?: number;
  cause?: unknown;
  /** The upstream response body (or its `details`/`error` field), surfaced so a bare
   * HTTP 502 reveals its real reason (e.g. "Could not start the Foundry agent run"). */
  details?: string;
  constructor(message: string, opts?: { status?: number; cause?: unknown; details?: string }) {
    super(message);
    this.name = "OrchestratorError";
    this.status = opts?.status;
    this.cause = opts?.cause;
    this.details = opts?.details;
  }
}

/**
 * Reads an error response body and extracts the most useful human-readable detail.
 * Prefers a JSON `details`/`error`/`message` field; otherwise falls back to raw text.
 * Never throws - returns undefined if the body is empty or unreadable.
 */
async function readErrorDetails(response: Response): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return undefined;
  }
  const text = raw.trim();
  if (!text) return undefined;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const field = body.details ?? body.error ?? body.message;
    if (typeof field === "string" && field.trim()) return field.trim();
  } catch {
    // Not JSON - use the raw text (clamped so a giant HTML error page can't flood the toast).
  }
  return text.slice(0, 500);
}

export interface PostHandoffResult {
  request_id: string;
  status: "queued" | "prefilled" | "ready" | "submitted" | "error";
  /** Durable handoff id minted by the orchestrator backend. The browser holds
   * this and polls `/handoff/{handoff_id}/status`; the backend owns the Direct
   * Line conversation, watermark, and token. Replaces the old thread_id/run_id
   * pair (the browser no longer touches the agent transport). */
  handoff_id?: string;
  status_url?: string;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function postHandoff(
  baseUrl: string,
  payload: CallContext,
  init: RequestInit = {}
): Promise<PostHandoffResult> {
  const url = joinUrl(baseUrl, "/handoff");
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      ...init
    });
  } catch (err) {
    throw new OrchestratorError(
      `Could not reach orchestrator at ${url} (${err instanceof Error ? err.message : "network error"}).`,
      { cause: err }
    );
  }
  if (!response.ok) {
    const details = await readErrorDetails(response);
    throw new OrchestratorError(
      `Orchestrator at ${url} returned HTTP ${response.status}${details ? `: ${details}` : "."}`,
      { status: response.status, details }
    );
  }
  const body = (await response.json().catch(() => ({}))) as Partial<PostHandoffResult>;
  return {
    request_id: body.request_id ?? payload.request_id,
    status: body.status ?? "queued",
    handoff_id: body.handoff_id,
    status_url: body.status_url
  };
}

export interface GetHandoffStatusOptions {
  init?: RequestInit;
}

export async function getHandoffStatus(
  baseUrl: string,
  handoffId: string,
  opts: GetHandoffStatusOptions = {}
): Promise<HandoffStatusPayload> {
  const path = `/handoff/${encodeURIComponent(handoffId)}/status`;
  const url = joinUrl(baseUrl, path);
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    ...(opts.init ?? {})
  });
  if (!response.ok) {
    const details = await readErrorDetails(response);
    throw new OrchestratorError(
      `Orchestrator at ${url} returned HTTP ${response.status}${details ? `: ${details}` : "."}`,
      { status: response.status, details }
    );
  }
  return (await response.json()) as HandoffStatusPayload;
}

/**
 * Best-effort health check. Returns true if the orchestrator's `/health`
 * responds with 2xx within `timeoutMs`. Drives the footer status dot.
 */
export async function pingOrchestrator(
  baseUrl: string,
  timeoutMs = 1500
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = joinUrl(baseUrl, "/health");
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
