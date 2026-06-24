/*
 * directLineClient.ts — browser-direct Bot Framework Direct Line client for the
 * Copilot Studio "Zava Claims Intake (CUA)" agent.
 *
 * Why this exists: the legacy handoff path posts to the Durable Functions
 * orchestrator, which drives the agent but only surfaces the FINAL result — the
 * live Computer Use desktop screenshots never reach the app. This client opens
 * its OWN Direct Line conversation straight from the browser (CORS-verified
 * against the Copilot Studio token endpoint), sends the FNOL trigger built from
 * the call context (no typing), and streams the desktop screenshots + agent
 * narration back so they can render inside the AI Agent Status panel.
 *
 * It is activated only when VITE_DIRECTLINE_TOKEN_URL is baked at build time;
 * otherwise the app keeps its existing orchestrator behavior untouched.
 */

const DIRECTLINE_BASE = "https://directline.botframework.com/v3/directline";

/** Identifies activities this client sent, so they're skipped when polling. */
export const DIRECTLINE_USER_ID = "ccaas-agent-desktop";

/** Claim id shape returned by the legacy claims app, e.g. CLM-2024-000441. */
const CLAIM_ID_RE = /CLM-\d{4}-\d{6}/;
/** The agent's reply when the single Cloud PC is busy / capacity is exhausted. */
const USAGE_LIMIT_RE = /usage limit|currently unavailable/i;
/** Markdown image embeds (data: or http(s):) some channels use instead of attachments. */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\((data:image\/[^)]+|https?:\/\/[^)\s]+)\)/g;

export type DirectLineUpdateType =
  | "queued"
  | "narration"
  | "screenshot"
  | "claim"
  | "error"
  | "done";

export interface DirectLineUpdate {
  type: DirectLineUpdateType;
  /** Agent narration text (for "narration"). */
  text?: string;
  /** Screenshot image src — data URI or https URL (for "screenshot"). */
  imageUrl?: string;
  /** Claim id (for "claim"). */
  claimId?: string;
  /** Human-readable reason (for "error"). */
  errorMessage?: string;
}

export class DirectLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectLineError";
  }
}

interface DirectLineAttachment {
  contentType?: string;
  contentUrl?: string;
  content?: unknown;
}

interface DirectLineActivity {
  id?: string;
  type?: string;
  text?: string;
  from?: { id?: string };
  attachments?: DirectLineAttachment[];
}

async function getToken(tokenUrl: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(tokenUrl, { method: "GET" });
  } catch (err) {
    throw new DirectLineError(
      `Could not reach the Direct Line token endpoint (${err instanceof Error ? err.message : "network error"}).`
    );
  }
  if (!res.ok) {
    throw new DirectLineError(`Direct Line token request failed (HTTP ${res.status}).`);
  }
  const body = (await res.json().catch(() => ({}))) as { token?: string };
  if (!body.token) throw new DirectLineError("Direct Line token endpoint returned no token.");
  return body.token;
}

async function startConversation(token: string): Promise<string> {
  const res = await fetch(`${DIRECTLINE_BASE}/conversations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new DirectLineError(`Could not start a Direct Line conversation (HTTP ${res.status}).`);
  }
  const body = (await res.json().catch(() => ({}))) as { conversationId?: string };
  if (!body.conversationId) throw new DirectLineError("Direct Line returned no conversation id.");
  return body.conversationId;
}

async function sendMessage(token: string, conversationId: string, text: string): Promise<void> {
  const res = await fetch(`${DIRECTLINE_BASE}/conversations/${conversationId}/activities`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "message", from: { id: DIRECTLINE_USER_ID }, text })
  });
  if (!res.ok) {
    throw new DirectLineError(`Could not send the handoff trigger (HTTP ${res.status}).`);
  }
}

async function getActivities(
  token: string,
  conversationId: string,
  watermark: string | number
): Promise<{ activities: DirectLineActivity[]; watermark: string | number }> {
  const url = `${DIRECTLINE_BASE}/conversations/${conversationId}/activities?watermark=${watermark}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new DirectLineError(`Could not read agent activities (HTTP ${res.status}).`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    activities?: DirectLineActivity[];
    watermark?: string | number;
  };
  return { activities: body.activities ?? [], watermark: body.watermark ?? watermark };
}

/** Extract every renderable image src from an activity (attachments + markdown). */
export function imageUrlsFromActivity(activity: {
  text?: string;
  attachments?: DirectLineAttachment[];
}): string[] {
  const urls: string[] = [];
  for (const att of activity.attachments ?? []) {
    if (!att || typeof att.contentType !== "string") continue;
    if (!att.contentType.startsWith("image/")) continue;
    if (typeof att.contentUrl === "string" && att.contentUrl) {
      urls.push(att.contentUrl);
    } else if (typeof att.content === "string" && att.content) {
      const c = att.content;
      urls.push(
        c.startsWith("data:") || c.startsWith("http")
          ? c
          : `data:${att.contentType};base64,${c}`
      );
    }
  }
  if (typeof activity.text === "string" && activity.text.includes("![")) {
    let m: RegExpExecArray | null;
    MARKDOWN_IMAGE_RE.lastIndex = 0;
    while ((m = MARKDOWN_IMAGE_RE.exec(activity.text))) urls.push(m[1]);
  }
  return urls;
}

/** Narration text with any markdown image embeds stripped out. */
function narrationText(activity: DirectLineActivity): string {
  if (typeof activity.text !== "string") return "";
  return activity.text.replace(MARKDOWN_IMAGE_RE, "").trim();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

export interface RunDirectLineHandoffOptions {
  tokenUrl: string;
  triggerText: string;
  onUpdate: (update: DirectLineUpdate) => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxDurationMs?: number;
}

/**
 * Open a Direct Line conversation, send the FNOL trigger, and stream updates
 * (narration, screenshots, claim id, errors) via onUpdate until the agent
 * returns a claim id, an error, the deadline passes, or the signal aborts.
 *
 * Resolves when the run reaches a terminal state; never rejects — failures are
 * delivered as an "error" update so the caller has a single code path.
 */
export async function runDirectLineHandoff(opts: RunDirectLineHandoffOptions): Promise<void> {
  const pollMs = opts.pollIntervalMs ?? 2000;
  const maxMs = opts.maxDurationMs ?? 16 * 60 * 1000;
  const { onUpdate, signal } = opts;

  try {
    const token = await getToken(opts.tokenUrl);
    if (signal?.aborted) return;
    const conversationId = await startConversation(token);
    if (signal?.aborted) return;
    await sendMessage(token, conversationId, opts.triggerText);
    onUpdate({ type: "queued" });

    const start = Date.now();
    let watermark: string | number = 0;
    let done = false;

    while (!done && Date.now() - start < maxMs) {
      await delay(pollMs, signal);
      if (signal?.aborted) return;

      const { activities, watermark: wm } = await getActivities(token, conversationId, watermark);
      watermark = wm;

      for (const a of activities) {
        if (a.from?.id === DIRECTLINE_USER_ID) continue;

        const note = narrationText(a);
        if (note) {
          if (USAGE_LIMIT_RE.test(note)) {
            onUpdate({
              type: "error",
              errorMessage:
                "The AI agent's Cloud PC is busy (usage limit). Wait ~30s and retry — run one handoff at a time."
            });
            done = true;
            break;
          }
          onUpdate({ type: "narration", text: note });
        }

        for (const url of imageUrlsFromActivity(a)) {
          onUpdate({ type: "screenshot", imageUrl: url });
        }

        const claim = (a.text ?? "").match(CLAIM_ID_RE);
        if (claim) {
          onUpdate({ type: "claim", claimId: claim[0] });
          done = true;
          break;
        }
      }
    }

    if (!done) {
      onUpdate({
        type: "error",
        errorMessage: "The agent did not return a claim number before the time limit."
      });
    }
  } catch (err) {
    onUpdate({
      type: "error",
      errorMessage:
        err instanceof DirectLineError
          ? err.message
          : `Unexpected error talking to the AI agent (${err instanceof Error ? err.message : String(err)}).`
    });
  } finally {
    onUpdate({ type: "done" });
  }
}
