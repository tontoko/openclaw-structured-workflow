/**
 * Structured Workflow Plugin for OpenClaw v0.4.0
 *
 * TaskFlow前提の薄い behavior layer。
 * task 状態に応じて phase と completion guidance を動的注入。
 *
 * 責務: phase注入, current/next/completion, evidence要求, idle検知, reference統合
 * 責務外: standalone fallback, 独自永続化, audit log, IntentGate, 承認/権限, orchestration
 */

// @ts-expect-error typebox is provided by the host at build/runtime.
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

interface FlowLike {
  flowId?: string;
  revision?: number;
  stateJson?: unknown;
  createManaged?: (
    input: Record<string, unknown>,
  ) => { flowId?: string; revision?: number } | Promise<{ flowId?: string; revision?: number }>;
  updateManaged?: (input: {
    revision?: number;
    stateJson?: unknown;
  }) => { revision?: number } | Promise<{ revision?: number }>;
  runTask?: (input: Record<string, unknown>) => unknown;
}

type ToolContext = Record<string, unknown>;
type PromptBuildEvent = {
  prompt?: string;
  messages?: Array<{ role: string; content?: string }>;
} & Record<string, unknown>;

// --- Constants ---

const PLUGIN_ID = "structured-workflow";
const DEFAULT_CANCEL_KEYWORDS = ["/stop", "やめて", "ストップ", "キャンセル", "cancel", "stop"];

// --- Plugin ---

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Structured Workflow",
  description:
    "TaskFlow前提の薄い behavior layer。phase注入, completion guidance, idle検知, reference統合。",

  register(api: any) {
    // --- tasklist_create ---
    api.registerTool({
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
      async execute(_id: string, params: any, ctx: ToolContext) {
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

        const taskFlow = getTaskFlow(api, ctx);
        if (!taskFlow) {
          return toolError("TaskFlow runtime required. This plugin requires TaskFlow.");
        }

        const created = await maybeAwait(
          taskFlow.createManaged?.({
            controllerId: `${PLUGIN_ID}/tasklist`,
            goal: params.title,
            currentStep: "create task list",
            stateJson: state,
          }),
        );
        const flowId = created?.flowId ?? taskFlow.flowId ?? "unknown";
        const revision = created?.revision ?? taskFlow.revision;

        return textResult(
          [
            `📋 Task list created`,
            `Flow: ${flowId}${revision !== undefined ? ` (rev ${revision})` : ""}`,
            "",
            formatTaskList(state),
          ].join("\n"),
        );
      },
    });

    // --- tasklist_update ---
    api.registerTool({
      name: "tasklist_update",
      description: "Update a task's status in the workflow.",
      parameters: Type.Object({
        flowId: Type.Optional(Type.String()),
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
      async execute(_id: string, params: any, ctx: ToolContext) {
        const taskFlow = getTaskFlow(api, ctx);
        if (!taskFlow) {
          return toolError("TaskFlow runtime required.");
        }

        const current = readWorkflowState(taskFlow.stateJson);
        if (!current) return toolError("No active workflow state found.");

        if (
          params.expectedRevision !== undefined &&
          taskFlow.revision !== undefined &&
          params.expectedRevision !== taskFlow.revision
        ) {
          return toolError(
            `Revision conflict: expected ${params.expectedRevision}, current ${taskFlow.revision}.`,
          );
        }

        const next = cloneState(current);
        const target = findTask(next.tasks, params.taskId);
        if (!target) return toolError(`Task not found: ${params.taskId}`);

        // Warnings
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

        const updated = await maybeAwait(
          taskFlow.updateManaged?.({ revision: taskFlow.revision, stateJson: next }),
        );
        const nextRevision = updated?.revision ?? (taskFlow.revision ?? 0) + 1;

        if (params.status === "running" && params.sessionKey) {
          await maybeAwait(
            taskFlow.runTask?.({
              taskId: params.taskId,
              sessionKey: params.sessionKey,
              assignedAgent: params.assignedAgent,
              flowId: params.flowId ?? taskFlow.flowId,
            }),
          );
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
    });

    // --- tasklist_status ---
    api.registerTool({
      name: "tasklist_status",
      description: "Show current task list status for a workflow.",
      parameters: Type.Object({ flowId: Type.Optional(Type.String()) }),
      async execute(_id: string, _params: any, ctx: ToolContext) {
        const taskFlow = getTaskFlow(api, ctx);
        if (!taskFlow) return toolError("TaskFlow runtime required.");

        const state = readWorkflowState(taskFlow.stateJson);
        if (!state) return toolError("No active workflow state found.");

        return textResult(formatTaskList(state, taskFlow.flowId, taskFlow.revision));
      },
    });

    // --- tasklist_permission ---
    api.registerTool({
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
      async execute(_id: string, params: any) {
        if (typeof api.updateConfig === "function") {
          await maybeAwait(api.updateConfig({ permissionMode: params.mode }));
        }
        return textResult(
          `🔐 Permission mode → ${params.mode}${params.reason ? ` (${params.reason})` : ""}`,
        );
      },
    });

    // --- Hook: before_prompt_build ---
    api.on("before_prompt_build", async (event: PromptBuildEvent) => {
      const config = readConfig(api);
      if (config.forceContinuation === false) return {};

      const incomingText = event.prompt ?? "";
      const messages = event.messages ?? [];
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const lastAssistantMsg = [...messages].reverse().find((m) => m.role === "assistant");
      const fullText = [incomingText, lastUserMsg?.content].filter(Boolean).join("\n");

      if (containsKeyword(fullText, config.cancelKeywords ?? DEFAULT_CANCEL_KEYWORDS)) return {};
      if (/STOP_REQUEST/.test(lastAssistantMsg?.content ?? "")) return {};

      const taskFlow = findActiveWorkflow(api, event);
      if (!taskFlow) return {};

      const state = readWorkflowState(taskFlow.stateJson);
      if (!state) return {};

      const incomplete = state.tasks.filter(
        (t) => t.status === "pending" || t.status === "running",
      );
      const blocked = state.tasks.filter((t) => t.status === "blocked");

      if (incomplete.length === 0 && blocked.length === 0) return {};

      // Idle detection
      const idleWarning = detectIdle(incomplete, lastAssistantMsg?.content ?? "");

      return {
        prependSystemContext: buildInjectionContext(state, incomplete, blocked, idleWarning),
      };
    });
  },
});

// --- Idle Detection ---

const IDLE_TURN_THRESHOLD = 3;
const TASK_CONTEXT_PATTERN = /\b(task|current|next|evidence|complete|blocked)\b/i;

function detectIdle(incomplete: TaskItem[], lastAssistantContent: string): string | null {
  const running = incomplete.find((t) => t.status === "running");
  if (!running) return null;

  // Simple check: if last assistant response didn't mention task context keywords
  if (!TASK_CONTEXT_PATTERN.test(lastAssistantContent)) {
    return `⚠️ IDLE: No task progress mentioned in recent response. Resume: ${running.id}. ${running.title}`;
  }
  return null;
}

// --- Injection Context Builder ---

function buildInjectionContext(
  state: WorkflowState,
  incomplete: TaskItem[],
  blocked: TaskItem[],
  idleWarning: string | null,
): string {
  const nextTask = incomplete.find((t) => t.status === "running") ?? incomplete[0];
  const afterNext = incomplete.filter((t) => t !== nextTask).slice(0, 3);
  const completed = state.tasks.filter((t) => t.status === "completed").length;
  const total = state.tasks.length;

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

  lines.push("Rules:");
  lines.push("- Complete all tasks before declaring workflow done.");
  lines.push("- Provide evidence for completed tasks.");
  lines.push("- If blocked, explain why and what's needed.");

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

function getTaskFlow(api: Record<string, unknown>, ctx: ToolContext): FlowLike | undefined {
  try {
    return (api as any).runtime?.tasks?.flow?.fromToolContext?.(ctx) as FlowLike | undefined;
  } catch {
    return undefined;
  }
}

function findActiveWorkflow(
  api: Record<string, unknown>,
  event: PromptBuildEvent,
): FlowLike | undefined {
  try {
    return (
      ((api as any).runtime?.tasks?.flow?.fromPromptContext?.(event) as FlowLike | undefined) ??
      ((api as any).runtime?.tasks?.flow?.fromEvent?.(event) as FlowLike | undefined)
    );
  } catch {
    return undefined;
  }
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
