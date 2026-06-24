import type { AgentIdentity } from "@/types/domain";
import { translate, type Lang } from "@/i18n";

export function queueLabel(queue: AgentIdentity["queue"], lang: Lang = "en"): string {
  return translate(lang, `queue.${queue}`);
}

export function roleLabel(role: AgentIdentity["role"], lang: Lang = "en"): string {
  return translate(lang, `role.${role}`);
}
