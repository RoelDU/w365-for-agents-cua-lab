import { create } from "zustand";
import type { AuxState } from "@/types/domain";

interface AgentStateStore {
  aux: AuxState;
  setAux: (aux: AuxState) => void;
  /** Wall-clock seconds since epoch — recomputed once a second by the
   * AppShell. Stored here so any component can read the latest tick without
   * its own timer. */
  nowSec: number;
  tick: () => void;
}

export const useAgentStateStore = create<AgentStateStore>((set) => ({
  aux: "available",
  setAux: (aux) => set({ aux }),
  nowSec: Math.floor(Date.now() / 1000),
  tick: () => set({ nowSec: Math.floor(Date.now() / 1000) })
}));
