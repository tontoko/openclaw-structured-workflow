/**
 * Structured Workflow Plugin for OpenClaw v0.7.0
 *
 * TaskFlow前提の behavior layer。進行制御を担う。
 * v0.7.0: 強制継続（命令注入）, 停止許可状態機械, 複雑指示検知ヒューリスティック
 *
 * Runtime契約:
 * - ツールは tool factory context (ctx.sessionKey) があれば登録、なければスキップ
 * - Hook (before_prompt_build) は hookCtx.sessionKey + bindSession で TaskFlow 取得
 * - TaskFlow取得: fromToolContext (tool factory) / bindSession (hooks)
 * - 参考実装: lobster (factory pattern + ctx.sessionKey guard), webhooks (bindSession), inbox-triage
 *
 * Behavior層の責務:
 * - いつ tasklist を作るか（複雑指示検知）
 * - いつ「まだ止まるな」を発火するか（強制継続）
 * - 停止許可条件をどう判定するか（状態機械）
 * - 進行状態の注入（現在タスク・次タスク・完了条件）
 */

import { Type } from "@sinclair/typebox";
// @ts-expect-error openclaw plugin SDK is provided by the host at build/runtime.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// --- Types ---

type TaskStatus = "pending" | "running" | "completed" | "skipped" | "blocked";
type DecisionPolicy = "auto" | "deliberate" | "confirm" | "notify";
type PermissionMode = "bypass" | "allow-after-first" | "confirm-each";

interface TaskReference {
  type: "path" | "url";
  value: string;
  note?: string;
}

interface TaskItem {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  decisionPolicy: DecisionPolicy;
  deliberateWith?: string[];
  references?: TaskReference[];
  assignedAgent?: string | null;
  sessionKey?: string | null;
  completedAt?: string | null;
  evidence?: string | null;
  blockedReason?: string | null;
  subTasks?: TaskItem[];
}

interface WorkflowState {
  type: "workflow";
  title: string;
  tasks: TaskItem[];
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
}

interface PluginConfig {
  permissionMode?: PermissionMode;
  forceContinuation?: boolean;
  cancelKeywords?: string[];
}

interface BoundTaskFlow {
  readonly sessionKey: string;
  readonly flowId?: string;
  readonly revision?: number;
  readonly stateJson?: unknown;
  createManaged: (input: Record<string, unknown>) => { flowId: string; revision: number };
  get: (flowId: string) => unknown | undefined;
  list: () => unknown[];
  findLatest: () => unknown | undefined;
  setWaiting: (input: Record<string, unknown>) => { applied: boolean; flow: any; code?: string };
  resume: (input: Record<string, unknown>) => { applied: boolean; flow: any; code?: string };
  finish: (input: Record<string, unknown>) => { applied: boolean; flow: any; code?: string };
  fail: (input: Record<string, unknown>) => { applied: boolean; flow: any; code?: string };
  requestCancel: (input: Record<string, unknown>) => { applied: boolean; flow: any; code?: string };
  runTask: (input: Record<string, unknown>) => { created: boolean; reason?: string; flow?: any; task?: any };
  updateManaged?: (input: Record<string, unknown>) => { applied: boolean; flow: any; code?: string };
}

interface TaskFlowApi {
  fromToolContext: (ctx: { sessionKey: string; deliveryContext?: unknown }) => BoundTaskFlow;
  bindSession: (params: { sessionKey: string; requesterOrigin?: unknown }) => BoundTaskFlow;
}

type ToolContext = {
  sessionKey?: string;
  deliveryContext?: unknown;
  sandboxed?: boolean;
  [key: string]: unknown;
};

type PromptBuildEvent = {
  prompt?: string;
  messages?: Array<{ role: string; content?: string }>;
};

type HookAgentContext = {
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  [key: string]: unknown;
};

// --- Constants ---

const PLUGIN_ID = "structured-workflow";
const DEFAULT_CANCEL_KEYWORDS = ["/stop", "やめて", "ストップ", "キャンセル", "cancel", "stop", "/abort", "/force-finish"];

// 複雑指示検知キーワード
const COMPLEXITY_KEYWORDS = [
  "実装", "実装して", "修正", "修正して", "調査", "調べて", "設計", "デザイン",
  "テスト", "検証", "確認", "レビュー", "リファクタ", "リファクタリング",
  "implement", "fix", "investigate", "design", "refactor", "review",
  "build", "create", "develop", "deploy",
  "やって", "してください", "お願い", "全て", "すべて",
  "してから", "した後に", "終わったら", "終わらせて",
];

// Task skeleton templates
const DEFAULT_TASK_SKELETON = [
  { id: "investigate", title: "要件調査", decisionPolicy: "auto" as DecisionPolicy },
  { id: "design", title: "設計", decisionPolicy: "deliberate" as DecisionPolicy },
  { id: "test-first", title: "テスト観点整理", decisionPolicy: "auto" as DecisionPolicy },
  { id: "implement", title: "実装", decisionPolicy: "auto" as DecisionPolicy },
  { id: "test", title: "テスト", decisionPolicy: "auto" as DecisionPolicy },
  { id: "verify", title: "動作確認", decisionPolicy: "auto" as DecisionPolicy },
];

// --- Plugin ---

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Structured Workflow",
  description:
    "TaskFlow-based task orchestration with forced continuation, stop gate, complexity detection, and phase injection.",

  register(api: any) {
    const logger = api.logger ?? { info: () => {}, warn: () => {}, error: () => {} };

    const flowApi = resolveFlowApi(api);

    // --- Tool factory pattern (lobster-style) ---
    api.registerTool(((ctx: ToolContext) => {
      if (!ctx?.sessionKey) {
        logger.warn?.(`[${PLUGIN_ID}] Tool factory: no sessionKey. Tools not registered.`);
        return null;
      }

      const taskFlow = flowApi
        ? flowApi.fromToolContext({ sessionKey: ctx.sessionKey, deliveryContext: ctx.deliveryContext })
        : undefined;

      if (!taskFlow) {
        logger.warn?.(`[${PLUGIN_ID}] TaskFlow unavailable for session ${ctx.sessionKey}.`);
        return null;
      }

      // --- tasklist_create ---
      const tasklistCreate = {
        name: "tasklist_create",
        description: "Create a structured task list for a complex instruction.",
        parameters: Type.Object({
          title: Type.String(),
          tasks: Type.Array(
            Type.Object({
              id: Type.String(),
              title: Type.String(),
              description: Type.Optional(Type.String()),
              decisionPolicy: Type.Optional(
                Type.Union([
                  Type.Literal("auto"),
                  Type.Literal("deliberate"),
                  Type.Literal("confirm"),
                  Type.Literal("notify"),
                ]),
              ),
              deliberateWith: Type.Optional(Type.Array(Type.String())),
              references: Type.Optional(
                Type.Array(
                  Type.Object({
                    type: Type.Union([Type.Literal("path"), Type.Literal("url")]),
                    value: Type.String(),
                    note: Type.Optional(Type.String()),
                  }),
                ),
              ),
            }),
          ),
        }),
        async execute(_id: string, params: any, _ctx: ToolContext) {
          const now = new Date().toISOString();
          const tasks: TaskItem[] = params.tasks.map((t: any) => ({
            id: String(t.id),
            title: String(t.title),
            description: t.description,
            status: "pending" as TaskStatus,
            decisionPolicy: (t.decisionPolicy ?? "auto") as DecisionPolicy,
            deliberateWith: t.deliberateWith ?? [],
            references: t.references ?? [],
            assignedAgent: null,
            sessionKey: null,
            completedAt: null,
            evidence: null,
            blockedReason: null,
          }));

          const state: WorkflowState = {
            type: "workflow",
            title: params.title,
            tasks,
            permissionMode: readConfig(api).permissionMode ?? "bypass",
            createdAt: now,
            updatedAt: now,
          };

          const created = taskFlow.createManaged({
            controllerId: `${PLUGIN_ID}/tasklist`,
            goal: params.title,
            currentStep: "create task list",
            stateJson: state,
          });

          return textResult(
            [
              `📋 Task list created`,
              `Flow: ${created.flowId} (rev ${created.revision})`,
              "",
              formatTaskList(state, created.flowId, created.revision),
            ].join("\n"),
          );
        },
      };

      // --- tasklist_update ---
      const tasklistUpdate = {
        name: "tasklist_update",
        description: "Update a task's status in the workflow.",
        parameters: Type.Object({
          taskId: Type.String(),
          status: Type.Union([
            Type.Literal("running"),
            Type.Literal("completed"),
            Type.Literal("skipped"),
            Type.Literal("blocked"),
          ]),
          expectedRevision: Type.Optional(Type.Number()),
          evidence: Type.Optional(Type.String()),
          assignedAgent: Type.Optional(Type.String()),
          sessionKey: Type.Optional(Type.String()),
          blockedReason: Type.Optional(Type.String()),
        }),
        async execute(_id: string, params: any, _ctx: ToolContext) {
          const latest = taskFlow.findLatest();
          const current = readWorkflowState((latest as any)?.stateJson);
          if (!current) return toolError("No active workflow found in this session.");

          if (
            params.expectedRevision !== undefined &&
            (latest as any)?.revision !== undefined &&
            params.expectedRevision !== (latest as any).revision
          ) {
            return toolError(
              `Revision conflict: expected ${params.expectedRevision}, current ${(latest as any).revision}.`,
            );
          }

          const next = cloneState(current);
          const target = findTask(next.tasks, params.taskId);
          if (!target) return toolError(`Task not found: ${params.taskId}`);

          const warnings: string[] = [];
          if (params.status === "completed" && !params.evidence && !target.evidence) {
            warnings.push("⚠️ No evidence provided for completed task.");
          }
          if (params.status === "blocked" && !params.blockedReason) {
            warnings.push("⚠️ Task blocked without reason.");
          }

          target.status = params.status;
          if (params.assignedAgent !== undefined) target.assignedAgent = params.assignedAgent;
          if (params.sessionKey !== undefined) target.sessionKey = params.sessionKey;
          if (params.evidence !== undefined) target.evidence = params.evidence;
          if (params.blockedReason !== undefined) target.blockedReason = params.blockedReason;
          if (["completed", "skipped", "blocked"].includes(params.status)) {
            target.completedAt = new Date().toISOString();
          }
          next.updatedAt = new Date().toISOString();

          const flowId = (latest as any)?.flowId;
          const revision = (latest as any)?.revision ?? 0;

          const allDone = next.tasks.every(
            (t) => t.status === "completed" || t.status === "skipped",
          );

          if (allDone) {
            const finished = taskFlow.finish({
              flowId,
              expectedRevision: revision,
              stateJson: next,
            });
            if (!finished.applied) {
              return toolError(`Failed to finish workflow: ${finished.code ?? "unknown"}`);
            }
            return textResult(
              [
                `🏁 Workflow complete: ${next.title}`,
                `All ${next.tasks.length} tasks done.`,
                "",
                formatTaskList(next, flowId, (finished.flow as any)?.revision),
              ].join("\n"),
            );
          }

          const updated = taskFlow.resume({
            flowId,
            expectedRevision: revision,
            status: "running",
            currentStep: params.taskId,
            stateJson: next,
          });

          if (!updated.applied) {
            return toolError(`Failed to update workflow: ${updated.code ?? "unknown"}`);
          }

          const nextRevision = (updated.flow as any)?.revision ?? revision + 1;

          if (params.status === "running" && params.sessionKey) {
            taskFlow.runTask({
              flowId,
              runtime: "acp",
              childSessionKey: params.sessionKey,
              task: `Execute task: ${params.taskId} - ${target.title}`,
              status: "running",
              startedAt: Date.now(),
              lastEventAt: Date.now(),
            });
          }

          return textResult(
            [
              `✅ Task ${params.taskId} → ${params.status}`,
              params.evidence ? `Evidence: ${params.evidence}` : null,
              params.blockedReason ? `Blocked: ${params.blockedReason}` : null,
              `Revision: ${nextRevision}`,
              ...warnings,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        },
      };

      // --- tasklist_status ---
      const tasklistStatus = {
        name: "tasklist_status",
        description: "Show current task list status for a workflow.",
        parameters: Type.Object({}),
        async execute(_id: string, _params: any, _ctx: ToolContext) {
          const latest = taskFlow.findLatest();
          if (!latest) return textResult("No active workflow in this session.");

          const state = readWorkflowState((latest as any)?.stateJson);
          if (!state) return toolError("Active workflow has invalid state.");

          return textResult(formatTaskList(state, (latest as any).flowId, (latest as any).revision));
        },
      };

      // --- tasklist_permission ---
      const tasklistPermission = {
        name: "tasklist_permission",
        description: "Switch permission mode.",
        parameters: Type.Object({
          mode: Type.Union([
            Type.Literal("bypass"),
            Type.Literal("allow-after-first"),
            Type.Literal("confirm-each"),
          ]),
          reason: Type.Optional(Type.String()),
        }),
        async execute(_id: string, params: any, _ctx: ToolContext) {
          if (typeof api.updateConfig === "function") {
            await maybeAwait(api.updateConfig({ permissionMode: params.mode }));
          }
          return textResult(
            `🔐 Permission mode → ${params.mode}${params.reason ? ` (${params.reason})` : ""}`,
          );
        },
      };

      return [tasklistCreate, tasklistUpdate, tasklistStatus, tasklistPermission];
    }), { optional: true });

    // --- Hook: before_prompt_build ---
    // Behavior layer: forced continuation, stop gate, complexity detection, phase injection
    api.on(
      "before_prompt_build",
      async (event: PromptBuildEvent, hookCtx: HookAgentContext) => {
        const config = readConfig(api);
        const sessionKey = hookCtx?.sessionKey;
        if (!sessionKey) return {};

        const incomingText = event.prompt ?? "";
        const messages = event.messages ?? [];
        const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
        const lastAssistantMsg = [...messages].reverse().find((m: any) => m.role === "assistant");
        const fullText = [incomingText, lastUserMsg?.content].filter(Boolean).join("\n");

        // --- Stop gate: cancel keywords allow immediate stop ---
        if (containsKeyword(fullText, config.cancelKeywords ?? DEFAULT_CANCEL_KEYWORDS)) {
          return {};
        }

        // --- Stop gate: STOP_REQUEST in prior assistant message ---
        if (/STOP_REQUEST/.test(lastAssistantMsg?.content ?? "")) return {};

        if (!flowApi) return {};

        const boundFlow = flowApi.bindSession({ sessionKey });
        const latest = boundFlow.findLatest();
        const hasActiveFlow = !!latest;
        const state = hasActiveFlow ? readWorkflowState((latest as any)?.stateJson) : undefined;

        // --- Complexity detection: suggest tasklist_create for complex instructions ---
        // Only when no active workflow exists
        if (!hasActiveFlow && isComplexInstruction(fullText)) {
          const skeleton = DEFAULT_TASK_SKELETON.map((t) => `- ${t.id}: ${t.title}`).join("\n");
          return {
            prependSystemContext: [
              "🔴 STRUCTURED WORKFLOW — Complex instruction detected.",
              "",
              "You MUST use tasklist_create to decompose this task before proceeding.",
              "Use this task skeleton as a starting point, adjusting to the specific request:",
              skeleton,
              "",
              "Rules:",
              "- Use tasklist_create BEFORE starting any work.",
              "- Set decisionPolicy: 'deliberate' for design/architecture decisions.",
              "- Provide evidence for every completed task.",
              "- Do NOT declare the workflow done until all tasks are completed or blocked.",
            ].join("\n"),
          };
        }

        // --- If no active workflow and not complex, do nothing ---
        if (!state) return {};

        const incomplete = state.tasks.filter(
          (t) => t.status === "pending" || t.status === "running",
        );
        const blocked = state.tasks.filter((t) => t.status === "blocked");

        // --- Stop gate: all tasks terminal = stop allowed ---
        if (incomplete.length === 0 && blocked.length === 0) {
          // All terminal — no injection needed
          return {};
        }

        // --- Forced continuation: incomplete tasks remain ---
        const idleWarning = detectIdle(incomplete, lastAssistantMsg?.content ?? "");

        return {
          prependSystemContext: buildForcedContinuationContext(state, incomplete, blocked, idleWarning),
        };
      },
    );
  },
});

// --- TaskFlow Resolution ---

function resolveFlowApi(api: any): TaskFlowApi | undefined {
  return api?.runtime?.taskFlow ?? api?.runtime?.tasks?.flow;
}

// --- Complexity Detection ---

function isComplexInstruction(text: string): boolean {
  if (!text || text.length < 30) return false;

  let score = 0;

  // Multi-sentence requests
  const sentences = text.split(/[。.!?！？\n]/).filter((s) => s.trim().length > 5);
  if (sentences.length >= 3) score += 2;

  // Keyword matching
  const keywordHits = COMPLEXITY_KEYWORDS.filter((kw) => text.toLowerCase().includes(kw.toLowerCase()));
  score += Math.min(keywordHits.length, 3);

  // Multi-step indicators
  if (/してから|した後に|終わったら|終わらせて|then|after|before|まで/i.test(text)) score += 2;
  if (/全て|すべて|全部|all|every|entire/i.test(text)) score += 1;

  // Task-like structure
  if (/番目|第[0-9]|ステップ|step|phase|段階/i.test(text)) score += 2;

  return score >= 3;
}

// --- Stop Gate State Machine ---

/**
 * Stop allowed conditions:
 * 1. All tasks completed/skipped (no incomplete, no blocked)
 * 2. Cancel keyword detected (handled before this function)
 * 3. All tasks either completed/skipped OR blocked with explicit handoff
 *
 * Stop DENIED when:
 * - Any task is pending or running
 * - Unless blocked + explicit user-facing handoff
 */
function isStopAllowed(state: WorkflowState): boolean {
  const incomplete = state.tasks.filter(
    (t) => t.status === "pending" || t.status === "running",
  );
  if (incomplete.length === 0) return true;

  // All remaining are blocked = stop allowed (user handoff)
  const allBlocked = state.tasks.every(
    (t) => t.status === "completed" || t.status === "skipped" || t.status === "blocked",
  );
  return allBlocked;
}

// --- Idle Detection ---

const TASK_CONTEXT_PATTERN = /\b(task|current|next|evidence|complete|blocked)\b/i;

function detectIdle(incomplete: TaskItem[], lastAssistantContent: string): string | null {
  const running = incomplete.find((t) => t.status === "running");
  if (!running) return null;

  if (!TASK_CONTEXT_PATTERN.test(lastAssistantContent)) {
    return `⚠️ IDLE: No task progress mentioned in recent response. Resume: ${running.id}. ${running.title}`;
  }
  return null;
}

// --- Forced Continuation Context Builder ---

function buildForcedContinuationContext(
  state: WorkflowState,
  incomplete: TaskItem[],
  blocked: TaskItem[],
  idleWarning: string | null,
): string {
  const nextTask = incomplete.find((t) => t.status === "running") ?? incomplete[0];
  const afterNext = incomplete.filter((t) => t !== nextTask).slice(0, 3);
  const completed = state.tasks.filter((t) => t.status === "completed").length;
  const total = state.tasks.length;
  const stopAllowed = isStopAllowed(state);

  const lines: string[] = [
    `🔴 WORKFLOW ACTIVE — ${state.title}`,
    `Progress: ${completed}/${total} complete | ${incomplete.length} remaining`,
    "",
  ];

  if (nextTask) {
    lines.push(`▸ Current: ${nextTask.id}. ${nextTask.title} (${nextTask.status})`);
    if (nextTask.description) lines.push(`  ${nextTask.description}`);
    if (nextTask.references?.length) {
      for (const ref of nextTask.references) {
        const note = ref.note ? ` — ${ref.note.slice(0, 120)}` : "";
        lines.push(`  📎 ${ref.type}: ${ref.value}${note}`);
      }
    }
    lines.push("");
  }

  if (afterNext.length > 0) {
    lines.push("Remaining:");
    for (const t of afterNext) {
      lines.push(`  ${STATUS_ICONS[t.status]} ${t.id}. ${t.title}`);
    }
    lines.push("");
  }

  if (blocked.length > 0) {
    lines.push("🚫 Blocked:");
    for (const b of blocked) {
      lines.push(`  - ${b.id}. ${b.title}${b.blockedReason ? `: ${b.blockedReason}` : ""}`);
    }
    lines.push("");
  }

  if (idleWarning) {
    lines.push(idleWarning, "");
  }

  // --- Forced continuation directives (MUST, not suggestion) ---
  lines.push("MANDATORY RULES:");
  lines.push("- You MUST complete all tasks before declaring this workflow done.");
  lines.push("- You MUST use tasklist_update to set evidence when completing a task.");
  lines.push("- You MUST continue with the next pending/running task after completing one.");
  lines.push("- If blocked, you MUST explain why and what is needed to unblock.");

  if (!stopAllowed) {
    lines.push("");
    lines.push("⚠️ STOP GATE: You have incomplete tasks. Do NOT stop or declare completion.");
    lines.push("To stop early, use one of: /stop, /abort, or /force-finish");
  }

  return lines.join("\n");
}

// --- Utilities ---

function readConfig(api: Record<string, unknown>): PluginConfig {
  const cfg =
    typeof api.getConfig === "function" ? (api.getConfig() as PluginConfig | undefined) : undefined;
  return {
    permissionMode: cfg?.permissionMode ?? "bypass",
    forceContinuation: cfg?.forceContinuation ?? true,
    cancelKeywords: cfg?.cancelKeywords ?? DEFAULT_CANCEL_KEYWORDS,
  };
}

function readWorkflowState(value: unknown): WorkflowState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const s = value as Partial<WorkflowState>;
  if (s.type !== "workflow" || !Array.isArray(s.tasks)) return undefined;
  return {
    type: "workflow",
    title: String(s.title ?? "Workflow"),
    tasks: s.tasks.map(normalizeTask),
    permissionMode: (s.permissionMode ?? "bypass") as PermissionMode,
    createdAt: String(s.createdAt ?? new Date().toISOString()),
    updatedAt: String(s.updatedAt ?? new Date().toISOString()),
  };
}

function normalizeTask(t: Partial<TaskItem>): TaskItem {
  return {
    id: String(t.id ?? ""),
    title: String(t.title ?? ""),
    description: t.description,
    status: (t.status ?? "pending") as TaskStatus,
    decisionPolicy: (t.decisionPolicy ?? "auto") as DecisionPolicy,
    deliberateWith: t.deliberateWith ?? [],
    references: t.references ?? [],
    assignedAgent: t.assignedAgent ?? null,
    sessionKey: t.sessionKey ?? null,
    completedAt: t.completedAt ?? null,
    evidence: t.evidence ?? null,
    blockedReason: t.blockedReason ?? null,
  };
}

function findTask(tasks: TaskItem[], taskId: string): TaskItem | undefined {
  for (const task of tasks) {
    if (task.id === taskId) return task;
    const nested = task.subTasks ? findTask(task.subTasks, taskId) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

function cloneState(state: WorkflowState): WorkflowState {
  return {
    ...state,
    tasks: state.tasks.map((t) => ({
      ...t,
      subTasks: t.subTasks?.map((s) => ({ ...s })),
    })),
  };
}

function formatTaskList(state: WorkflowState, flowId?: string, revision?: number): string {
  const completed = state.tasks.filter((t) => t.status === "completed").length;
  const total = state.tasks.length;
  const blocked = state.tasks.filter((t) => t.status === "blocked").length;
  const lines = [
    `📋 TASK LIST: ${state.title}`,
    flowId ? `Flow: ${flowId}${revision !== undefined ? ` (rev ${revision})` : ""}` : null,
    `Progress: ${completed}/${total} complete${blocked > 0 ? ` | ${blocked} blocked` : ""}`,
    "",
  ].filter(Boolean) as string[];

  for (const task of state.tasks) {
    const policy = task.decisionPolicy !== "auto" ? ` [${task.decisionPolicy}]` : "";
    lines.push(`${STATUS_ICONS[task.status]} ${task.id}. ${task.title}${policy}`);
    if (task.evidence) lines.push(`  evidence: ${task.evidence}`);
    if (task.blockedReason) lines.push(`  blocked: ${task.blockedReason}`);
  }

  return lines.join("\n");
}

function containsKeyword(text: string, keywords: string[]): boolean {
  const normalized = text.toLowerCase();
  return keywords.some((k) => normalized.includes(k.toLowerCase()));
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: `❌ ${message}` }] };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function maybeAwait<T>(value: T | Promise<T> | undefined): Promise<T | undefined> {
  return await value;
}

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: "☐",
  running: "🔄",
  completed: "✅",
  skipped: "⏭️",
  blocked: "❌",
};