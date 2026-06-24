import { create } from "zustand";
import type { Disposition, HeroScenario, TranscriptLine } from "@/types/domain";
import { HERO_SCENARIOS, getScenarioByKey } from "@/mocks/heroScenarios";
import { useLangStore } from "@/stores/useLangStore";

export type CallPhase = "idle" | "ringing" | "talking" | "wrap_up";

interface PlayedLine extends TranscriptLine {
  id: string;
  played_at_iso: string;
}

interface CallStoreState {
  phase: CallPhase;
  scenarioKey: HeroScenario["key"];
  scenario: HeroScenario | null;
  startedAtMs: number | null;
  durationSec: number;
  isOnHold: boolean;
  isMuted: boolean;
  notes: string;
  disposition: Disposition | "";
  transcript: PlayedLine[];
  /** Index of the next line to play from the scenario script. */
  nextLineIdx: number;
  /** Set by the playback driver — true while a typewriter is active. */
  isPlaying: boolean;
  // actions
  selectScenario: (key: HeroScenario["key"]) => void;
  startRinging: () => void;
  answerCall: (nowMs?: number) => void;
  endCall: () => void;
  toggleHold: () => void;
  toggleMute: () => void;
  setNotes: (n: string) => void;
  setDisposition: (d: Disposition | "") => void;
  appendTranscriptLine: () => PlayedLine | null;
  tickDuration: () => void;
  setPlaying: (on: boolean) => void;
  /** Re-localize the active scenario and already-played transcript lines to the
   * current language (called when the language toggle changes mid/post-call). */
  relocalize: () => void;
  /** Returns the last `windowMs` of transcript as a single string suitable
   * for the CallContext.transcript_excerpt field. */
  getTranscriptExcerpt: (windowMs?: number) => string;
  reset: () => void;
}

const initial: Pick<
  CallStoreState,
  | "phase"
  | "scenarioKey"
  | "scenario"
  | "startedAtMs"
  | "durationSec"
  | "isOnHold"
  | "isMuted"
  | "notes"
  | "disposition"
  | "transcript"
  | "nextLineIdx"
  | "isPlaying"
> = {
  phase: "idle",
  scenarioKey: "jordan_smith",
  scenario: null,
  startedAtMs: null,
  durationSec: 0,
  isOnHold: false,
  isMuted: false,
  notes: "",
  disposition: "",
  transcript: [],
  nextLineIdx: 0,
  isPlaying: false
};

let lineCounter = 0;

export const useCallStore = create<CallStoreState>((set, get) => ({
  ...initial,
  selectScenario: (key) => {
    const scenario = getScenarioByKey(key, useLangStore.getState().lang);
    set({ scenarioKey: key, scenario });
  },
  startRinging: () => {
    const scenario = getScenarioByKey(
      get().scenarioKey ?? HERO_SCENARIOS[0].key,
      useLangStore.getState().lang
    );
    set({
      phase: "ringing",
      scenario,
      transcript: [],
      nextLineIdx: 0,
      durationSec: 0,
      startedAtMs: null,
      isOnHold: false,
      isMuted: false,
      notes: scenario.customer.notes_seed,
      disposition: ""
    });
  },
  answerCall: (nowMs = Date.now()) => {
    set({ phase: "talking", startedAtMs: nowMs, durationSec: 0 });
  },
  endCall: () => {
    set({ phase: "wrap_up", isPlaying: false });
  },
  toggleHold: () => set((s) => ({ isOnHold: !s.isOnHold })),
  toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),
  setNotes: (n) => set({ notes: n }),
  setDisposition: (d) => set({ disposition: d }),
  appendTranscriptLine: () => {
    const { scenario, nextLineIdx, transcript } = get();
    if (!scenario || nextLineIdx >= scenario.transcript.length) {
      return null;
    }
    const src = scenario.transcript[nextLineIdx];
    lineCounter += 1;
    const next: PlayedLine = {
      ...src,
      id: `line-${lineCounter}`,
      played_at_iso: new Date().toISOString()
    };
    set({
      transcript: [...transcript, next],
      nextLineIdx: nextLineIdx + 1
    });
    return next;
  },
  tickDuration: () => {
    const { phase, startedAtMs } = get();
    if (phase === "talking" && startedAtMs) {
      set({ durationSec: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)) });
    }
  },
  setPlaying: (on) => set({ isPlaying: on }),
  relocalize: () => {
    const { scenario, scenarioKey, transcript, notes } = get();
    if (!scenario) return;
    const lang = useLangStore.getState().lang;
    const localized = getScenarioByKey(scenarioKey, lang);
    // EN and JA transcripts are parallel (same length/order/speaker per index),
    // so already-played lines can be re-mapped to the new language by index.
    const newTranscript = transcript.map((line, i) => {
      const src = localized.transcript[i];
      return src ? { ...line, text: src.text } : line;
    });
    // Only re-localize the notes field if the operator hasn't edited the seed.
    const notesUnedited = notes === scenario.customer.notes_seed;
    set({
      scenario: localized,
      transcript: newTranscript,
      notes: notesUnedited ? localized.customer.notes_seed : notes
    });
  },
  getTranscriptExcerpt: (windowMs = 30_000) => {
    const { transcript } = get();
    if (transcript.length === 0) return "";
    const cutoff = Date.now() - windowMs;
    const recent = transcript.filter((l) => new Date(l.played_at_iso).getTime() >= cutoff);
    const lines = recent.length > 0 ? recent : transcript.slice(-6);
    return lines.map((l) => `${l.speaker}: ${l.text}`).join("\n");
  },
  reset: () => set({ ...initial, scenarioKey: get().scenarioKey })
}));

// Re-localize the active call (scenario + already-played transcript lines) when
// the language toggle changes, so switching to 日本語 mid/post-call translates the
// simulated customer conversation, not just the static UI chrome.
let lastKnownLang = useLangStore.getState().lang;
useLangStore.subscribe((state) => {
  if (state.lang !== lastKnownLang) {
    lastKnownLang = state.lang;
    useCallStore.getState().relocalize();
  }
});
