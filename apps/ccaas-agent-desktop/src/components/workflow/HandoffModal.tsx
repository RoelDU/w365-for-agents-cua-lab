import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Loader2, ClipboardCopy, ChevronRight, ChevronDown, Bot } from "lucide-react";
import { intentLabel } from "@/lib/format";
import type { CallContext } from "@/types/contracts";
import { copyToClipboard } from "@/lib/clipboard";
import { useT, useLang } from "@/stores/useLangStore";

interface HandoffModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (summary: string) => Promise<void> | void;
  summarySeed: string;
  callerLabel: string;
  intentLabelText: string;
  submitting: boolean;
  cuaMode: boolean;
  buildPreview: (summary: string) => CallContext | null;
}

export function HandoffModal({
  open,
  onOpenChange,
  onConfirm,
  summarySeed,
  callerLabel,
  intentLabelText,
  submitting,
  cuaMode,
  buildPreview
}: HandoffModalProps) {
  const t = useT();
  const lang = useLang();
  const [summary, setSummary] = React.useState(summarySeed);
  const [showJson, setShowJson] = React.useState(false);
  const preview = buildPreview(summary);
  React.useEffect(() => {
    if (open) setSummary(summarySeed);
  }, [open, summarySeed]);

  // CUA mode: auto-confirm after a short visible delay so a CUA driving the
  // CCaaS desktop sees the modal but doesn't have to click through it.
  React.useEffect(() => {
    if (!open || !cuaMode || submitting) return;
    const id = setTimeout(() => {
      onConfirm(summary);
    }, 1000);
    return () => clearTimeout(id);
  }, [open, cuaMode, submitting, summary, onConfirm]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="handoff-modal"
        aria-describedby="handoff-modal-desc"
      >
        <DialogHeader>
          <DialogTitle>{t("handoff.title")}</DialogTitle>
          <DialogDescription id="handoff-modal-desc">
            {lang === "ja" ? (
              <>
                この対応をAIエージェント（Computer Use を備えた Microsoft
                Copilot Studio エージェント）にルーティングします。対応コンテキストは、
                実際のプラットフォームが現在採用しているモデル（Connect の連絡先属性、
                Twilio のタスク属性、D365 Contact Center の <code>msdyn_*</code>{" "}
                変数）と同様に、構造化された JSON エンベロープとして転送に付随します。
                ここではこのワークスペースが <strong>CCaaS チャネル</strong>であり、
                Direct Line チャネルアダプター経由でエージェントに接続されています。
                Tier-1 の本番環境では、同じエージェントがプラットフォーム標準の
                コネクターに接続されます。エージェントはレガシーの請求業務システムを開き、
                初回事故報告（FNOL）を登録し、請求IDがここに返されます。
              </>
            ) : (
              <>
                Routes this interaction to an AI agent (Microsoft Copilot Studio
                agent with Computer Use). The interaction context travels with the
                transfer as a structured JSON envelope — the model real platforms
                use today (Connect contact attributes, Twilio task attributes, D365
                Contact Center <code>msdyn_*</code> variables). Here this workspace
                is the <strong>CCaaS channel</strong>, connected to the agent over a
                Direct Line channel adapter; in a Tier-1 deployment the same agent
                plugs into the platform&rsquo;s native connector instead.
                The agent opens the legacy claims workstation,
                submits the FNOL, and the claim ID returns here.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label
              htmlFor="handoff-summary"
              className="mb-1 block text-xxs uppercase tracking-wider text-muted-400"
            >
              {t("handoff.summaryLabel")}
            </label>
            <Textarea
              id="handoff-summary"
              data-testid="handoff-summary"
              rows={4}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={1000}
              disabled={submitting}
            />
            <div className="mt-1 text-xxs text-muted-500">
              {t("handoff.charCount", { n: summary.length })}
            </div>
          </div>

          {/* Rendered handover-context card — what the human agent sees. Mirrors
              how real CCaaS desktops (Amazon Connect AttributeBar, D365
              "Additional details") render context as labeled fields, never as
              raw JSON. The JSON wire contract is in the disclosure below. */}
          <div
            data-testid="handoff-context-card"
            className="rounded-md border border-border bg-bg-800 p-3"
          >
            <div className="mb-2 flex items-center gap-1.5 text-xxs uppercase tracking-wider text-accent-400">
              <Bot className="h-3.5 w-3.5" />
              {t("handoff.handoverContext")}
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <Pair label={t("handoff.caller")} value={callerLabel} />
              <Pair label={t("handoff.intent")} value={intentLabel(intentLabelText, lang)} />
              <Pair label={t("handoff.phone")} value={preview?.caller_phone ?? "—"} mono />
              <Pair
                label={t("handoff.policy")}
                value={preview?.policy_number ?? t("handoff.notProvided")}
                mono
              />
              <Pair label={t("handoff.requestId")} value={preview?.request_id ?? "—"} mono />
              <Pair
                label={t("handoff.requestedBy")}
                value={preview?.requested_by.display_name ?? "—"}
              />
            </dl>
          </div>

          {/* Developer disclosure: the actual JSON wire contract. Kept separate
              from the agent-facing card; for technical/partner conversations. */}
          <div className="rounded-md border border-border bg-bg-900/40">
            <button
              type="button"
              data-testid="handoff-json-toggle"
              aria-expanded={showJson}
              onClick={() => setShowJson((v) => !v)}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-xxs uppercase tracking-wider text-muted-400 hover:text-slate-200"
            >
              {showJson ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              {t("handoff.viewPayload")}
            </button>
            {showJson && preview && (
              <div className="border-t border-border p-3">
                <div className="mb-2 text-xxs text-muted-500">
                  {lang === "ja" ? (
                    <>
                      この JSON は、エージェントプラットフォームに渡される通信契約です。
                      <strong>現在</strong>は Twilio TaskRouter のタスク属性ペイロードや
                      Amazon Connect の連絡先属性に相当します。
                      <strong>今後</strong>は A2A の Task メッセージにマッピングされ、
                      このワークスペースが <strong>A2A クライアント</strong>、AIが
                      リモートエージェントとなり、そのエージェントは MCP
                      ツールを使って作業を行います。値はフラットかつプリミティブに保ち、
                      スキーマ検証を行ってください。エージェントUIは上記のカードを描画し、
                      生の JSON を人間に表示することはありません。
                    </>
                  ) : (
                    <>
                      This JSON is the wire contract delivered to the agent platform.
                      <strong> Today</strong> it is analogous to a Twilio TaskRouter
                      task-attributes payload or Amazon Connect contact attributes;
                      <strong> next</strong> it maps onto an A2A Task message — this
                      workspace as the <strong>A2A client</strong>, the AI as the
                      remote agent — while that agent uses MCP tools to do the work.
                      Keep values flat/primitive and schema-validated — the agent UI
                      renders the card above and never shows raw JSON to the human.
                    </>
                  )}
                </div>
                <pre
                  data-testid="handoff-json"
                  className="max-h-48 overflow-auto rounded bg-bg-900 p-2 font-mono text-xxs leading-relaxed text-slate-200"
                >
{JSON.stringify(preview, null, 2)}
                </pre>
                <Button
                  size="sm"
                  variant="subtle"
                  className="mt-2 gap-1.5"
                  data-testid="handoff-json-copy"
                  onClick={() =>
                    copyToClipboard(JSON.stringify(preview, null, 2))
                  }
                >
                  <ClipboardCopy className="h-3.5 w-3.5" />
                  {t("handoff.copyJson")}
                </Button>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            data-testid="handoff-cancel"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("handoff.cancel")}
          </Button>
          <Button
            variant="primary"
            data-testid="handoff-confirm"
            disabled={submitting || summary.trim().length === 0}
            onClick={() => onConfirm(summary.trim())}
            className="gap-2"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("handoff.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Pair({
  label,
  value,
  mono
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xxs uppercase tracking-wider text-muted-400">{label}</dt>
      <dd className={`text-sm text-slate-100 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
