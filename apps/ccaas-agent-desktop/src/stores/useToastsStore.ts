import { create } from "zustand";

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  variant: "info" | "success" | "warn" | "error";
  /** Stable test/aria id (e.g., "toast-handoff-sent"). */
  toastId?: string;
  /** Milliseconds. Defaults to 5500 (≥5s per CUA guidance). */
  durationMs?: number;
}

interface ToastsState {
  toasts: ToastMessage[];
  push: (t: Omit<ToastMessage, "id">) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

let counter = 0;

export const useToastsStore = create<ToastsState>((set) => ({
  toasts: [],
  push: (t) => {
    counter += 1;
    const id = `toast-${counter}`;
    set((s) => ({ toasts: [...s.toasts, { id, durationMs: 5500, ...t }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] })
}));
