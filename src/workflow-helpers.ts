export interface TriggerConfig {
  flowDetectionMode?: "auto" | "keyword-only";
  activationKeywords?: string[];
}

const COMPLEXITY_KEYWORDS = [
  "実装",
  "実装して",
  "修正",
  "修正して",
  "調査",
  "調べて",
  "設計",
  "デザイン",
  "テスト",
  "検証",
  "確認",
  "レビュー",
  "リファクタ",
  "リファクタリング",
  "implement",
  "fix",
  "investigate",
  "design",
  "refactor",
  "review",
  "build",
  "create",
  "develop",
  "deploy",
  "やって",
  "してください",
  "お願い",
  "全て",
  "すべて",
  "してから",
  "した後に",
  "終わったら",
  "終わらせて",
];

const VOLATILE_PROMPT_MARKERS = [
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "[Queued messages while agent was busy]",
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "A scheduled reminder has been triggered",
  "Tasklist reminder",
  "An async command you ran earlier has completed",
  "Read HEARTBEAT.md if it exists",
  "Exec failed",
];

export const DEFAULT_ACTIVATION_KEYWORDS = ["ultrawork", "ulw"];
export const DEFAULT_VISIBLE_ACK = "ULW enabled.";

type TextLikeContent = {
  type: string;
  text?: string;
};

export type VisibleAckSessionContext = {
  sessionKey?: string;
};

export type VisibleAckMessageSendingEvent = {
  to?: string;
  content?: unknown;
  metadata?: Record<string, unknown>;
};

export type VisibleAckMessageSendingContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
};

function isComplexInstruction(text: string): boolean {
  if (!text || text.length < 30) return false;

  let score = 0;

  const sentences = text.split(/[。.!?！？\n]/).filter((s) => s.trim().length > 5);
  if (sentences.length >= 3) score += 2;

  const keywordHits = COMPLEXITY_KEYWORDS.filter((kw) =>
    text.toLowerCase().includes(kw.toLowerCase()),
  );
  score += Math.min(keywordHits.length, 3);

  if (/してから|した後に|終わったら|終わらせて|then|after|before|まで/i.test(text)) score += 2;
  if (/全て|すべて|全部|all|every|entire/i.test(text)) score += 1;
  if (/番目|第[0-9]|ステップ|step|phase|段階/i.test(text)) score += 2;

  return score >= 3;
}

export function shouldSuggestWorkflow(text: string, config: TriggerConfig): boolean {
  const normalized = text.trim();
  if (!normalized) return false;

  const matchedActivationKeyword = (config.activationKeywords ?? DEFAULT_ACTIVATION_KEYWORDS).some(
    (keyword) => normalized.toLowerCase().includes(keyword.toLowerCase()),
  );

  if (config.flowDetectionMode === "keyword-only") {
    return matchedActivationKeyword;
  }

  return matchedActivationKeyword || isComplexInstruction(normalized);
}

export function matchActivationKeyword(text: string, config: TriggerConfig): string | undefined {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return undefined;

  return (config.activationKeywords ?? DEFAULT_ACTIVATION_KEYWORDS).find((keyword) =>
    normalized.includes(keyword.toLowerCase()),
  );
}

export function isVolatilePrompt(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (normalized.startsWith("System: [")) return true;
  return VOLATILE_PROMPT_MARKERS.some((marker) => normalized.includes(marker));
}

export function buildWorkflowBootstrapPrompt(skeleton: string, activationKeyword?: string): string {
  return [
    "🔴 WORKFLOW BOOTSTRAP",
    activationKeyword ? `Trigger: explicit keyword \`${activationKeyword}\`` : null,
    "",
    `On your next visible reply, start with exactly "${DEFAULT_VISIBLE_ACK}" on its own line.`,
    "Keep the acknowledgement short and emit it once for this bootstrap only.",
    "",
    "Complex instruction detected. You MUST use tasklist_create to decompose this task before proceeding.",
    "Use this task skeleton as a starting point, adjusting to the specific request:",
    skeleton,
    "",
    "Rules:",
    "- Keep task ids stable once created.",
    "- Track current and next work explicitly.",
    "- Provide evidence for completed tasks.",
    "- If blocked, explain why and what's needed.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function prependVisibleAckToContent(
  content: unknown,
  ack: string = DEFAULT_VISIBLE_ACK,
): unknown {
  if (!Array.isArray(content) || content.length === 0) return content;
  const firstTextIndex = content.findIndex(
    (item) => item && typeof item === "object" && (item as TextLikeContent).type === "text",
  );
  if (firstTextIndex < 0) {
    return [{ type: "text", text: ack }, ...content];
  }

  const cloned = [...content];
  const firstText = cloned[firstTextIndex] as TextLikeContent;
  if (typeof firstText.text === "string") {
    const nextText = prependVisibleAckToText(firstText.text, ack);
    if (nextText === firstText.text) return content;
    cloned[firstTextIndex] = {
      ...firstText,
      text: nextText,
    };
    return cloned;
  }

  cloned[firstTextIndex] = {
    ...firstText,
    text: ack,
  };
  return cloned;
}

export function prependVisibleAckToText(text: string, ack: string = DEFAULT_VISIBLE_ACK): string {
  if (!text.trim()) return ack;
  if (text.startsWith(ack)) return text;
  if (normalizeVisibleText(text).startsWith(normalizeVisibleText(ack))) return text;
  return `${ack}\n${text}`;
}

export function resolveVisibleAckScopeFromSessionContext(
  ctx: VisibleAckSessionContext | undefined,
): string | undefined {
  const sessionKey = ctx?.sessionKey?.trim();
  if (!sessionKey) return undefined;
  return normalizeVisibleAckScope(sessionKey);
}

export function resolveVisibleAckScopeFromMessageSending(
  event: VisibleAckMessageSendingEvent | undefined,
  ctx: VisibleAckMessageSendingContext | undefined,
): string | undefined {
  const channelId = ctx?.channelId?.trim().toLowerCase();
  if (!channelId) return undefined;

  const metadata = event?.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const targetCandidate =
    readVisibleAckScopeCandidate(metadata.threadId) ??
    readVisibleAckScopeCandidate(metadata.threadTs) ??
    readVisibleAckScopeCandidate(metadata.conversationId) ??
    readVisibleAckScopeCandidate(metadata.channelId) ??
    readVisibleAckScopeCandidate(event?.to) ??
    readVisibleAckScopeCandidate(ctx?.conversationId);

  if (!targetCandidate) return `${channelId}:unknown`;
  return normalizeVisibleAckScope(`${channelId}:${targetCandidate}`);
}

function normalizeVisibleAckScope(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (!normalized) return "";

  normalized = normalized.replace(/^(agent|session|channel|chat|user):/, "");
  normalized = normalized.replace(/^(main):/, "");

  const threadIndex = normalized.lastIndexOf(":thread:");
  if (threadIndex >= 0) {
    const base = normalized.slice(0, threadIndex);
    const threadId = normalized.slice(threadIndex + 8).trim();
    const channel = base.split(":").filter(Boolean)[0] ?? "";
    if (channel && threadId) return `${channel}:${threadId}`;
    if (threadId) return threadId;
  }

  const parts = normalized.split(":").filter(Boolean);
  if (parts.length >= 3) return `${parts[0]}:${parts.slice(2).join(":")}`;
  if (parts.length === 2) return `${parts[0]}:${parts[1]}`;
  return normalized;
}

function readVisibleAckScopeCandidate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.replace(/^(channel|chat|user):/i, "");
}

export function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
