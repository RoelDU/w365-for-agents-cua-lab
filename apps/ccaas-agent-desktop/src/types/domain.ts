export type AuxState =
  | "available"
  | "acw"
  | "break"
  | "lunch"
  | "training"
  | "outbound"
  | "tech_issue"
  | "in_call";

export interface AgentIdentity {
  agent_id: string;
  display_name: string;
  email?: string;
  role: "csr" | "senior_csr" | "claims_manager";
  queue: "auto_claims" | "property_claims" | "supervisor";
  initials: string;
  avatar_color: string;
}

export interface CustomerRecord {
  customer_id: string;
  display_name: string;
  phone: string;
  email: string;
  address: string;
  customer_since: string;
  clv: string;
  preferred_channel: "Phone" | "Email" | "SMS" | "Web chat";
  sentiment: "Positive" | "Neutral" | "Anxious" | "Frustrated";
  policies: Array<{
    number: string;
    type: "Auto" | "Home" | "Umbrella";
    status: "Active" | "Lapsed" | "Cancelled";
    premium: string;
  }>;
  claims: Array<{
    claim_id: string;
    type: string;
    status: "Open" | "Closed" | "In review";
    date: string;
    amount: string;
  }>;
  interactions: Array<{
    when: string;
    channel: "Phone" | "Email" | "Web chat";
    summary: string;
  }>;
  notes_seed: string;
  /** Japanese variant of notes_seed (optional; falls back to notes_seed). */
  notes_seed_ja?: string;
}

export interface TranscriptLine {
  speaker: "Caller" | "Agent" | "System";
  text: string;
  delay_ms: number;
}

export interface HeroScenario {
  key: "jordan_smith" | "morgan_lee" | "pat_rivera";
  caller_display_name: string;
  caller_phone: string;
  policy_number: string;
  intent: import("./contracts").Intent;
  summary_seed: string;
  /** Japanese variant of summary_seed (optional; falls back to summary_seed). */
  summary_seed_ja?: string;
  transcript: TranscriptLine[];
  /** Japanese transcript (optional; falls back to the English transcript). */
  transcript_ja?: TranscriptLine[];
  customer: CustomerRecord;
}

export type Disposition =
  | "resolved"
  | "escalated_ai"
  | "callback"
  | "wrong_number"
  | "abandoned";
