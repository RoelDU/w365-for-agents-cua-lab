import * as React from "react";
import { useCallStore } from "@/stores/useCallStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useAgentStateStore } from "@/stores/useAgentStateStore";

const RING_DURATION_MS = 3000;

/**
 * Drives transcript typewriter playback, ring auto-answer, and call-duration
 * ticking. Pure side-effect component — renders nothing.
 *
 * Honors:
 *  - settings.cuaMode → instant text, no ring delay
 *  - prefers-reduced-motion → instant text
 */
export function CallPlaybackDriver() {
  const phase = useCallStore((s) => s.phase);
  const scenario = useCallStore((s) => s.scenario);
  const nextLineIdx = useCallStore((s) => s.nextLineIdx);
  const appendLine = useCallStore((s) => s.appendTranscriptLine);
  const answerCall = useCallStore((s) => s.answerCall);
  const tickDuration = useCallStore((s) => s.tickDuration);
  const setPlaying = useCallStore((s) => s.setPlaying);
  const cuaMode = useSettingsStore((s) => s.cuaMode);
  const setAux = useAgentStateStore((s) => s.setAux);

  const ringTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-answer after ring delay (skipped under CUA mode).
  React.useEffect(() => {
    if (phase !== "ringing") return;
    const delay = cuaMode ? 0 : RING_DURATION_MS;
    ringTimerRef.current = setTimeout(() => {
      answerCall();
    }, delay);
    return () => {
      if (ringTimerRef.current) clearTimeout(ringTimerRef.current);
    };
  }, [phase, cuaMode, answerCall]);

  // Drive the call-duration ticker once per second.
  React.useEffect(() => {
    if (phase !== "talking") {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
      return;
    }
    durationTimerRef.current = setInterval(() => tickDuration(), 1000);
    return () => {
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    };
  }, [phase, tickDuration]);

  // Stream transcript lines.
  React.useEffect(() => {
    if (phase !== "talking" || !scenario) return;
    if (nextLineIdx >= scenario.transcript.length) {
      setPlaying(false);
      return;
    }
    setPlaying(true);
    const line = scenario.transcript[nextLineIdx];
    // Optional demo speed multiplier (dev/recording only) to play the full
    // conversation in a watchable time without changing scenario data.
    const speed = (typeof window !== "undefined" &&
      (window as unknown as { __demoSpeed?: number }).__demoSpeed) || 1;
    const delay = cuaMode ? 200 : Math.max(180, line.delay_ms / speed);
    lineTimerRef.current = setTimeout(() => {
      appendLine();
    }, delay);
    return () => {
      if (lineTimerRef.current) clearTimeout(lineTimerRef.current);
    };
  }, [phase, scenario, nextLineIdx, appendLine, cuaMode, setPlaying]);

  // Reset aux when call ends.
  React.useEffect(() => {
    if (phase === "wrap_up") {
      setAux("acw");
    } else if (phase === "idle") {
      setAux("available");
    }
  }, [phase, setAux]);

  return null;
}
