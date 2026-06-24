import type { AgentIdentity } from "@/types/domain";

/**
 * Sample signed-in agent identities for tests. These mirror the shape produced
 * by accountToIdentity() in src/lib/msalLogin.ts (an Entra account mapped onto
 * an AgentIdentity), replacing the removed AGENT_DIRECTORY picker fixtures.
 */
export const SAMPLE_AGENT: AgentIdentity = {
  agent_id: "entra-00000000-0000-0000-0000-000000000001",
  display_name: "A. Carter",
  email: "acarter@contoso.com",
  role: "csr",
  queue: "auto_claims",
  initials: "AC",
  avatar_color: "#14b8a6"
};

export const SAMPLE_AGENT_2: AgentIdentity = {
  agent_id: "entra-00000000-0000-0000-0000-000000000002",
  display_name: "M. Johnson",
  email: "mjohnson@contoso.com",
  role: "csr",
  queue: "auto_claims",
  initials: "MJ",
  avatar_color: "#6366f1"
};
