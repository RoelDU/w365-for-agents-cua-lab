import * as React from "react";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHandoffStore } from "@/stores/useHandoffStore";
import { useT } from "@/stores/useLangStore";
import { foundryAction, type FoundryViewDetails } from "@/lib/foundryHostedClient";

/*
 * View-only screen of the Foundry agent's Cloud PC, using Microsoft's
 * ScreenShareViewer bundle. Contract section 5: on the first "connected" or
 * "view-only" state, report view_ready once; "controlling" stops viewing
 * (takeover is not approved); a disconnect offers a reconnect while the run is
 * still running. The viewing token lives only in this component's closures.
 */

interface ScreenShareViewerLike {
  on(event: "statusChanged" | "error", handler: (value: string) => unknown): void;
  connect(token: string): Promise<void> | void;
  updateToken(token: string): Promise<void> | void;
  stop(): void;
}
type ScreenShareViewerCtor = new (opts: {
  container: HTMLElement;
  computerUrl: string;
  viewerUrl: string;
  mode: "viewOnly";
}) => ScreenShareViewerLike;

const SDK_HOST = "packages.global.cloudinferenceplatform.azure.com";
const MAX_AUTO_RECONNECTS = 3;
let sdkLoading: Promise<ScreenShareViewerCtor> | null = null;

function existingCtor(): ScreenShareViewerCtor | undefined {
  return (window as unknown as { ScreenShareViewer?: ScreenShareViewerCtor }).ScreenShareViewer;
}

function loadSdk(sdkUrl: string): Promise<ScreenShareViewerCtor> {
  const ready = existingCtor();
  if (ready) return Promise.resolve(ready);
  let url: URL;
  try {
    url = new URL(sdkUrl);
  } catch {
    return Promise.reject(new Error("the viewer address is not valid"));
  }
  if (url.protocol !== "https:" || url.hostname !== SDK_HOST) {
    return Promise.reject(new Error("the viewer is not from the expected Microsoft address"));
  }
  if (!sdkLoading) {
    sdkLoading = new Promise<ScreenShareViewerCtor>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url.toString();
      script.async = true;
      script.onload = () => {
        const ctor = existingCtor();
        if (ctor) resolve(ctor);
        else reject(new Error("the viewer did not load"));
      };
      script.onerror = () => reject(new Error("the viewer could not be downloaded"));
      document.head.appendChild(script);
    }).catch((err) => {
      sdkLoading = null;
      throw err;
    });
  }
  return sdkLoading;
}

function isHttps(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

type ViewState = "idle" | "connecting" | "viewing" | "stopped";

export function FoundryViewer({ expanded = false }: { expanded?: boolean } = {}) {
  const t = useT();
  const run = useHandoffStore((s) => s.foundryRun);
  const pushActivity = useHandoffStore((s) => s.pushActivity);
  const [state, setState] = React.useState<ViewState>("idle");
  const [message, setMessage] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const viewerRef = React.useRef<ScreenShareViewerLike | null>(null);
  const reportedRef = React.useRef(false);
  const attemptRef = React.useRef(0);
  const reconnectsRef = React.useRef(0);
  const runningRef = React.useRef(false);
  const connectRef = React.useRef<() => Promise<void>>(async () => {});
  // View details fetched as soon as the Cloud PC is acquired, used once by the first connect.
  const prefetchRef = React.useRef<{ sessionId: string; details: Promise<FoundryViewDetails> } | null>(null);

  const baseUrl = run?.baseUrl ?? null;
  const requestId = run?.requestId ?? null;
  const sessionId = run?.sessionId ?? null;
  const running = run?.running ?? false;
  const ready = run?.ready ?? false;
  runningRef.current = running;

  const stopViewer = React.useCallback(() => {
    const v = viewerRef.current;
    viewerRef.current = null;
    if (v) {
      try {
        v.stop();
      } catch {
        /* already stopped */
      }
    }
  }, []);

  const connect = React.useCallback(async () => {
    if (!baseUrl || !requestId || !sessionId) return;
    const attempt = ++attemptRef.current;
    stopViewer();
    setState("connecting");
    setMessage(null);
    const fail = (detail: string) => {
      if (attempt !== attemptRef.current) return;
      stopViewer();
      setState("stopped");
      setMessage(t("ai.foundry.viewError", { detail }));
      pushActivity({ level: "error", message: `Live screen unavailable: ${detail}` });
    };
    try {
      const early = prefetchRef.current;
      prefetchRef.current = null;
      let details: FoundryViewDetails | null = null;
      if (early && early.sessionId === sessionId) details = await early.details.catch(() => null);
      if (!details) details = await foundryAction<FoundryViewDetails>(baseUrl, "view", { request_id: requestId });
      if (attempt !== attemptRef.current) return;
      if (details.request_id !== requestId || details.session_id !== sessionId || details.mode !== "viewOnly") {
        return fail("the screen details do not belong to this run's Cloud PC");
      }
      if (!isHttps(details.computer_url) || !isHttps(details.viewer_url) || typeof details.token !== "string") {
        return fail("the screen details are incomplete");
      }
      const Ctor = await loadSdk(details.sdk_url);
      const container = containerRef.current;
      if (attempt !== attemptRef.current || !container) return;
      container.replaceChildren();
      const viewer = new Ctor({
        container,
        computerUrl: details.computer_url,
        viewerUrl: details.viewer_url,
        mode: "viewOnly"
      });
      viewerRef.current = viewer;

      viewer.on("statusChanged", async (status) => {
        if (viewerRef.current !== viewer) return;
        if (status === "connected" || status === "view-only") {
          setState("viewing");
          setMessage(null);
          if (reportedRef.current) return;
          reportedRef.current = true;
          try {
            await foundryAction(baseUrl, "view_ready", { request_id: requestId, session_id: sessionId });
            pushActivity({ level: "info", message: `View-only screen connected to session ${sessionId}; reported to the Foundry agent.` });
          } catch (err) {
            reportedRef.current = false;
            pushActivity({ level: "error", message: `Could not report the connected screen: ${err instanceof Error ? err.message : String(err)}` });
          }
        } else if (status === "controlling") {
          stopViewer();
          setState("stopped");
          setMessage(t("ai.foundry.takeover"));
          pushActivity({ level: "error", message: "The screen switched to control mode, so viewing stopped. Takeover is not approved." });
        } else if (status === "disconnected") {
          stopViewer();
          // Contract 5.5: reconnect with fresh screen details while the run is
          // still running. Bounded, so a screen that keeps dropping stops and
          // offers the manual Watch button instead of looping.
          if (runningRef.current && reconnectsRef.current < MAX_AUTO_RECONNECTS) {
            reconnectsRef.current += 1;
            pushActivity({ level: "warn", message: "The live screen disconnected; reconnecting." });
            void connectRef.current();
            return;
          }
          setState("stopped");
          setMessage(t("ai.foundry.disconnected"));
          pushActivity({ level: "warn", message: "The live screen disconnected." });
        }
      });

      viewer.on("error", async (code) => {
        if (viewerRef.current !== viewer) return;
        if (code === "TOKEN_EXPIRED") {
          try {
            const fresh = await foundryAction<FoundryViewDetails>(baseUrl, "view", { request_id: requestId });
            if (
              fresh.session_id !== details.session_id ||
              fresh.computer_url !== details.computer_url ||
              fresh.viewer_url !== details.viewer_url
            ) {
              throw new Error("the screen details changed");
            }
            if (viewerRef.current === viewer) await viewer.updateToken(fresh.token);
            return;
          } catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
          }
        }
        fail(String(code));
      });

      await viewer.connect(details.token);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }, [baseUrl, requestId, sessionId, stopViewer, pushActivity, t]);
  connectRef.current = connect;

  // Each run (and each manual Watch) gets its own small reconnect budget.
  React.useEffect(() => {
    reconnectsRef.current = 0;
  }, [requestId, sessionId]);

  // Run J: 9.8 s from readiness to a connected viewer. The view details and Microsoft's
  // viewer bundle are fetched as soon as the Cloud PC is acquired (about 2 s before it
  // answers); connecting still waits for readiness, as the contract requires.
  React.useEffect(() => {
    if (!running || ready || !sessionId || !baseUrl || !requestId) return;
    if (prefetchRef.current?.sessionId === sessionId) return;
    const details = foundryAction<FoundryViewDetails>(baseUrl, "view", { request_id: requestId });
    details.then((d) => loadSdk(d.sdk_url)).catch(() => undefined);
    prefetchRef.current = { sessionId, details };
  }, [running, ready, sessionId, baseUrl, requestId]);

  // Start viewing automatically once the Cloud PC is Ready: the agent waits
  // for a connected viewer before it opens Claims.
  React.useEffect(() => {
    if (running && ready && sessionId && state === "idle") void connect();
  }, [running, ready, sessionId, state, connect]);

  // The run has ended (the Cloud PC is released): stop viewing.
  React.useEffect(() => {
    if (!running) {
      attemptRef.current += 1;
      stopViewer();
    }
  }, [running, stopViewer]);

  React.useEffect(() => () => {
    attemptRef.current += 1;
    stopViewer();
  }, [stopViewer]);

  if (!run) return null;

  const statusText =
    message ??
    (state === "viewing"
      ? t("ai.foundry.viewing")
      : state === "connecting"
        ? t("ai.foundry.connecting")
        : running && !ready
          ? t("ai.foundry.waiting")
          : null);
  const canWatch = running && ready && !!sessionId && state !== "viewing" && state !== "connecting";

  return (
    <div data-testid="foundry-viewer">
      <div
        ref={containerRef}
        data-testid="foundry-viewer-screen"
        className={
          !running
            ? "hidden"
            : expanded
              ? "relative mx-auto aspect-video w-full max-w-[calc((100vh-16rem)*16/9)] bg-black"
              : "relative aspect-video w-full bg-black"
        }
      />
      {(statusText || canWatch) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-accent-500/20 bg-bg-900/60 px-2.5 py-1.5">
          {statusText && (
            <p
              data-testid="foundry-viewer-status"
              className={message ? "text-sm text-warn-500" : "text-sm text-slate-200"}
            >
              {statusText}
            </p>
          )}
          {canWatch && (
            <Button
              size="sm"
              variant="secondary"
              data-testid="foundry-viewer-watch"
              aria-label={t("ai.foundry.watchAria")}
              onClick={() => { reconnectsRef.current = 0; void connect(); }}
              className="ml-auto gap-1.5"
            >
              <Eye className="h-3.5 w-3.5" />
              {t("ai.foundry.watch")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
