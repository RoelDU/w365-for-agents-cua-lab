import { create } from "zustand";
import type { AgentIdentity } from "@/types/domain";

export interface AuthState {
  agent: AgentIdentity | null;
  setAgent: (agent: AgentIdentity | null) => void;
  signOut: () => void;
}

// The agent identity is the projection of the signed-in Microsoft Entra ID
// account. MSAL's own cache (sessionStorage) is the source of truth for the
// session, so this store is intentionally NOT persisted — a stale agent is
// never restored without a real MSAL session. The identity is re-derived from
// MSAL on each load via completeRedirectSignIn()/getAllAccounts().
export const useAuthStore = create<AuthState>()((set) => ({
  agent: null,
  setAgent: (agent) => set({ agent }),
  signOut: () => set({ agent: null })
}));
