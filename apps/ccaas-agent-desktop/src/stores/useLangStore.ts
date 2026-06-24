import { create } from "zustand";
import {
  LANG_STORAGE_KEY,
  resolveInitialLang,
  translate,
  type Lang
} from "@/i18n";

interface LangStore {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

/** Persist the chosen language as a plain string under `ccaas:lang`. */
function persistLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* storage unavailable — selection still lives in the store this session */
  }
}

/**
 * Active-language store. The initial value is resolved once at module load in
 * priority order: URL query param → localStorage → "en" (see resolveInitialLang).
 * Toggling persists to localStorage and updates the store live (no reload).
 */
export const useLangStore = create<LangStore>((set) => ({
  lang: resolveInitialLang(),
  setLang: (lang) => {
    persistLang(lang);
    set({ lang });
  }
}));

/** Subscribe to the active language (re-renders the component on change). */
export function useLang(): Lang {
  return useLangStore((s) => s.lang);
}

export type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Returns a `t("key")` translator bound to the active language. Components that
 * call this re-render automatically when the language toggles.
 */
export function useT(): TFunc {
  const lang = useLangStore((s) => s.lang);
  return (key, vars) => translate(lang, key, vars);
}
