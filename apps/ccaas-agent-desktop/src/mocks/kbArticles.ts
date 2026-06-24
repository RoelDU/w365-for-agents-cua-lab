export interface KbArticle {
  id: string;
  title: string;
  category: "Auto" | "Home" | "Liability" | "Process";
  excerpt: string;
}

export const KB_ARTICLES: KbArticle[] = [
  {
    id: "kb-101",
    title: "Auto collision — first 60 seconds checklist",
    category: "Auto",
    excerpt:
      "Verify driver and passenger safety, confirm location, ask about drivability, and capture the other party's details before opening the FNOL."
  },
  {
    id: "kb-102",
    title: "Home water damage — coverage scope",
    category: "Home",
    excerpt:
      "Sudden and accidental discharge is covered; gradual seepage is excluded. Confirm whether the source has been isolated before quoting reserve."
  },
  {
    id: "kb-103",
    title: "Liability — third-party witness statements",
    category: "Liability",
    excerpt:
      "Always offer the third party an opportunity to provide a statement. Use the recorded-statement consent script before proceeding."
  },
  {
    id: "kb-201",
    title: "Hand off to AI Agent — when and how",
    category: "Process",
    excerpt:
      "Hand off when the FNOL is well-formed and the customer is comfortable holding briefly. The AI Agent will return the claim ID for you to read back."
  },
  {
    id: "kb-202",
    title: "Wrap-up codes — choosing the right disposition",
    category: "Process",
    excerpt:
      "Resolved means the customer's stated goal was met. Escalated to AI Agent means the AI Agent owns the next action. Callback Scheduled requires a date."
  }
];
