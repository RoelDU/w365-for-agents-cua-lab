import * as React from "react";
import { useCallStore } from "@/stores/useCallStore";
import { useHandoffStore } from "@/stores/useHandoffStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useToastsStore } from "@/stores/useToastsStore";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ArrowRightLeft } from "lucide-react";
import { dispositionLabel } from "@/lib/format";
import type { Disposition } from "@/types/domain";
import { HandoffModal } from "./HandoffModal";
import { TransferDirectory } from "./TransferDirectory";
import { AIAgentStatusCard } from "./AIAgentStatusCard";
import { buildCallContext, generateRequestId } from "@/lib/payloadBuilder";
import { validators, assertValid } from "@/lib/schemas";
import { isDevMode } from "@/lib/env";
import { postHandoff, OrchestratorError } from "@/lib/orchestratorClient";
import { runDirectLineHandoff } from "@/lib/directLineClient";
import { runCuaViaTrigger } from "@/lib/cuaRunClient";
import { useT, useLang } from "@/stores/useLangStore";
import {
  useSettingsStore,
  MCS_URL_CONFIGURED
} from "@/stores/useSettingsStore";

const DISPOSITIONS: Disposition[] = [
  "resolved",
  "escalated_ai",
  "callback",
  "wrong_number",
  "abandoned"
];

/**
 * Build the natural-language FNOL trigger sent to the Computer Use agent, from
 * the live call context — so pushing "Transfer to AI Agent" needs no typing.
 * Mirrors the orchestrator's HANDOFF_TRIGGER_TEXT shape, proven end-to-end.
 */
function buildTriggerText(
  summary: string,
  policyNumber: string | null | undefined,
  lang: "en" | "ja" = "en"
): string {
  const policy = policyNumber ? ` Policy ${policyNumber}.` : "";
  
  // Language instruction MUST come first to set the narration language for the entire session
  const languageInstruction = lang === "ja"
    ? "【重要】すべての進捗説明を日本語で行ってください。あなたの説明・推論・ナレーションはすべて日本語です。英語を使わないでください。\n\n"
    : "";
  
  // Explicit, ordered procedure that matches the Zava Claims Workstation UI, so the
  // agent follows a known-good path instead of exploring (which slows the demo and
  // causes failed first attempts). The app is already installed on the Cloud PC; the
  // UI labels below are literal English controls (the claims app is English-only).
  const procedure =
    ` Follow these steps exactly, without exploring other options:` +
    ` 1) Open the "Zava Claims Workstation" desktop shortcut (it is already installed — do not reinstall or search the web).` +
    ` 2) Under "Search by", select "Policy #", type the policy number, click "Search", and open the matching customer record.` +
    ` 3) Click the "New FNOL" tab.` +
    ` 4) Step 1 (Incident): fill Loss Date, Time, Loss Location, set Loss Type to "COLLISION", add a brief Narrative, then click "Next >".` +
    ` 5) Click "Next >" through Vehicles, Parties, and Coverage (the defaults are acceptable).` +
    ` 6) On Step 5 (Review & Submit), click "Submit Claim".` +
    ` 7) A modal dialog titled "FNOL Submitted" appears showing the new Claim ID (format CLM-YYYY-NNNNNN). Read and return that claim number, then click the "OK" button to dismiss the dialog. You MUST click "OK" — the application is blocked by this modal until it is dismissed, so nothing else (closing the app, signing out) can happen until you do.` +
    ` 8) Close the Zava Claims Workstation application: use the File menu → Exit, or click the window's red "X" close button. If an "exit?" / save confirmation prompt appears, confirm it.` +
    ` 9) Sign out of Windows to RELEASE the Cloud PC for the next demo: open the Start menu, click the user account icon, and choose "Sign out". This is mandatory — do not just lock or minimize. The task is only complete once the Windows sign-in / lock screen is visible, confirming the session has ended.`;
  
  const task =
    `A customer was just handed off to you. ${summary.trim()}.${policy} ` +
    `CRITICAL: You MUST complete ALL of these steps in order: (1) File the First Notice of Loss (FNOL) in the Zava Claims Workstation using computer use, (2) give me the claim number, (3) click "OK" to dismiss the "FNOL Submitted" confirmation dialog, (4) close the Zava Claims Workstation application, and (5) sign out of Windows via Start menu → user icon → "Sign out" to release the Cloud PC. Reporting the claim number is NOT the end of the task. DO NOT STOP until you have signed out of Windows and the sign-in / lock screen is visible.` +
    procedure;
  
  return languageInstruction + task;
}

export function RightRail() {
  const t = useT();
  const lang = useLang();
  const phase = useCallStore((s) => s.phase);
  const scenario = useCallStore((s) => s.scenario);
  const summarySeed = scenario?.summary_seed ?? "";
  const getExcerpt = useCallStore((s) => s.getTranscriptExcerpt);
  const disposition = useCallStore((s) => s.disposition);
  const setDisposition = useCallStore((s) => s.setDisposition);

  const agent = useAuthStore((s) => s.agent);
  const orchestratorUrl = useSettingsStore((s) => s.orchestratorUrl);
  const backend = useSettingsStore((s) => s.backend);
  const cuaMode = useSettingsStore((s) => s.cuaMode);
  // Runtime-resolved Direct Line endpoint for the active CUA region. When present
  // the Transfer button streams the live agent desktop in-app; empty = orchestrator
  // path. Region is chosen at install/deploy time (region-config.json) or in Settings.
  const directLineTokenUrl = useSettingsStore((s) => s.directLineTokenUrl);
  const cuaRunBaseUrl = useSettingsStore((s) => s.cuaRunBaseUrl);

  const handoffStatus = useHandoffStore((s) => s.status);
  const beginHandoff = useHandoffStore((s) => s.beginHandoff);
  const pushActivity = useHandoffStore((s) => s.pushActivity);
  const resetHandoff = useHandoffStore((s) => s.reset);
  const pushScreenshot = useHandoffStore((s) => s.pushScreenshot);
  const setNarration = useHandoffStore((s) => s.setNarration);
  const setStreamingStatus = useHandoffStore((s) => s.setStreamingStatus);
  const applyStatus = useHandoffStore((s) => s.applyStatus);
  const setHandoffError = useHandoffStore((s) => s.setError);

  const push = useToastsStore((s) => s.push);

  const [modalOpen, setModalOpen] = React.useState(false);
  const [directoryOpen, setDirectoryOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  // Generated when the AI destination is selected so the request ID shown in the
  // context-card preview / JSON disclosure matches the payload actually sent.
  const [previewRequestId, setPreviewRequestId] = React.useState<string | null>(null);

  // Aborts the in-flight Direct Line streaming run when the agent panel is reset.
  const directLineAbortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => directLineAbortRef.current?.abort(), []);

  // Reset wrapper that also cancels any live Direct Line stream.
  const handleReset = React.useCallback(() => {
    directLineAbortRef.current?.abort();
    directLineAbortRef.current = null;
    resetHandoff();
  }, [resetHandoff]);

  // The TopBar "Reset demo" button dispatches ccaas:reset-demo; abort any live
  // Direct Line stream here so a new run starts from a clean conversation.
  React.useEffect(() => {
    const onReset = () => {
      directLineAbortRef.current?.abort();
      directLineAbortRef.current = null;
    };
    window.addEventListener("ccaas:reset-demo", onReset);
    return () => window.removeEventListener("ccaas:reset-demo", onReset);
  }, []);

  const canHandoff = phase === "talking" || phase === "wrap_up";
  const handoffActive = handoffStatus !== "idle";

  // The realistic entry point: open the transfer directory (the AI agent is one
  // destination among human queues), mirroring how real CCaaS desktops route an
  // interaction to an AI worker.
  const openDirectory = React.useCallback(() => {
    if (!canHandoff || handoffActive) return;
    setDirectoryOpen(true);
  }, [canHandoff, handoffActive]);

  // Selecting the AI agent destination advances to the handover confirmation.
  const selectAiDestination = React.useCallback(() => {
    setDirectoryOpen(false);
    setPreviewRequestId(generateRequestId());
    setModalOpen(true);
  }, []);

  const routeToQueue = React.useCallback(
    (name: string) => {
      setDirectoryOpen(false);
      push({
        variant: "info",
        title: t("toast.transferQueue.title"),
        description: t("toast.transferQueue.desc", { name }),
        toastId: "toast-transfer-queue"
      });
    },
    [push, t]
  );

  // Build a preview of the exact CallContext that will be transferred, for the
  // rendered context card and the developer JSON disclosure in the modal.
  const buildPreview = React.useCallback(
    (summary: string) => {
      if (!scenario || !agent) return null;
      return buildCallContext({
        scenario,
        agent,
        summary,
        transcriptExcerpt: getExcerpt(30_000),
        requestId: previewRequestId ?? undefined
      });
    },
    [scenario, agent, getExcerpt, previewRequestId]
  );

  // Open the transfer directory from the global keyboard shortcut (Ctrl+Shift+H)
  // and from the call-toolbar Transfer button (ccaas:open-transfer).
  React.useEffect(() => {
    const handler = () => openDirectory();
    window.addEventListener("ccaas:open-handoff", handler);
    window.addEventListener("ccaas:open-transfer", handler);
    return () => {
      window.removeEventListener("ccaas:open-handoff", handler);
      window.removeEventListener("ccaas:open-transfer", handler);
    };
  }, [openDirectory]);

  const submitHandoff = React.useCallback(
    async (summary: string) => {
      if (!scenario || !agent) return;

      // Option A — "autonomous trigger + Dataverse poll". When cuaRunBaseUrl is
      // configured, the Transfer button fires the run via the orchestrator (which
      // writes a Dataverse row whose "row created" event is the agent's autonomous
      // trigger) and renders a NEAR-LIVE view by polling progress. This is the
      // supported path when the agent uses "Authenticate with Microsoft" (the
      // browser-direct Direct Line stream returns nothing under MS auth), and it
      // preserves the Activity / Session-replay audit trail.
      if (cuaRunBaseUrl) {
        const effectiveSummary = summary || scenario.summary_seed;
        const ctx = buildCallContext({
          scenario,
          agent,
          summary: effectiveSummary,
          transcriptExcerpt: getExcerpt(30_000),
          requestId: previewRequestId ?? undefined,
          backend
        });
        const ctxResult = validators.callContext(ctx);
        try {
          assertValid(ctxResult, "CallContext", isDevMode());
        } catch {
          push({
            variant: "error",
            title: t("toast.callContextInvalid.title"),
            description: ctxResult.errors.join("; "),
            toastId: "toast-callcontext-invalid"
          });
          return;
        }

        directLineAbortRef.current?.abort();
        const controller = new AbortController();
        directLineAbortRef.current = controller;

        beginHandoff(ctx, { handoffId: null });
        setModalOpen(false);
        push({
          variant: "success",
          title: t("toast.handoffInitiated.title"),
          description: t("toast.handoffConnecting.desc"),
          toastId: "toast-handoff-sent"
        });
        pushActivity({
          level: "info",
          message: `Filing claim for ${ctx.request_id} via AI agent (audit-tracked run).`
        });

        void runCuaViaTrigger({
          baseUrl: cuaRunBaseUrl,
          callContext: ctx,
          lang,
          signal: controller.signal,
          onUpdate: (u) => {
            switch (u.type) {
              case "queued":
                setStreamingStatus("queued");
                break;
              case "narration":
                if (u.text) {
                  setNarration(u.text);
                  pushActivity({ level: "info", message: u.text });
                }
                break;
              case "screenshot":
                if (u.imageUrl) pushScreenshot(u.imageUrl);
                break;
              case "claim":
                applyStatus({
                  request_id: ctx.request_id,
                  status: "submitted",
                  claim_id: u.claimId,
                  policy_number: ctx.policy_number ?? undefined,
                  agent_id: agent.agent_id
                });
                pushActivity({ level: "info", message: `Claim ${u.claimId} filed by the AI agent.` });
                break;
              case "error":
                if (u.errorMessage) {
                  setHandoffError("UNKNOWN", u.errorMessage);
                  pushActivity({ level: "error", message: u.errorMessage });
                }
                break;
              case "done":
                break;
            }
          }
        });
        return;
      }

      // Direct Line streaming path: when the Copilot Studio token endpoint is
      // baked, the Transfer button opens its OWN Direct Line conversation in the
      // browser and streams the live Computer Use desktop into the status panel —
      // no orchestrator, no test pane, no typing. The agent drives a real Cloud
      // PC and returns a real claim id, rendered in-app.
      if (directLineTokenUrl) {
        const effectiveSummary = summary || scenario.summary_seed;
        const ctx = buildCallContext({
          scenario,
          agent,
          summary: effectiveSummary,
          transcriptExcerpt: getExcerpt(30_000),
          requestId: previewRequestId ?? undefined,
          backend
        });
        const ctxResult = validators.callContext(ctx);
        try {
          assertValid(ctxResult, "CallContext", isDevMode());
        } catch {
          push({
            variant: "error",
            title: t("toast.callContextInvalid.title"),
            description: ctxResult.errors.join("; "),
            toastId: "toast-callcontext-invalid"
          });
          return;
        }

        directLineAbortRef.current?.abort();
        const controller = new AbortController();
        directLineAbortRef.current = controller;

        beginHandoff(ctx, { handoffId: null });
        setModalOpen(false);
        push({
          variant: "success",
          title: t("toast.handoffInitiated.title"),
          description: t("toast.handoffConnecting.desc"),
          toastId: "toast-handoff-sent"
        });
        pushActivity({
          level: "info",
          message: `Streaming live agent desktop for ${ctx.request_id} via Direct Line.`
        });

        const triggerText = buildTriggerText(effectiveSummary, ctx.policy_number, lang);
        void runDirectLineHandoff({
          tokenUrl: directLineTokenUrl,
          triggerText,
          signal: controller.signal,
          onUpdate: (u) => {
            switch (u.type) {
              case "queued":
                setStreamingStatus("queued");
                break;
              case "narration":
                if (u.text) {
                  setNarration(u.text);
                  pushActivity({ level: "info", message: u.text });
                }
                break;
              case "screenshot":
                if (u.imageUrl) pushScreenshot(u.imageUrl);
                break;
              case "claim":
                applyStatus({
                  request_id: ctx.request_id,
                  status: "submitted",
                  claim_id: u.claimId,
                  policy_number: ctx.policy_number ?? undefined,
                  agent_id: agent.agent_id
                });
                pushActivity({ level: "info", message: `Claim ${u.claimId} filed by the AI agent.` });
                break;
              case "error":
                if (u.errorMessage) {
                  setHandoffError("UNKNOWN", u.errorMessage);
                  pushActivity({ level: "error", message: u.errorMessage });
                }
                break;
              case "done":
                break;
            }
          }
        });
        return;
      }

      // Guard the silent fallback: on the MCS path with no VITE_ORCHESTRATOR_URL baked, the
      // orchestrator URL defaults to the SWA-managed `/api`, which is the deprecated Foundry
      // endpoint and returns HTTP 502. Fail loudly instead of posting to it. (An explicitly
      // set orchestrator URL is honoured even when the build did not bake one.)
      if (backend === "mcs" && !MCS_URL_CONFIGURED && orchestratorUrl === "/api") {
        const reason =
          "MCS orchestrator URL is not configured (VITE_ORCHESTRATOR_URL). The desktop fell " +
          "back to the SWA-managed /api, which is the deprecated Foundry endpoint and will 502.";
        push({
          variant: "error",
          title: t("toast.orchestratorUnconfigured.title"),
          description: `${reason} Set the Direct Line orchestrator URL in Settings, then retry.`,
          toastId: "toast-orchestrator-unconfigured"
        });
        pushActivity({ level: "error", message: reason });
        return;
      }
      setSubmitting(true);
      try {
        const ctx = buildCallContext({
          scenario,
          agent,
          summary,
          transcriptExcerpt: getExcerpt(30_000),
          requestId: previewRequestId ?? undefined,
          backend
        });

        // Validate the outbound CallContext locally — schema is the contract.
        const ctxResult = validators.callContext(ctx);
        try {
          assertValid(ctxResult, "CallContext", isDevMode());
        } catch (err) {
          push({
            variant: "error",
            title: t("toast.callContextInvalid.title"),
            description: ctxResult.errors.join("; "),
            toastId: "toast-callcontext-invalid"
          });
          throw err;
        }

        // Post the handoff to the orchestrator, which starts the durable
        // handoff job and returns the handoff_id to poll for status.
        let res;
        try {
          res = await postHandoff(orchestratorUrl, ctx);
        } catch (err) {
          const reason =
            err instanceof OrchestratorError ? err.message : "Unknown network error";
          push({
            variant: "error",
            title: t("toast.handoffFailed.title"),
            description: t("toast.handoffFailed.desc", { reason }),
            toastId: "toast-handoff-failed"
          });
          pushActivity({
            level: "error",
            message: `Handoff POST failed: ${reason}`
          });
          return;
        }

        if (!res.handoff_id) {
          // The orchestrator status endpoint is keyed on the handoff_id.
          push({
            variant: "error",
            title: t("toast.handoffIncomplete.title"),
            description: t("toast.handoffIncomplete.desc"),
            toastId: "toast-handoff-incomplete"
          });
          pushActivity({
            level: "error",
            message: `Handoff ${ctx.request_id} returned no handoff_id.`
          });
          return;
        }

        pushActivity({
          level: "info",
          message: `Posted handoff ${ctx.request_id} to ${orchestratorUrl} (job ${res.handoff_id}).`
        });
        beginHandoff(ctx, { handoffId: res.handoff_id });
        push({
          variant: "success",
          title: t("toast.handoffInitiated.title"),
          description: t("toast.handoffSent.desc", { id: ctx.request_id }),
          toastId: "toast-handoff-sent"
        });
        setModalOpen(false);
      } finally {
        setSubmitting(false);
      }
    },
    [
      scenario,
      agent,
      getExcerpt,
      orchestratorUrl,
      backend,
      directLineTokenUrl,
      previewRequestId,
      lang,
      beginHandoff,
      pushActivity,
      push,
      setStreamingStatus,
      setNarration,
      pushScreenshot,
      applyStatus,
      setHandoffError,
      t
    ]
  );

  return (
    <Card data-testid="right-rail" className="flex h-full flex-col">
      <CardHeader>
        <CardTitle>{t("rail.title")}</CardTitle>
        {handoffActive && <Badge variant="accent">{t("rail.aiEngaged")}</Badge>}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <NotesSection />
        <div>
          <label
            htmlFor="disposition-select"
            className="mb-1 block text-xxs uppercase tracking-wider text-muted-400"
          >
            {t("rail.disposition")}
          </label>
          <Select
            id="disposition-select"
            data-testid="disposition-select"
            value={disposition}
            onChange={(e) => setDisposition(e.target.value as Disposition)}
            disabled={phase === "idle"}
            className="w-full"
          >
            <option value="">{t("rail.selectPlaceholder")}</option>
            {DISPOSITIONS.map((d) => (
              <option key={d} value={d}>
                {dispositionLabel(d, lang)}
              </option>
            ))}
          </Select>
        </div>

        {!handoffActive ? (
          <Button
            data-testid="open-transfer-directory"
            aria-label={t("rail.transferAria")}
            variant="secondary"
            size="lg"
            disabled={!canHandoff}
            onClick={openDirectory}
            className="mt-1 gap-2"
          >
            <ArrowRightLeft className="h-4 w-4" />
            {t("rail.transferInteraction")}
          </Button>
        ) : (
          <AIAgentStatusCard onReset={handleReset} />
        )}

        <TransferDirectory
          open={directoryOpen}
          onOpenChange={(o) => setDirectoryOpen(o)}
          canHandoff={canHandoff}
          onSelectAi={selectAiDestination}
          onRouteToQueue={routeToQueue}
          cuaMode={cuaMode}
        />

        <HandoffModal
          open={modalOpen}
          onOpenChange={(o) => !submitting && setModalOpen(o)}
          submitting={submitting}
          onConfirm={submitHandoff}
          summarySeed={summarySeed}
          callerLabel={scenario?.caller_display_name ?? ""}
          intentLabelText={scenario?.intent ?? ""}
          cuaMode={cuaMode}
          buildPreview={buildPreview}
        />
      </CardContent>
    </Card>
  );
}

function NotesSection() {
  const t = useT();
  const notes = useCallStore((s) => s.notes);
  const setNotes = useCallStore((s) => s.setNotes);
  return (
    <div>
      <label
        htmlFor="agent-notes"
        className="mb-1 block text-xxs uppercase tracking-wider text-muted-400"
      >
        {t("rail.agentNotes")}
      </label>
      <Textarea
        id="agent-notes"
        data-testid="agent-notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={t("rail.notesPlaceholder")}
        rows={4}
      />
    </div>
  );
}
