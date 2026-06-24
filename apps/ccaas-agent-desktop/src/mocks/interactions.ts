export interface InteractionRow {
  id: string;
  when: string;
  caller: string;
  channel: "Phone" | "Email" | "Web chat";
  queue: string;
  duration: string;
  disposition: string;
}

export const RECENT_INTERACTIONS: InteractionRow[] = [
  {
    id: "INT-9821",
    when: "Today 09:14",
    caller: "Drew Patel",
    channel: "Phone",
    queue: "Auto Claims",
    duration: "06:12",
    disposition: "Resolved"
  },
  {
    id: "INT-9818",
    when: "Today 08:41",
    caller: "Sam Nakamura",
    channel: "Phone",
    queue: "Auto Claims",
    duration: "04:28",
    disposition: "Escalated to AI Agent"
  },
  {
    id: "INT-9803",
    when: "Yesterday 17:02",
    caller: "Riley Brooks",
    channel: "Web chat",
    queue: "Property Claims",
    duration: "11:05",
    disposition: "Callback Scheduled"
  },
  {
    id: "INT-9798",
    when: "Yesterday 14:33",
    caller: "Casey Yoon",
    channel: "Phone",
    queue: "Auto Claims",
    duration: "03:11",
    disposition: "Wrong Number"
  }
];
