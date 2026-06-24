export interface QueueSnapshot {
  queue_id: "auto_claims" | "property_claims" | "supervisor";
  label: string;
  calls_waiting: number;
  longest_wait_seconds: number;
  service_level_pct: number;
}

export const INITIAL_QUEUE_SNAPSHOT: Record<QueueSnapshot["queue_id"], QueueSnapshot> = {
  auto_claims: {
    queue_id: "auto_claims",
    label: "Auto Claims",
    calls_waiting: 3,
    longest_wait_seconds: 134,
    service_level_pct: 87
  },
  property_claims: {
    queue_id: "property_claims",
    label: "Property Claims",
    calls_waiting: 2,
    longest_wait_seconds: 92,
    service_level_pct: 89
  },
  supervisor: {
    queue_id: "supervisor",
    label: "Supervisor",
    calls_waiting: 0,
    longest_wait_seconds: 0,
    service_level_pct: 100
  }
};

export interface OperationalKpis {
  aht_seconds: number;
  asa_seconds: number;
  service_level_pct: number;
  adherence_pct: number;
  calls_today: number;
  acw_seconds: number;
}

export const TODAY_KPIS: OperationalKpis = {
  aht_seconds: 272, // 4:32
  asa_seconds: 18,
  service_level_pct: 87,
  adherence_pct: 94,
  calls_today: 23,
  acw_seconds: 48
};
