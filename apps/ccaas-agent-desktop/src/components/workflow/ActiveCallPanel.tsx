import * as React from "react";
import { useCallStore } from "@/stores/useCallStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { HERO_SCENARIOS } from "@/mocks/heroScenarios";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMmSs, intentLabel, speakerLabel } from "@/lib/format";
import { useToastsStore } from "@/stores/useToastsStore";
import { useT, useLang } from "@/stores/useLangStore";
import {
  Phone,
  PhoneCall,
  PhoneOff,
  Mic,
  MicOff,
  Pause,
  Play,
  ArrowRightLeft,
  Users
} from "lucide-react";
import { cn } from "@/lib/cn";

export function ActiveCallPanel() {
  const t = useT();
  const lang = useLang();
  const phase = useCallStore((s) => s.phase);
  const scenario = useCallStore((s) => s.scenario);
  const scenarioKey = useCallStore((s) => s.scenarioKey);
  const transcript = useCallStore((s) => s.transcript);
  const duration = useCallStore((s) => s.durationSec);
  const isOnHold = useCallStore((s) => s.isOnHold);
  const isMuted = useCallStore((s) => s.isMuted);
  const selectScenario = useCallStore((s) => s.selectScenario);
  const startRinging = useCallStore((s) => s.startRinging);
  const answerCall = useCallStore((s) => s.answerCall);
  const endCall = useCallStore((s) => s.endCall);
  const toggleHold = useCallStore((s) => s.toggleHold);
  const toggleMute = useCallStore((s) => s.toggleMute);
  const cuaMode = useSettingsStore((s) => s.cuaMode);
  const cps = useSettingsStore((s) => s.typewriterCps);
  const push = useToastsStore((s) => s.push);

  if (phase === "idle") {
    return (
      <Card data-testid="active-call-panel" className="flex h-full flex-col">
        <CardHeader>
          <CardTitle>{t("call.activeCall")}</CardTitle>
          <Badge variant="muted">{t("call.noCall")}</Badge>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div className="rounded-full border border-border bg-bg-800 p-5 text-muted-500">
            <Phone className="h-7 w-7" aria-hidden />
          </div>
          <div>
            <div className="text-sm font-semibold">{t("call.noActiveInteraction")}</div>
            <div className="mt-1 text-xs text-muted-400">
              {t("call.pickScenario")}
            </div>
          </div>
          <div className="flex flex-col items-center gap-2">
            <Select
              data-testid="scenario-picker"
              value={scenarioKey}
              onChange={(e) => selectScenario(e.target.value as typeof scenarioKey)}
              aria-label="Hero scenario"
            >
              {HERO_SCENARIOS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.caller_display_name} · {intentLabel(s.intent, lang)}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              size="lg"
              data-testid="simulate-inbound-call"
              onClick={startRinging}
              className="gap-2"
            >
              <PhoneCall className="h-4 w-4" aria-hidden />
              {t("call.simulateInbound")}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="active-call-panel" className="flex h-full flex-col">
      <CardHeader>
        <CardTitle>{t("call.activeCall")}</CardTitle>
        <div className="flex items-center gap-2">
          {phase === "ringing" && <Badge variant="warn">{t("call.ringing")}</Badge>}
          {phase === "talking" && <Badge variant="accent">{t("call.inCall")}</Badge>}
          {phase === "wrap_up" && <Badge variant="muted">{t("call.wrapUp")}</Badge>}
          <span
            data-testid="call-timer"
            className="font-mono text-sm tabular-nums text-slate-100"
          >
            {formatMmSs(duration)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 overflow-hidden">
        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-bg-800 p-3">
          <div>
            <div
              data-testid="caller-name"
              className="text-base font-semibold text-slate-100"
            >
              {scenario?.caller_display_name}
            </div>
            <div className="text-xs text-muted-400">
              <span data-testid="caller-phone" className="font-mono">
                {scenario?.caller_phone}
              </span>
              <span className="mx-2 text-muted-500">·</span>
              <span>{scenario ? intentLabel(scenario.intent, lang) : ""}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {phase === "ringing" && (
              <Button
                variant="primary"
                size="sm"
                data-testid="answer-call"
                onClick={() => answerCall()}
                className="gap-1.5"
              >
                <PhoneCall className="h-3.5 w-3.5" />
                {t("call.answer")}
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={isOnHold ? "warn" : "secondary"}
                  size="sm"
                  data-testid="hold-call"
                  onClick={toggleHold}
                  aria-pressed={isOnHold}
                  disabled={phase !== "talking"}
                  className="gap-1.5"
                >
                  {isOnHold ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                  {isOnHold ? t("call.resume") : t("call.hold")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Ctrl+H</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={isMuted ? "warn" : "secondary"}
                  size="sm"
                  data-testid="mute-call"
                  onClick={toggleMute}
                  aria-pressed={isMuted}
                  disabled={phase !== "talking"}
                  className="gap-1.5"
                >
                  {isMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                  {isMuted ? t("call.unmute") : t("call.mute")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Ctrl+M</TooltipContent>
            </Tooltip>
            <Button
              variant="secondary"
              size="sm"
              data-testid="transfer-call"
              onClick={() =>
                window.dispatchEvent(new CustomEvent("ccaas:open-transfer"))
              }
              disabled={phase !== "talking" && phase !== "wrap_up"}
              className="gap-1.5"
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
              {t("call.transfer")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              data-testid="conference-call"
              onClick={() =>
                push({
                  variant: "info",
                  title: t("toast.conference.title"),
                  description: t("toast.conference.desc"),
                  toastId: "toast-conference-noop"
                })
              }
              className="gap-1.5"
            >
              <Users className="h-3.5 w-3.5" />
              {t("call.conference")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid="hangup-call"
              onClick={endCall}
              className="gap-1.5"
            >
              <PhoneOff className="h-3.5 w-3.5" />
              {t("call.hangup")}
            </Button>
          </div>
        </div>

        <TranscriptStream cuaMode={cuaMode} typewriterCps={cps} transcript={transcript} />
      </CardContent>
    </Card>
  );
}

interface TranscriptStreamProps {
  cuaMode: boolean;
  typewriterCps: number;
  transcript: ReturnType<typeof useCallStore.getState>["transcript"];
}

function TranscriptStream({ cuaMode, typewriterCps, transcript }: TranscriptStreamProps) {
  const t = useT();
  const lang = useLang();
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcript.length]);

  return (
    <div
      data-testid="transcript-stream"
      ref={scrollerRef}
      className="flex-1 overflow-auto rounded-md border border-border bg-bg-800 p-3 text-sm"
      aria-live="polite"
    >
      {transcript.length === 0 && (
        <div className="text-xs text-muted-500">{t("call.awaitingFirstLine")}</div>
      )}
      <ul className="space-y-1.5">
        {transcript.map((line) => (
          <li
            key={line.id}
            data-testid={`transcript-line-${line.id}`}
            className="flex gap-2"
          >
            <span
              className={cn(
                "min-w-[60px] shrink-0 text-xxs uppercase tracking-wider",
                line.speaker === "Caller"
                  ? "text-accent-400"
                  : line.speaker === "Agent"
                    ? "text-warn-400"
                    : "text-muted-500"
              )}
            >
              {speakerLabel(line.speaker, lang)}
            </span>
            <Typewriter
              text={line.text}
              cps={typewriterCps}
              instant={cuaMode || prefersReducedMotion()}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function Typewriter({ text, cps, instant }: { text: string; cps: number; instant: boolean }) {
  const [shown, setShown] = React.useState(instant ? text : "");
  React.useEffect(() => {
    if (instant) {
      setShown(text);
      return;
    }
    setShown("");
    const stepMs = Math.max(15, Math.floor(1000 / Math.max(8, cps)));
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, stepMs);
    return () => clearInterval(id);
  }, [text, cps, instant]);
  return <span className="whitespace-pre-wrap break-words text-slate-200">{shown}</span>;
}
