/**
 * Lightweight, dependency-free i18n for the Zava Contact Center demo desktop.
 *
 * English is the canonical/default language and is byte-for-byte unchanged from
 * the pre-localization build. Japanese is a fully selectable second language.
 *
 * This module is intentionally pure (no React, no store imports) so it can be
 * unit-tested and consumed by both the zustand store and the label helpers
 * without import cycles. The React hooks (`useLang`, `useT`) live in
 * `@/stores/useLangStore`.
 */

export type Lang = "en" | "ja";

export const SUPPORTED_LANGS: readonly Lang[] = ["en", "ja"] as const;

/** localStorage key used to persist the user's language selection. */
export const LANG_STORAGE_KEY = "ccaas:lang";

/** URL query parameter that can force a language at startup (e.g. ?lang=ja). */
export const LANG_QUERY_PARAM = "lang";

export function isLang(value: unknown): value is Lang {
  return value === "en" || value === "ja";
}

/**
 * Resolve the active language at startup, in priority order:
 *   1. URL query param `?lang=ja` / `?lang=en`
 *   2. localStorage key `ccaas:lang`
 *   3. default `"en"`
 *
 * Both inputs are injectable to keep this trivially testable.
 */
export function resolveInitialLang(
  search: string = typeof window !== "undefined" ? window.location.search : "",
  storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null
): Lang {
  try {
    const params = new URLSearchParams(search);
    const fromUrl = params.get(LANG_QUERY_PARAM);
    if (isLang(fromUrl)) return fromUrl;
  } catch {
    /* malformed search string — fall through */
  }
  try {
    const fromStorage = storage?.getItem(LANG_STORAGE_KEY);
    if (isLang(fromStorage)) return fromStorage;
  } catch {
    /* storage unavailable — fall through */
  }
  return "en";
}

type Dict = Record<string, string>;

/**
 * Key-based message catalog. Keys are dot-namespaced by surface. Every key that
 * exists in `en` should exist in `ja`. Missing JA keys fall back to EN, then to
 * the raw key, so the UI never renders blank.
 */
const en: Dict = {
  // Brand / TopBar
  "brand.contactCenter": "Contact Center",
  "topbar.queue": "Queue",
  "topbar.waiting": "waiting",
  "topbar.longest": "longest",
  "topbar.queueTooltip":
    "Calls waiting in the {queue} queue. Service level (last 30 min): {pct}% ≤ 20 s.",
  "topbar.resetDemo": "Reset demo",
  "topbar.resetDemoTooltip":
    "Clear the active call and AI agent handoff to start the next demo cleanly (no page reload).",
  "topbar.onCall": "On Call",
  "topbar.auxState": "Aux state",
  "topbar.signOut": "Sign out",
  "topbar.clockTooltip": "Local system time (24-hour).",
  "topbar.agentAria": "Agent {name}, current state {state}",
  "topbar.langToggleAria": "Language",
  "toast.demoReset.title": "Demo reset",
  "toast.demoReset.desc": "Call and AI agent cleared — ready for the next run.",

  // LeftNav
  "nav.calls": "Calls",
  "nav.interactions": "Interactions",
  "nav.knowledge": "Knowledge",
  "nav.stats": "Statistics",
  "nav.settings": "Settings",
  "nav.demoBuild": "Demo build",

  // StatusBar
  "status.simulatedCcaas": "Simulated CCaaS",
  "status.simulatedCcaasAria": "Simulated CCaaS indicator",
  "status.orchestrator": "Orchestrator",
  "status.cuaMode": "CUA mode",
  "status.build": "Build",
  "status.demoNotice": "Demonstration build — fictional contact center.",
  "status.agent": "Agent",
  "status.orchestratorUnknownAria": "Orchestrator status unknown",
  "status.orchestratorReachableAria": "Orchestrator reachable",
  "status.orchestratorUnreachableAria": "Orchestrator unreachable",
  "status.orchestratorUnconfiguredTip":
    "MCS orchestrator URL not configured (VITE_ORCHESTRATOR_URL). The desktop is on the deprecated /api (Foundry) endpoint, which 502s the handoff. Set the orchestrator URL in Settings.",
  "status.orchestratorCheckingTip": "Checking orchestrator reachability…",
  "status.orchestratorOnlineTip": "Orchestrator API responded to /health.",
  "status.orchestratorOfflineTip":
    "Orchestrator API unreachable — the handoff POST will fail until it is back.",

  // LoginScreen
  "login.workspaceSub": "Contact Center · Agent Workspace",
  "login.demoBadge": "Demonstration build · fictional contact center",
  "login.title": "Sign in to your agent workspace",
  "login.subtitleEntra":
    "Sign in with your Microsoft work account to access the agent workspace.",
  "login.signInMicrosoft": "Sign in with Microsoft",
  "login.signingIn": "Signing in…",
  "login.disclaimer":
    "This app does not connect to real telephony, CCaaS providers, or call recording. All conversation data is fabricated.",
  "toast.entra.title": "Entra ID sign-in",

  // ActiveCallPanel
  "call.activeCall": "Active Call",
  "call.noCall": "No call",
  "call.noActiveInteraction": "No active interaction",
  "call.pickScenario":
    "Pick a scenario and simulate an inbound call to begin the demo.",
  "call.simulateInbound": "Simulate Inbound Call",
  "call.ringing": "Ringing…",
  "call.inCall": "In Call",
  "call.wrapUp": "Wrap-up",
  "call.answer": "Answer",
  "call.hold": "Hold",
  "call.resume": "Resume",
  "call.mute": "Mute",
  "call.unmute": "Unmute",
  "call.transfer": "Transfer",
  "call.conference": "Conference",
  "call.hangup": "Hangup",
  "call.awaitingFirstLine": "Awaiting first line…",
  "toast.conference.title": "Conference",
  "toast.conference.desc":
    "Demo build — conference is not implemented in this simulation.",
  "speaker.System": "System",
  "speaker.Agent": "Agent",
  "speaker.Caller": "Caller",

  // Customer360Panel
  "c360.title": "Customer 360",
  "c360.noScreenPop": "No screen-pop",
  "c360.emptyState": "Customer details appear here when a call connects.",
  "c360.verifiedCaller": "Verified caller",
  "c360.customerSince": "Customer since {date}",
  "tab.overview": "Overview",
  "tab.policies": "Policies",
  "tab.claims": "Claims",
  "tab.notes": "Notes",
  "tab.interactions": "Interactions",
  "field.phone": "Phone",
  "field.email": "Email",
  "field.address": "Address",
  "field.preferredChannel": "Preferred channel",
  "field.clv": "CLV",
  "field.sentiment": "Sentiment",
  "th.policyNumber": "Policy #",
  "th.type": "Type",
  "th.status": "Status",
  "th.premium": "Premium",
  "th.claimId": "Claim ID",
  "th.date": "Date",
  "th.amount": "Amount",
  "th.when": "When",
  "th.channel": "Channel",
  "th.summary": "Summary",
  "c360.noClaims": "No prior claims on file.",
  "c360.notesInMemory":
    "Notes are in-memory only — they do not persist between calls.",
  "c360.notesAria": "Free-form call notes",

  // RightRail
  "rail.title": "Wrap-up & Transfer",
  "rail.aiEngaged": "AI Agent engaged",
  "rail.agentNotes": "Agent notes",
  "rail.notesPlaceholder": "Type notes for this interaction…",
  "rail.disposition": "Disposition",
  "rail.selectPlaceholder": "— select —",
  "rail.transferInteraction": "Transfer interaction…",
  "rail.transferAria": "Transfer this interaction",
  "toast.transferQueue.title": "Interaction transferred",
  "toast.transferQueue.desc":
    "Routed to {name}. (Demo build — human queues are not simulated.)",
  "toast.handoffInitiated.title": "Handoff initiated",
  "toast.handoffConnecting.desc": "Connecting to the AI agent's Cloud PC…",
  "toast.handoffSent.desc": "Request {id} sent to the AI agent.",
  "toast.callContextInvalid.title": "Invalid CallContext payload",
  "toast.orchestratorUnconfigured.title": "Orchestrator not configured",
  "toast.handoffFailed.title": "Handoff failed",
  "toast.handoffFailed.desc":
    "{reason}. Check the orchestrator URL in Settings and retry.",
  "toast.handoffIncomplete.title": "Handoff incomplete",
  "toast.handoffIncomplete.desc":
    "The orchestrator accepted the handoff but returned no job to track.",

  // AIAgentStatusCard
  "ai.title": "AI Agent Status",
  "ai.status.idle": "Idle.",
  "ai.status.queued": "Queued — waiting for the AI agent to pick up the task…",
  "ai.status.prefilled": "AI agent has the call context and is filling the claim.",
  "ai.status.ready": "AI agent is driving the claims system — you're monitoring.",
  "ai.status.submitted":
    "Claim created. Confirm with the caller and dispose the call.",
  "ai.status.error": "Something went wrong — see details below.",
  "ai.liveAgentDesktop": "Live agent desktop",
  "ai.agentDesktopDone": "Agent desktop · done",
  "ai.expand": "Expand",
  "ai.expandAria": "Expand live agent desktop",
  "ai.expandTitle": "Expand (theater view)",
  "ai.collapse": "Close",
  "ai.collapseAria": "Close theater view",
  "ai.collapseTitle": "Close (back to workspace)",
  "ai.acquiring":
    "Acquiring a secure Windows 365 Cloud PC for the AI agent…",
  "ai.theaterTitleLive": "Live AI agent desktop · Windows 365 Cloud PC",
  "ai.theaterTitleDone": "AI agent desktop · claim filed",
  "ai.theaterSrTitle": "Live AI agent desktop",
  "ai.theaterSrDesc":
    "Enlarged live view of the AI agent driving the Windows 365 Cloud PC.",
  "ai.liveScreenshotAlt": "Live AI agent desktop",
  "ai.liveScreenshotLargeAlt": "Live AI agent desktop (enlarged)",
  "ai.claimFiled": "Claim filed:",
  "ai.claimSubmitted": "Claim submitted",
  "ai.policy": "Policy",
  "ai.submittedBy": "Submitted by",
  "ai.reserve": "Reserve",
  "ai.copyClaimId": "Copy claim ID",
  "ai.request": "Request",
  "ai.retry": "Retry",
  "ai.fallbackManual": "Fall back to manual",
  "ai.frames": "{n} frame{s}",
  "toast.claimReady.title": "Claim ready",
  "toast.claimReady.desc":
    "Claim {id} ready to communicate to caller. Copied to clipboard.",

  // HandoffModal
  "handoff.title": "Transfer to AI Agent",
  "handoff.summaryLabel": "Summary for the AI Agent",
  "handoff.charCount": "{n}/1000 characters",
  "handoff.handoverContext": "Handover context",
  "handoff.caller": "Caller",
  "handoff.intent": "Intent",
  "handoff.phone": "Phone",
  "handoff.policy": "Policy",
  "handoff.requestId": "Request ID",
  "handoff.requestedBy": "Requested by",
  "handoff.notProvided": "Not provided",
  "handoff.viewPayload": "View payload (JSON wire contract)",
  "handoff.copyJson": "Copy JSON",
  "handoff.cancel": "Cancel",
  "handoff.confirm": "Transfer to AI Agent",

  // TransferDirectory
  "dir.title": "Transfer interaction",
  "dir.desc":
    "Route this live interaction to another destination. The attached interaction context travels automatically with the transfer — the same routing model real contact centers use (Amazon Connect transfer-to-queue, Twilio TaskRouter, D365 workstream routing).",
  "dir.aiAgents": "AI Agents",
  "dir.aiAgentName": "Claims Automation Agent",
  "dir.aiAgentAria": "Transfer to AI Agent",
  "dir.aiAgentSubtitle":
    "Microsoft Copilot Studio agent + Computer Use · context auto-attached (Direct Line channel adapter)",
  "dir.queuesTeams": "Queues & Teams",
  "dir.queue.claimsT2": "Claims — Tier 2",
  "dir.queue.claimsT2.detail": "Senior CSR queue · ~3 waiting",
  "dir.queue.property": "Property Claims",
  "dir.queue.property.detail": "Specialist queue · ~1 waiting",
  "dir.queue.supervisor": "Supervisor / Escalations",
  "dir.queue.supervisor.detail": "Manager queue",

  // Domain enum display values
  "queue.auto_claims": "Auto Claims",
  "queue.property_claims": "Property Claims",
  "queue.supervisor": "Supervisor",
  "role.csr": "CSR",
  "role.senior_csr": "Senior CSR",
  "role.claims_manager": "Claims Manager",
  "aux.available": "Available",
  "aux.acw": "After Call Work",
  "aux.break": "Break",
  "aux.lunch": "Lunch",
  "aux.training": "Training",
  "aux.outbound": "Outbound",
  "aux.tech_issue": "Tech Issue",
  "aux.in_call": "In Call",
  "disposition.resolved": "Resolved",
  "disposition.escalated_ai": "Escalated to AI Agent",
  "disposition.callback": "Callback Scheduled",
  "disposition.wrong_number": "Wrong Number",
  "disposition.abandoned": "Abandoned",
  "intent.auto_collision": "Auto Collision",
  "intent.home_water": "Home Water",
  "intent.fraud_investigation": "Fraud Investigation",
  "sentiment.Positive": "Positive",
  "sentiment.Neutral": "Neutral",
  "sentiment.Anxious": "Anxious",
  "sentiment.Frustrated": "Frustrated",
  "channel.Phone": "Phone",
  "channel.Email": "Email",
  "channel.SMS": "SMS",
  "channel.Web chat": "Web chat",
  "ptype.Auto": "Auto",
  "ptype.Home": "Home",
  "ptype.Umbrella": "Umbrella",
  "pstatus.Active": "Active",
  "pstatus.Lapsed": "Lapsed",
  "pstatus.Cancelled": "Cancelled",
  "pstatus.Open": "Open",
  "pstatus.Closed": "Closed",
  "pstatus.In review": "In review"
};

const ja: Dict = {
  // Brand / TopBar
  "brand.contactCenter": "コンタクトセンター",
  "topbar.queue": "キュー",
  "topbar.waiting": "件待機",
  "topbar.longest": "最長待ち",
  "topbar.queueTooltip":
    "{queue}キューで待機中の通話です。サービスレベル（直近30分）：{pct}% が20秒以内。",
  "topbar.resetDemo": "デモをリセット",
  "topbar.resetDemoTooltip":
    "アクティブな通話とAIエージェントへの引き継ぎをクリアし、次のデモをクリーンな状態で開始します（ページの再読み込みは不要です）。",
  "topbar.onCall": "通話中",
  "topbar.auxState": "補助ステータス",
  "topbar.signOut": "サインアウト",
  "topbar.clockTooltip": "ローカルのシステム時刻（24時間表記）。",
  "topbar.agentAria": "エージェント {name}、現在のステータスは{state}",
  "topbar.langToggleAria": "言語",
  "toast.demoReset.title": "デモをリセットしました",
  "toast.demoReset.desc":
    "通話とAIエージェントをクリアしました。次の実行の準備が整いました。",

  // LeftNav
  "nav.calls": "通話",
  "nav.interactions": "対応履歴",
  "nav.knowledge": "ナレッジ",
  "nav.stats": "統計",
  "nav.settings": "設定",
  "nav.demoBuild": "デモビルド",

  // StatusBar
  "status.simulatedCcaas": "シミュレーションCCaaS",
  "status.simulatedCcaasAria": "シミュレーションCCaaSインジケーター",
  "status.orchestrator": "オーケストレーター",
  "status.cuaMode": "CUAモード",
  "status.build": "ビルド",
  "status.demoNotice": "デモンストレーション用ビルド — 架空のコンタクトセンターです。",
  "status.agent": "エージェント",
  "status.orchestratorUnknownAria": "オーケストレーターのステータス不明",
  "status.orchestratorReachableAria": "オーケストレーターに到達可能",
  "status.orchestratorUnreachableAria": "オーケストレーターに到達不可",
  "status.orchestratorUnconfiguredTip":
    "MCSオーケストレーターのURLが未設定です（VITE_ORCHESTRATOR_URL）。デスクトップは非推奨の /api（Foundry）エンドポイントを使用しており、引き継ぎが502エラーになります。設定画面でオーケストレーターのURLを指定してください。",
  "status.orchestratorCheckingTip": "オーケストレーターの到達性を確認しています…",
  "status.orchestratorOnlineTip": "オーケストレーターAPIが /health に応答しました。",
  "status.orchestratorOfflineTip":
    "オーケストレーターAPIに到達できません。復旧するまで引き継ぎのPOSTは失敗します。",

  // LoginScreen
  "login.workspaceSub": "コンタクトセンター · エージェントワークスペース",
  "login.demoBadge": "デモンストレーション用ビルド · 架空のコンタクトセンター",
  "login.title": "エージェントワークスペースにサインイン",
  "login.subtitleEntra":
    "Microsoft の職場アカウントでサインインしてエージェントワークスペースにアクセスします。",
  "login.signInMicrosoft": "Microsoft でサインイン",
  "login.signingIn": "サインインしています…",
  "login.disclaimer":
    "このアプリは実際の電話システム、CCaaSプロバイダー、通話録音には接続していません。すべての会話データは架空のものです。",
  "toast.entra.title": "Entra ID サインイン",

  // ActiveCallPanel
  "call.activeCall": "アクティブな通話",
  "call.noCall": "通話なし",
  "call.noActiveInteraction": "アクティブな対応はありません",
  "call.pickScenario":
    "シナリオを選択し、着信をシミュレートしてデモを開始してください。",
  "call.simulateInbound": "着信をシミュレート",
  "call.ringing": "呼び出し中…",
  "call.inCall": "通話中",
  "call.wrapUp": "後処理",
  "call.answer": "応答",
  "call.hold": "保留",
  "call.resume": "再開",
  "call.mute": "ミュート",
  "call.unmute": "ミュート解除",
  "call.transfer": "転送",
  "call.conference": "会議通話",
  "call.hangup": "切断",
  "call.awaitingFirstLine": "最初の発言を待っています…",
  "toast.conference.title": "会議通話",
  "toast.conference.desc":
    "デモビルドです。このシミュレーションでは会議通話は実装されていません。",
  "speaker.System": "システム",
  "speaker.Agent": "エージェント",
  "speaker.Caller": "発信者",

  // Customer360Panel
  "c360.title": "カスタマー360",
  "c360.noScreenPop": "スクリーンポップなし",
  "c360.emptyState": "通話が接続されると、ここに顧客情報が表示されます。",
  "c360.verifiedCaller": "本人確認済み",
  "c360.customerSince": "ご契約開始：{date}",
  "tab.overview": "概要",
  "tab.policies": "契約",
  "tab.claims": "保険金請求",
  "tab.notes": "メモ",
  "tab.interactions": "対応履歴",
  "field.phone": "電話番号",
  "field.email": "メールアドレス",
  "field.address": "住所",
  "field.preferredChannel": "希望の連絡手段",
  "field.clv": "顧客生涯価値",
  "field.sentiment": "感情",
  "th.policyNumber": "証券番号",
  "th.type": "種別",
  "th.status": "ステータス",
  "th.premium": "保険料",
  "th.claimId": "請求ID",
  "th.date": "日付",
  "th.amount": "金額",
  "th.when": "日時",
  "th.channel": "チャネル",
  "th.summary": "概要",
  "c360.noClaims": "過去の保険金請求の記録はありません。",
  "c360.notesInMemory":
    "メモはメモリ上にのみ保持され、通話間では保存されません。",
  "c360.notesAria": "自由記述の通話メモ",

  // RightRail
  "rail.title": "後処理と転送",
  "rail.aiEngaged": "AIエージェント対応中",
  "rail.agentNotes": "エージェントメモ",
  "rail.notesPlaceholder": "この対応に関するメモを入力…",
  "rail.disposition": "対応区分",
  "rail.selectPlaceholder": "— 選択 —",
  "rail.transferInteraction": "対応を転送…",
  "rail.transferAria": "この対応を転送",
  "toast.transferQueue.title": "対応を転送しました",
  "toast.transferQueue.desc":
    "{name} にルーティングしました。（デモビルドのため、人間のキューはシミュレートされません。）",
  "toast.handoffInitiated.title": "引き継ぎを開始しました",
  "toast.handoffConnecting.desc": "AIエージェントのクラウドPCに接続しています…",
  "toast.handoffSent.desc": "リクエスト {id} をAIエージェントに送信しました。",
  "toast.callContextInvalid.title": "CallContext ペイロードが不正です",
  "toast.orchestratorUnconfigured.title": "オーケストレーターが未設定です",
  "toast.handoffFailed.title": "引き継ぎに失敗しました",
  "toast.handoffFailed.desc":
    "{reason}。設定画面でオーケストレーターのURLを確認して再試行してください。",
  "toast.handoffIncomplete.title": "引き継ぎが完了しませんでした",
  "toast.handoffIncomplete.desc":
    "オーケストレーターは引き継ぎを受理しましたが、追跡用のジョブを返しませんでした。",

  // AIAgentStatusCard
  "ai.title": "AIエージェントの状態",
  "ai.status.idle": "待機中です。",
  "ai.status.queued":
    "キュー登録済み — AIエージェントがタスクに着手するのを待っています…",
  "ai.status.prefilled":
    "AIエージェントが通話コンテキストを取得し、保険金請求を入力しています。",
  "ai.status.ready":
    "AIエージェントが請求システムを操作しています。状況をモニタリング中です。",
  "ai.status.submitted":
    "保険金請求を作成しました。発信者に確認し、通話を区分けしてください。",
  "ai.status.error": "問題が発生しました。下記の詳細をご確認ください。",
  "ai.liveAgentDesktop": "ライブエージェントデスクトップ",
  "ai.agentDesktopDone": "エージェントデスクトップ · 完了",
  "ai.expand": "拡大",
  "ai.expandAria": "ライブエージェントデスクトップを拡大",
  "ai.expandTitle": "拡大（シアター表示）",
  "ai.collapse": "閉じる",
  "ai.collapseAria": "シアター表示を閉じる",
  "ai.collapseTitle": "閉じる（ワークスペースに戻る）",
  "ai.acquiring":
    "AIエージェント用のセキュアな Windows 365 クラウドPCを確保しています…",
  "ai.theaterTitleLive":
    "ライブAIエージェントデスクトップ · Windows 365 クラウドPC",
  "ai.theaterTitleDone": "AIエージェントデスクトップ · 請求登録完了",
  "ai.theaterSrTitle": "ライブAIエージェントデスクトップ",
  "ai.theaterSrDesc":
    "AIエージェントが Windows 365 クラウドPCを操作している様子の拡大ライブビューです。",
  "ai.liveScreenshotAlt": "ライブAIエージェントデスクトップ",
  "ai.liveScreenshotLargeAlt": "ライブAIエージェントデスクトップ（拡大表示）",
  "ai.claimFiled": "登録された請求：",
  "ai.claimSubmitted": "請求を登録しました",
  "ai.policy": "証券",
  "ai.submittedBy": "登録者",
  "ai.reserve": "支払備金",
  "ai.copyClaimId": "請求IDをコピー",
  "ai.request": "リクエスト",
  "ai.retry": "再試行",
  "ai.fallbackManual": "手動対応に切り替え",
  "ai.frames": "{n} フレーム",
  "toast.claimReady.title": "請求の準備が整いました",
  "toast.claimReady.desc":
    "請求 {id} を発信者にお伝えする準備ができました。クリップボードにコピーしました。",

  // HandoffModal
  "handoff.title": "AIエージェントへ転送",
  "handoff.summaryLabel": "AIエージェント向けの要約",
  "handoff.charCount": "{n}/1000 文字",
  "handoff.handoverContext": "引き継ぎコンテキスト",
  "handoff.caller": "発信者",
  "handoff.intent": "用件",
  "handoff.phone": "電話番号",
  "handoff.policy": "証券番号",
  "handoff.requestId": "リクエストID",
  "handoff.requestedBy": "依頼者",
  "handoff.notProvided": "未提供",
  "handoff.viewPayload": "ペイロードを表示（JSON通信契約）",
  "handoff.copyJson": "JSONをコピー",
  "handoff.cancel": "キャンセル",
  "handoff.confirm": "AIエージェントへ転送",

  // TransferDirectory
  "dir.title": "対応を転送",
  "dir.desc":
    "このライブ対応を別の宛先にルーティングします。添付された対応コンテキストは転送とともに自動的に引き継がれます。これは実際のコンタクトセンターが用いるルーティングモデル（Amazon Connect のキュー転送、Twilio TaskRouter、D365 のワークストリームルーティング）と同じ仕組みです。",
  "dir.aiAgents": "AIエージェント",
  "dir.aiAgentName": "請求自動化エージェント",
  "dir.aiAgentAria": "AIエージェントへ転送",
  "dir.aiAgentSubtitle":
    "Microsoft Copilot Studio エージェント + Computer Use · コンテキスト自動添付（Direct Line チャネルアダプター）",
  "dir.queuesTeams": "キュー＆チーム",
  "dir.queue.claimsT2": "保険金請求 — ティア2",
  "dir.queue.claimsT2.detail": "シニアCSRキュー · 約3件待機",
  "dir.queue.property": "住宅保険金請求",
  "dir.queue.property.detail": "専門キュー · 約1件待機",
  "dir.queue.supervisor": "スーパーバイザー / エスカレーション",
  "dir.queue.supervisor.detail": "マネージャーキュー",

  // Domain enum display values
  "queue.auto_claims": "自動車保険金請求",
  "queue.property_claims": "住宅保険金請求",
  "queue.supervisor": "スーパーバイザー",
  "role.csr": "サポート担当",
  "role.senior_csr": "シニアサポート担当",
  "role.claims_manager": "請求マネージャー",
  "aux.available": "対応可能",
  "aux.acw": "通話後処理",
  "aux.break": "休憩",
  "aux.lunch": "昼食",
  "aux.training": "研修",
  "aux.outbound": "発信業務",
  "aux.tech_issue": "技術的問題",
  "aux.in_call": "通話中",
  "disposition.resolved": "解決",
  "disposition.escalated_ai": "AIエージェントへエスカレーション",
  "disposition.callback": "折り返し予約",
  "disposition.wrong_number": "間違い電話",
  "disposition.abandoned": "放棄呼",
  "intent.auto_collision": "自動車事故",
  "intent.home_water": "住宅の水漏れ",
  "intent.fraud_investigation": "不正調査",
  "sentiment.Positive": "好意的",
  "sentiment.Neutral": "中立",
  "sentiment.Anxious": "不安",
  "sentiment.Frustrated": "不満",
  "channel.Phone": "電話",
  "channel.Email": "メール",
  "channel.SMS": "SMS",
  "channel.Web chat": "ウェブチャット",
  "ptype.Auto": "自動車",
  "ptype.Home": "住宅",
  "ptype.Umbrella": "アンブレラ",
  "pstatus.Active": "有効",
  "pstatus.Lapsed": "失効",
  "pstatus.Cancelled": "解約",
  "pstatus.Open": "受付中",
  "pstatus.Closed": "完了",
  "pstatus.In review": "審査中"
};

export const messages: Record<Lang, Dict> = { en, ja };

/**
 * Translate a key for the given language with optional `{var}` interpolation.
 * Falls back to English, then to the raw key, so the UI never renders blank.
 */
export function translate(
  lang: Lang,
  key: string,
  vars?: Record<string, string | number>
): string {
  const template = messages[lang]?.[key] ?? messages.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  );
}
