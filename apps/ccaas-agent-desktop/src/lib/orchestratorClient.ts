import type { CallContext, HandoffStatusPayload, HandoffAcknowledgement } from "@/types/contracts";
import { validateHandoffAcknowledgement, validateHandoffStatus } from "./schemas";

export class OrchestratorError extends Error {
  status?: number;
  cause?: unknown;
  /** The upstream response body (or its `details`/`error` field), surfaced so a bare
   * HTTP 502 reveals its real reason (e.g. "Could not start the Foundry agent run"). */
  details?: string;
  fatal: boolean;
  constructor(message: string, opts?: { status?: number; cause?: unknown; details?: string; fatal?: boolean }) {
    super(message);
    this.name = "OrchestratorError";
    this.status = opts?.status;
    this.cause = opts?.cause;
    this.details = opts?.details;
    this.fatal = opts?.fatal ?? false;
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

export type PostHandoffResult = HandoffAcknowledgement;

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
  let body: unknown = await response.json();
  // The existing MCS service acknowledges only its handoff ID. Keep our original
  // request ID for status correlation, but never replace an ID the service sent.
  if (payload.target_backend !== "foundry" && body !== null && typeof body === "object" &&
      !("request_id" in body) && "handoff_id" in body &&
      typeof body.handoff_id === "string" && body.handoff_id.trim().length > 0) {
    body = { ...body, request_id: payload.request_id };
  }
  if (!validateHandoffAcknowledgement(body) || body.request_id !== payload.request_id) {
    throw new OrchestratorError("Invalid handoff acknowledgement or request ID does not match.", { fatal: true });
  }
  if (payload.target_backend === "foundry" && !body.execution_mode) {
    throw new OrchestratorError("Foundry endpoint did not identify simulation or live mode. Use the updated local bridge and runner.", { fatal: true });
  }
  return body;
}

export interface GetHandoffStatusOptions {
  init?: RequestInit;
  requestId?: string;
  executionMode?: "simulation" | "live" | null;
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
  const body: unknown = await response.json();
  if (!validateHandoffStatus(body)) {
    throw new OrchestratorError("Invalid handoff status response.", { fatal: true });
  }
  if (opts.requestId && body.request_id !== opts.requestId) {
    throw new OrchestratorError("Handoff status request ID does not match this interaction.", { fatal: true });
  }
  if (opts.executionMode && body.execution_mode !== opts.executionMode) {
    throw new OrchestratorError("Foundry execution mode changed or is missing in the status response.", { fatal: true });
  }
  return body;
}

/**
 * Best-effort health check. Returns true if the orchestrator's `/health`
 * responds with 2xx within `timeoutMs`. Drives the footer status dot.
 */
export async function pingOrchestrator(
  baseUrl: string,
  timeoutMs = 1500,
  backend?: "mcs" | "foundry"
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = joinUrl(baseUrl, "/health");
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) return false;
    if (backend !== "foundry") return true;
    const body = await res.json() as { foundry?: { available?: boolean } };
    return body.foundry?.available === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
