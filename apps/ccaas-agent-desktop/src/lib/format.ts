/**
 * Tiny formatter helpers used throughout the UI. The pure time formatters are
 * dependency-free; the label helpers accept an optional `lang` (defaulting to
 * English) so English output is unchanged when no language is selected.
 */
import { translate, type Lang } from "@/i18n";

export function formatMmSs(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function formatHhMmSs(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function formatClock(d: Date): string {
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export function intentLabel(intent: string, lang: Lang = "en"): string {
  const key = `intent.${intent}`;
  const translated = translate(lang, key);
  // Fall back to humanized snake_case when the intent has no explicit entry
  // (keeps the English behavior for any unmapped/dynamic intent value).
  if (translated !== key) return translated;
  return intent
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function dispositionLabel(d: string, lang: Lang = "en"): string {
  const key = `disposition.${d}`;
  const translated = translate(lang, key);
  return translated === key ? d : translated;
}

export function auxLabel(state: string, lang: Lang = "en"): string {
  const key = `aux.${state}`;
  const translated = translate(lang, key);
  return translated === key ? state : translated;
}

/** Localized transcript speaker label (System/Agent/Caller). */
export function speakerLabel(speaker: string, lang: Lang = "en"): string {
  const key = `speaker.${speaker}`;
  const translated = translate(lang, key);
  return translated === key ? speaker : translated;
}

/** Localized customer sentiment value. */
export function sentimentLabel(value: string, lang: Lang = "en"): string {
  const key = `sentiment.${value}`;
  const translated = translate(lang, key);
  return translated === key ? value : translated;
}

/** Localized contact-channel value (Phone/Email/SMS/Web chat). */
export function channelLabel(value: string, lang: Lang = "en"): string {
  const key = `channel.${value}`;
  const translated = translate(lang, key);
  return translated === key ? value : translated;
}

/** Localized policy type value (Auto/Home/Umbrella). */
export function policyTypeLabel(value: string, lang: Lang = "en"): string {
  const key = `ptype.${value}`;
  const translated = translate(lang, key);
  return translated === key ? value : translated;
}

/** Localized policy/claim status value (Active/Closed/In review/…). */
export function policyStatusLabel(value: string, lang: Lang = "en"): string {
  const key = `pstatus.${value}`;
  const translated = translate(lang, key);
  return translated === key ? value : translated;
}

export function auxDotClass(state: string): string {
  switch (state) {
    case "available":
      return "bg-ok-500";
    case "in_call":
      return "bg-accent-500";
    case "acw":
    case "outbound":
      return "bg-warn-500";
    case "tech_issue":
      return "bg-danger-500";
    default:
      return "bg-muted-500";
  }
}
