import type { HeroScenario } from "@/types/domain";
import type { Lang } from "@/i18n";

export const HERO_SCENARIOS: HeroScenario[] = [
  {
    key: "jordan_smith",
    caller_display_name: "Jordan Smith",
    caller_phone: "(555) 123-4567",
    policy_number: "POL-2024-008341",
    intent: "auto_collision",
    summary_seed:
      "Rear-ended at intersection of 5th and Main, no injuries reported, both vehicles drivable.",
    summary_seed_ja:
      "5th と Main の交差点で追突される。負傷者なし、両車両とも走行可能。",
    transcript: [
      { speaker: "System", text: "Call connected — Auto Claims queue.", delay_ms: 0 },
      { speaker: "Agent", text: "Zava Mutual, this is A. Carter — who am I speaking with?", delay_ms: 600 },
      { speaker: "Caller", text: "Hi… uh, this is Jordan Smith. I just got in an accident.", delay_ms: 1800 },
      { speaker: "Agent", text: "I'm sorry to hear that. Is everyone okay?", delay_ms: 1400 },
      { speaker: "Caller", text: "Yeah, nobody's hurt. I was stopped at the light at 5th and Main…", delay_ms: 2200 },
      { speaker: "Caller", text: "…around 2:30 this afternoon, and a Honda Civic rear-ended me.", delay_ms: 2200 },
      { speaker: "Agent", text: "Got it. Are both vehicles still drivable?", delay_ms: 1600 },
      { speaker: "Caller", text: "I think so. There's some damage to the bumper but it's not too bad.", delay_ms: 2200 },
      { speaker: "Caller", text: "The other driver gave me their info, I have it right here.", delay_ms: 2000 },
      { speaker: "Agent", text: "Perfect. Let me pull up your policy and start the claim.", delay_ms: 1500 },
      { speaker: "Caller", text: "Sure, my policy is POL-2024-008341.", delay_ms: 2400 },
      { speaker: "Agent", text: "Thanks, Jordan. One moment while I get this filed.", delay_ms: 1500 }
    ],
    transcript_ja: [
      { speaker: "System", text: "通話を接続しました — 自動車保険金請求キュー。", delay_ms: 0 },
      { speaker: "Agent", text: "Zava Mutual の A. Carter でございます。お名前を頂戴できますでしょうか。", delay_ms: 600 },
      { speaker: "Caller", text: "あの…Jordan Smith と申します。たった今、事故に遭ってしまって。", delay_ms: 1800 },
      { speaker: "Agent", text: "それは大変でしたね。皆さまお怪我はございませんか。", delay_ms: 1400 },
      { speaker: "Caller", text: "ええ、誰も怪我はしていません。5th と Main の交差点の信号で停車していたんですが…", delay_ms: 2200 },
      { speaker: "Caller", text: "…今日の午後2時半ごろ、Honda Civic に後ろから追突されました。", delay_ms: 2200 },
      { speaker: "Agent", text: "承知しました。両方のお車はまだ走行可能でしょうか。", delay_ms: 1600 },
      { speaker: "Caller", text: "大丈夫だと思います。バンパーに少し損傷がありますが、ひどくはありません。", delay_ms: 2200 },
      { speaker: "Caller", text: "相手の運転手から連絡先をいただいていて、今手元にあります。", delay_ms: 2000 },
      { speaker: "Agent", text: "承知しました。それではご契約内容を確認し、保険金請求の手続きを始めます。", delay_ms: 1500 },
      { speaker: "Caller", text: "はい、証券番号は POL-2024-008341 です。", delay_ms: 2400 },
      { speaker: "Agent", text: "ありがとうございます、Jordan 様。ただいま手続きいたしますので少々お待ちください。", delay_ms: 1500 }
    ],
    customer: {
      customer_id: "CUST-008341",
      display_name: "Jordan Smith",
      phone: "(555) 123-4567",
      email: "jordan.smith@example.com",
      address: "412 Birchwood Ln, Springfield, IL 62704",
      customer_since: "2019-03-14",
      clv: "$14,820 (Tier 2)",
      preferred_channel: "Phone",
      sentiment: "Neutral",
      policies: [
        { number: "POL-2024-008341", type: "Auto", status: "Active", premium: "$1,420 / yr" },
        { number: "POL-2024-008349", type: "Umbrella", status: "Active", premium: "$310 / yr" }
      ],
      claims: [
        { claim_id: "CLM-2022-001902", type: "Auto — Glass", status: "Closed", date: "2022-11-04", amount: "$640" },
        { claim_id: "CLM-2020-000412", type: "Auto — Collision", status: "Closed", date: "2020-07-18", amount: "$3,180" }
      ],
      interactions: [
        { when: "2024-02-08 14:21", channel: "Phone", summary: "Premium clarification — agent E. Kane" },
        { when: "2023-11-12 09:55", channel: "Email", summary: "Annual renewal confirmation" }
      ],
      notes_seed:
        "Long-tenured policyholder, low risk profile. Prefers a phone callback for follow-ups.",
      notes_seed_ja:
        "長期のご契約者でリスクは低め。フォローアップは電話での折り返しをご希望。"
    }
  },
  {
    key: "morgan_lee",
    caller_display_name: "Morgan Lee",
    caller_phone: "(555) 222-0198",
    policy_number: "POL-2024-002210",
    intent: "home_water",
    summary_seed:
      "Suspected burst pipe under kitchen sink, water across kitchen and adjacent carpeted room.",
    summary_seed_ja:
      "キッチンのシンク下で配管破裂の疑い。キッチンと隣接するカーペット敷きの部屋まで浸水。",
    transcript: [
      { speaker: "System", text: "Call connected — Property Claims queue.", delay_ms: 0 },
      { speaker: "Agent", text: "Zava Mutual property claims, M. Johnson speaking.", delay_ms: 600 },
      { speaker: "Caller", text: "Hi, this is Morgan Lee — I came home from work and there's water everywhere.", delay_ms: 2400 },
      { speaker: "Caller", text: "I think a pipe under the kitchen sink burst.", delay_ms: 2000 },
      { speaker: "Agent", text: "Oh no — did you shut the water off at the main valve?", delay_ms: 1600 },
      { speaker: "Caller", text: "Yes, I did that first. The carpet in the next room is soaked through though.", delay_ms: 2400 },
      { speaker: "Agent", text: "Smart. I'll get this filed. Do you have your policy number?", delay_ms: 1800 },
      { speaker: "Caller", text: "Yeah, hold on… POL-2024-002210.", delay_ms: 2400 },
      { speaker: "Agent", text: "Got it. Let me pull up your policy.", delay_ms: 1400 }
    ],
    transcript_ja: [
      { speaker: "System", text: "通話を接続しました — 住宅保険金請求キュー。", delay_ms: 0 },
      { speaker: "Agent", text: "Zava Mutual 住宅保険金請求担当の M. Johnson でございます。", delay_ms: 600 },
      { speaker: "Caller", text: "もしもし、Morgan Lee と申します。仕事から帰宅したら、家じゅう水浸しになっていて。", delay_ms: 2400 },
      { speaker: "Caller", text: "キッチンのシンク下の配管が破裂したのだと思います。", delay_ms: 2000 },
      { speaker: "Agent", text: "それは大変です。元栓は閉めていただけましたか。", delay_ms: 1600 },
      { speaker: "Caller", text: "はい、まずそれをしました。ただ、隣の部屋のカーペットがびしょ濡れです。", delay_ms: 2400 },
      { speaker: "Agent", text: "適切なご対応です。すぐに手続きいたします。証券番号はお分かりになりますか。", delay_ms: 1800 },
      { speaker: "Caller", text: "はい、少々お待ちを…POL-2024-002210 です。", delay_ms: 2400 },
      { speaker: "Agent", text: "承知しました。ご契約内容を確認いたします。", delay_ms: 1400 }
    ],
    customer: {
      customer_id: "CUST-002210",
      display_name: "Morgan Lee",
      phone: "(555) 222-0198",
      email: "morgan.lee@example.com",
      address: "27 Hilltop Crescent, Madison, WI 53703",
      customer_since: "2021-08-30",
      clv: "$9,400 (Tier 3)",
      preferred_channel: "Web chat",
      sentiment: "Anxious",
      policies: [
        { number: "POL-2024-002210", type: "Home", status: "Active", premium: "$1,860 / yr" }
      ],
      claims: [],
      interactions: [
        { when: "2024-01-22 18:10", channel: "Web chat", summary: "Roof inspection rider question" }
      ],
      notes_seed:
        "First claim. Caller is shaken — keep tone reassuring and confirm the temporary repair coverage.",
      notes_seed_ja:
        "初めての請求。発信者は動揺しているため、安心感を与える口調で一時的な修理補償をご案内すること。"
    }
  },
  {
    key: "pat_rivera",
    caller_display_name: "Pat Rivera",
    caller_phone: "(555) 444-7711",
    policy_number: "POL-2024-005544",
    intent: "fraud_investigation",
    summary_seed:
      "Internal supervisor escalation: three claims flagged this week with a pattern of round-dollar losses across different customers.",
    summary_seed_ja:
      "社内スーパーバイザーへのエスカレーション。今週、異なる顧客にまたがるきりのよい金額の損害というパターンで3件の請求にフラグ。",
    transcript: [
      { speaker: "System", text: "Internal call — Supervisor queue.", delay_ms: 0 },
      { speaker: "Agent", text: "Supervisor desk, R. Davis.", delay_ms: 500 },
      { speaker: "Caller", text: "Pat Rivera from fraud investigations.", delay_ms: 1600 },
      { speaker: "Caller", text: "I'm calling to follow up on three claims that were flagged this week.", delay_ms: 2400 },
      { speaker: "Caller", text: "The pattern of round-dollar losses across different customers stood out.", delay_ms: 2400 },
      { speaker: "Agent", text: "Understood. Let me pull the FNOLs for those.", delay_ms: 1800 },
      { speaker: "Caller", text: "Thanks. I think we should escalate to the AI agent for the pattern review.", delay_ms: 2400 }
    ],
    transcript_ja: [
      { speaker: "System", text: "内部通話 — スーパーバイザーキュー。", delay_ms: 0 },
      { speaker: "Agent", text: "スーパーバイザー窓口の R. Davis です。", delay_ms: 500 },
      { speaker: "Caller", text: "不正調査担当の Pat Rivera です。", delay_ms: 1600 },
      { speaker: "Caller", text: "今週フラグが立った3件の請求について、確認のためご連絡しました。", delay_ms: 2400 },
      { speaker: "Caller", text: "異なる顧客にまたがる、きりのよい金額の損害というパターンが目立っていました。", delay_ms: 2400 },
      { speaker: "Agent", text: "承知しました。該当する初回事故報告（FNOL）を確認します。", delay_ms: 1800 },
      { speaker: "Caller", text: "ありがとうございます。パターン分析のため、AIエージェントにエスカレーションすべきだと考えています。", delay_ms: 2400 }
    ],
    customer: {
      customer_id: "CUST-005544",
      display_name: "Pat Rivera",
      phone: "(555) 444-7711",
      email: "pat.rivera@zavamutual.demo",
      address: "Internal — Fraud Investigations Unit",
      customer_since: "2017-04-01",
      clv: "Internal — n/a",
      preferred_channel: "Phone",
      sentiment: "Neutral",
      policies: [
        { number: "POL-2024-005544", type: "Auto", status: "Active", premium: "Internal" }
      ],
      claims: [
        { claim_id: "CLM-2024-000118", type: "Auto — Theft", status: "In review", date: "2024-04-09", amount: "$8,000" },
        { claim_id: "CLM-2024-000121", type: "Auto — Theft", status: "In review", date: "2024-04-11", amount: "$9,000" },
        { claim_id: "CLM-2024-000124", type: "Auto — Theft", status: "In review", date: "2024-04-13", amount: "$7,000" }
      ],
      interactions: [
        { when: "2024-04-14 11:02", channel: "Email", summary: "Pattern detection alert — see fraud queue" }
      ],
      notes_seed:
        "Internal investigation — hand off to AI agent for the cross-claim pattern review.",
      notes_seed_ja:
        "社内調査。クロスクレームのパターン分析のため、AIエージェントへ引き継ぐこと。"
    }
  }
];

/**
 * Apply the active language to a scenario's free-prose content (transcript,
 * notes seed, summary seed). Structure, timing, IDs and proper nouns are
 * untouched; English is returned as-is so the default build is unchanged.
 */
function localizeScenario(scenario: HeroScenario, lang: Lang): HeroScenario {
  if (lang !== "ja") return scenario;
  return {
    ...scenario,
    summary_seed: scenario.summary_seed_ja ?? scenario.summary_seed,
    transcript: scenario.transcript_ja ?? scenario.transcript,
    customer: {
      ...scenario.customer,
      notes_seed: scenario.customer.notes_seed_ja ?? scenario.customer.notes_seed
    }
  };
}

export function getScenarioByKey(
  key: HeroScenario["key"] | undefined,
  lang: Lang = "en"
): HeroScenario {
  const scenario = HERO_SCENARIOS.find((s) => s.key === key) ?? HERO_SCENARIOS[0];
  return localizeScenario(scenario, lang);
}
