/**
 * Structured Workflow Plugin for OpenClaw v0.3.0
 *
 * Task-list driven workflow with structured decomposition, decision policies,
 * permission modes, forced continuation, IntentGate, evidence enforcement,
 * and override audit logging.
 */

// @ts-expect-error typebox is provided by the host at build/runtime.
import { Type } from "@sinclair/typebox";
// @ts-expect-error openclaw plugin SDK is provided by the host at build/runtime.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

type TaskStatus = "pending" | "running" | "completed" | "skipped" | "blocked";
type DecisionPolicy = "auto" | "deliberate" | "confirm" | "notify";
type PermissionMode = "bypass" | "allow-after-first" | "confirm-each";
type FlowDetectionMode = "auto" | "keyword-only";

interface TaskItem {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  decisionPolicy: DecisionPolicy;
  deliberateWith?: string[];
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
  allowedOperations: string[];
  createdAt: string;
  updatedAt: string;
  auditLog: AuditEntry[];
}

interface AuditEntry {
  timestamp: string;
  action: string;
  target: string;
  reason?: string;
  previousMode?: string;
}

interface PluginConfig {
  permissionMode?: PermissionMode;
  deliberateDefaultAgents?: string[];
  deliberateMaxRounds?: number;
  forceContinuation?: boolean;
  cancelKeywords?: string[];
  flowDetectionMode?: FlowDetectionMode;
  activationKeywords?: string[];
}

interface FlowLike {
  flowId?: string;
  revision?: number;
  stateJson?: unknown;
  controllerId?: string;
  createManaged?: (
    input: Record<string, unknown>,
  ) => { flowId?: string; revision?: number } | Promise<{ flowId?: string; revision?: number }>;
  updateManaged?: (input: {
    revision?: number;
    stateJson?: unknown;
  }) => { revision?: number } | Promise<{ revision?: number }>;
  runTask?: (input: Record<string, unknown>) => unknown;
  setWaiting?: (input?: Record<string, unknown>) => unknown;
  resume?: (input?: Record<string, unknown>) => unknown;
  finish?: (input?: Record<string, unknown>) => unknown;
}

type ToolContext = Record<string, unknown>;
type PromptBuildEvent = {
  prompt?: string;
  messages?: Array<{ role: string; content?: string }>;
} & Record<string, unknown>;

const PLUGIN_ID = "structured-workflow";

// In-memory fallback when TaskFlow runtime is not available
const standaloneStore = new Map<string, { state: WorkflowState; revision: number }>();
let standaloneCounter = 0;
let standalonePermissionMode: PermissionMode = "bypass";
const MAX_STANDALONE_WORKFLOWS = 50;

function pruneStandaloneStore() {
  if (standaloneStore.size <= MAX_STANDALONE_WORKFLOWS) return;
  const keys = [...standaloneStore.keys()];
  const toRemove = keys.slice(0, keys.length - MAX_STANDALONE_WORKFLOWS);
  for (const key of toRemove) standaloneStore.delete(key);
}

const DEFAULT_CANCEL_KEYWORDS = ["/stop", "やめて", "ストップ", "キャンセル", "cancel", "stop"];
const ACTIVATION_KEYWORDS = ["ultrawork", "ulw", "task-driven"];
const COMPLEXITY_HINTS = [
  /\n/,
  /\b(step|steps|phase|phases|first|next|then|after that|finally)\b/i,
  /[•*-]\s+/,
  /\d+[.)]\s+/,
];

// IntentGate: patterns that indicate dangerous or plan-deviating actions
const DESTRUCTIVE_PATTERNS = [
  /\b(drop|delete|truncate|remove|destroy|wipe|purge)\s+(table|database|schema|collection|branch)/i,
  /\b(force\s+push|reset\s+--hard|clean\s+-fdx)/i,
  /\brm\s+-rf\s+\//i,
  /\b(production|prod|main|master)\s*(deploy|release|push|merge)/i,
];

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Structured Workflow",
  description:
    "Task-list driven workflow with structured decomposition, decision policies, permission modes, forced continuation, and IntentGate.",

  register(api: any) {
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
          }),
        ),
      }),
      async execute(_id: string, params: any, ctx: ToolContext) {
        const config = readConfig(api);
        const now = new Date().toISOString();
        const tasks = normalizeTasks(params.tasks, config);
        const state: WorkflowState = {
          type: "workflow",
          title: params.title,
          tasks,
          permissionMode: config.permissionMode ?? "bypass",
          allowedOperations: [],
          createdAt: now,
          updatedAt: now,
          auditLog: [],
        };

        let flowId: string;
        let revision: number | undefined;

        const taskFlow = getTaskFlow(api, ctx);
        if (taskFlow) {
          const created = await maybeAwait(
            taskFlow.createManaged?.({
              controllerId: `${PLUGIN_ID}/tasklist`,
              goal: params.title,
              currentStep: "create task list",
              stateJson: state,
            }),
          );
          flowId = created?.flowId ?? taskFlow.flowId ?? "unknown";
          revision = created?.revision ?? taskFlow.revision;
        } else {
          standaloneCounter++;
          pruneStandaloneStore();
          flowId = `standalone-${standaloneCounter}`;
          revision = 1;
          standaloneStore.set(flowId, { state, revision });
        }

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

        let current: WorkflowState | undefined;
        let currentRevision: number | undefined;
        let activeFlowId: string | undefined;

        if (taskFlow) {
          current = readWorkflowState(taskFlow.stateJson);
          currentRevision = taskFlow.revision;
          activeFlowId = taskFlow.flowId;
        } else {
          const latestKey = [...standaloneStore.keys()].pop();
          if (latestKey) {
            const entry = standaloneStore.get(latestKey)!;
            current = entry.state;
            currentRevision = entry.revision;
            activeFlowId = latestKey;
          }
        }

        if (!current)
          return toolError("No active workflow found. Create one with tasklist_create first.");

        if (
          params.expectedRevision !== undefined &&
          currentRevision !== undefined &&
          params.expectedRevision !== currentRevision
        ) {
          return toolError(
            `Revision conflict: expected ${params.expectedRevision}, current ${currentRevision}.`,
          );
        }

        const next = cloneWorkflowState(current);
        const target = findTask(next.tasks, params.taskId);
        if (!target) return toolError(`Task not found: ${params.taskId}`);

        // IntentGate: warn if completing without evidence
        const warnings: string[] = [];
        if (params.status === "completed" && !params.evidence && !target.evidence) {
          warnings.push(
            "⚠️ No evidence provided for completed task. Best practice: include evidence of verification.",
          );
        }

        // IntentGate: warn if blocked without reason
        if (params.status === "blocked" && !params.blockedReason) {
          warnings.push(
            "⚠️ Task blocked without reason. Provide blockedReason to help unblock later.",
          );
        }

        target.status = params.status;
        if (params.assignedAgent !== undefined) target.assignedAgent = params.assignedAgent;
        if (params.sessionKey !== undefined) target.sessionKey = params.sessionKey;
        if (params.evidence !== undefined) target.evidence = params.evidence;
        if (params.blockedReason !== undefined) target.blockedReason = params.blockedReason;
        if (
          params.status === "completed" ||
          params.status === "skipped" ||
          params.status === "blocked"
        ) {
          target.completedAt = new Date().toISOString();
        }
        next.updatedAt = new Date().toISOString();

        // Audit log entry
        next.auditLog.push({
          timestamp: new Date().toISOString(),
          action: `task:${params.status}`,
          target: params.taskId,
          reason: params.evidence ?? params.blockedReason,
        });

        let nextRevision: number | undefined;

        if (taskFlow) {
          const updated = await maybeAwait(
            taskFlow.updateManaged?.({ revision: currentRevision, stateJson: next }),
          );
          nextRevision =
            updated?.revision ??
            (typeof currentRevision === "number" ? currentRevision + 1 : undefined);

          if (params.status === "running" && params.sessionKey) {
            await maybeAwait(
              taskFlow.runTask?.({
                taskId: params.taskId,
                sessionKey: params.sessionKey,
                assignedAgent: params.assignedAgent,
                flowId: params.flowId ?? activeFlowId,
              }),
            );
          }
        } else if (activeFlowId) {
          nextRevision = (currentRevision ?? 0) + 1;
          standaloneStore.set(activeFlowId, { state: next, revision: nextRevision });
        }

        return textResult(
          [
            `✅ Task ${params.taskId} → ${params.status}`,
            params.assignedAgent ? `Assigned agent: ${params.assignedAgent}` : null,
            params.sessionKey ? `Session: ${params.sessionKey}` : null,
            params.evidence ? `Evidence: ${params.evidence}` : null,
            params.blockedReason ? `Blocked reason: ${params.blockedReason}` : null,
            nextRevision !== undefined ? `Revision: ${nextRevision}` : null,
            ...warnings,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    });

    api.registerTool({
      name: "tasklist_status",
      description: "Show current task list status for a workflow.",
      parameters: Type.Object({
        flowId: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: any, ctx: ToolContext) {
        let state: WorkflowState | undefined;
        let revision: number | undefined;
        let flowId: string | undefined = params.flowId;

        const taskFlow = getTaskFlow(api, ctx);
        if (taskFlow) {
          state = readWorkflowState(taskFlow.stateJson);
          revision = taskFlow.revision;
          flowId = flowId ?? taskFlow.flowId;
        } else {
          const key = flowId ?? [...standaloneStore.keys()].pop();
          if (key) {
            const entry = standaloneStore.get(key);
            if (entry) {
              state = entry.state;
              revision = entry.revision;
              flowId = key;
            }
          }
        }

        if (!state)
          return toolError("No active workflow found. Create one with tasklist_create first.");
        return textResult(formatTaskList(state, flowId, revision));
      },
    });

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
        const previousMode =
          typeof api.getConfig === "function"
            ? ((api.getConfig() as PluginConfig)?.permissionMode ?? standalonePermissionMode)
            : standalonePermissionMode;

        // Audit: log permission change
        const auditEntry: AuditEntry = {
          timestamp: new Date().toISOString(),
          action: "permission_change",
          target: params.mode,
          reason: params.reason,
          previousMode,
        };

        if (typeof api.updateConfig === "function") {
          await maybeAwait(api.updateConfig({ permissionMode: params.mode }));
        } else {
          standalonePermissionMode = params.mode;
          for (const [, entry] of standaloneStore) {
            entry.state.permissionMode = params.mode;
            entry.state.auditLog.push(auditEntry);
          }
        }

        return textResult(
          [
            `🔐 Permission mode: ${previousMode} → ${params.mode}`,
            params.reason ? `Reason: ${params.reason}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    });

    api.on("before_prompt_build", async (event: PromptBuildEvent) => {
      const config = readConfig(api);
      if (config.forceContinuation === false) return {};

      const incomingText = event.prompt ?? "";
      const messages = event.messages ?? [];
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const lastAssistantMsg = [...messages].reverse().find((m) => m.role === "assistant");
      const fullIncomingText = [incomingText, lastUserMsg?.content].filter(Boolean).join("\n");
      if (containsKeyword(fullIncomingText, config.cancelKeywords ?? DEFAULT_CANCEL_KEYWORDS))
        return {};

      const previousText = lastAssistantMsg?.content ?? "";
      if (/STOP_REQUEST/.test(previousText)) return {};

      // IntentGate: detect destructive patterns
      const intentWarnings = checkIntentGate(fullIncomingText);

      const taskFlow = findActiveWorkflow(api, event);
      let state = taskFlow ? readWorkflowState(taskFlow.stateJson) : undefined;

      if (!state) {
        const latestKey = [...standaloneStore.keys()].pop();
        if (latestKey) {
          const entry = standaloneStore.get(latestKey);
          if (entry) state = entry.state;
        }
      }

      const incomplete =
        state?.tasks.filter((task) => task.status === "pending" || task.status === "running") ?? [];
      const blocked = state?.tasks.filter((task) => task.status === "blocked") ?? [];

      if (!state || (incomplete.length === 0 && blocked.length === 0)) {
        // No active workflow, but still check IntentGate
        if (intentWarnings.length > 0) {
          return { prependSystemContext: intentWarnings.join("\n") };
        }
        return {};
      }

      return {
        prependSystemContext: buildEnhancedContinuationContext(
          state,
          incomplete,
          blocked,
          intentWarnings,
        ),
      };
    });
  },
});

// --- IntentGate ---

function checkIntentGate(text: string): string[] {
  const warnings: string[] = [];
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(text)) {
      warnings.push(
        "⚠️ INTENT GATE: Destructive operation detected. Verify scope, backup exists, and this is intentional before proceeding.",
      );
      break;
    }
  }
  return warnings;
}

// --- Enhanced Continuation Context ---

function buildEnhancedContinuationContext(
  state: WorkflowState,
  incomplete: TaskItem[],
  blocked: TaskItem[],
  intentWarnings: string[],
): string {
  const nextTask = incomplete.find((t) => t.status === "running") ?? incomplete[0];
  const completedCount = countTasks(state.tasks, (t) => t.status === "completed");
  const totalCount = countTasks(state.tasks, () => true);

  const lines: string[] = [
    `🔴 STRUCTURED WORKFLOW ACTIVE — Continue until all tasks complete.`,
    `Workflow: ${state.title}`,
    `Progress: ${completedCount}/${totalCount} complete | ${incomplete.length} remaining`,
    "",
  ];

  if (nextTask) {
    lines.push(`▸ NEXT TASK: ${nextTask.id}. ${nextTask.title} (${nextTask.status})`);
    if (nextTask.description) lines.push(`  ${nextTask.description}`);
    if (nextTask.decisionPolicy !== "auto") lines.push(`  Policy: ${nextTask.decisionPolicy}`);
    lines.push("");
  }

  if (blocked.length > 0) {
    lines.push("🚫 BLOCKED TASKS:");
    for (const b of blocked) {
      lines.push(`  - ${b.id}. ${b.title}${b.blockedReason ? `: ${b.blockedReason}` : ""}`);
    }
    lines.push("  → Resolve blockers or skip them before proceeding to remaining tasks.", "");
  }

  lines.push("Remaining tasks:");
  for (const task of incomplete) {
    lines.push(`  ${STATUS_ICONS[task.status]} ${task.id}. ${task.title}`);
  }

  lines.push("");
  lines.push("Rules:");
  lines.push("- Do NOT declare workflow complete until all tasks are completed/skipped.");
  lines.push("- Provide evidence when completing tasks (test output, URLs, screenshots).");
  lines.push("- If blocked, explain why and what's needed to unblock.");
  lines.push("- If user explicitly cancels, honor it immediately.");

  if (intentWarnings.length > 0) {
    lines.push("", ...intentWarnings);
  }

  return lines.join("\n");
}

// --- Utilities ---

function readConfig(
  api: Record<string, unknown>,
): Required<
  Pick<
    PluginConfig,
    | "permissionMode"
    | "deliberateDefaultAgents"
    | "deliberateMaxRounds"
    | "forceContinuation"
    | "cancelKeywords"
    | "flowDetectionMode"
    | "activationKeywords"
  >
> {
  const cfg =
    typeof api.getConfig === "function" ? (api.getConfig() as PluginConfig | undefined) : undefined;
  return {
    permissionMode: cfg?.permissionMode ?? "bypass",
    deliberateDefaultAgents: cfg?.deliberateDefaultAgents ?? [],
    deliberateMaxRounds: cfg?.deliberateMaxRounds ?? 3,
    forceContinuation: cfg?.forceContinuation ?? true,
    cancelKeywords: cfg?.cancelKeywords ?? DEFAULT_CANCEL_KEYWORDS,
    flowDetectionMode: cfg?.flowDetectionMode ?? "auto",
    activationKeywords: cfg?.activationKeywords ?? ACTIVATION_KEYWORDS,
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
  const state = value as Partial<WorkflowState>;
  if (state.type !== "workflow" || !Array.isArray(state.tasks)) return undefined;
  return {
    type: "workflow",
    title: String(state.title ?? "Workflow"),
    tasks: state.tasks.map(normalizeTask),
    permissionMode: (state.permissionMode ?? "bypass") as PermissionMode,
    allowedOperations: Array.isArray(state.allowedOperations)
      ? state.allowedOperations.map(String)
      : [],
    createdAt: String(state.createdAt ?? new Date().toISOString()),
    updatedAt: String(state.updatedAt ?? new Date().toISOString()),
    auditLog: Array.isArray(state.auditLog) ? state.auditLog : [],
  };
}

function normalizeTasks(
  tasks: Array<Partial<TaskItem>>,
  config: ReturnType<typeof readConfig>,
): TaskItem[] {
  return tasks.map((task) => ({
    id: String(task.id),
    title: String(task.title),
    description: task.description,
    status: "pending",
    decisionPolicy: task.decisionPolicy ?? inferDecisionPolicy(task, config),
    deliberateWith: task.deliberateWith ?? [],
    assignedAgent: task.assignedAgent ?? null,
    sessionKey: task.sessionKey ?? null,
    completedAt: task.completedAt ?? null,
    evidence: task.evidence ?? null,
    blockedReason: task.blockedReason ?? null,
    subTasks: task.subTasks?.map(normalizeTask),
  }));
}

function normalizeTask(task: Partial<TaskItem>): TaskItem {
  return {
    id: String(task.id ?? ""),
    title: String(task.title ?? ""),
    description: task.description,
    status: (task.status ?? "pending") as TaskStatus,
    decisionPolicy: (task.decisionPolicy ?? "auto") as DecisionPolicy,
    deliberateWith: task.deliberateWith ?? [],
    assignedAgent: task.assignedAgent ?? null,
    sessionKey: task.sessionKey ?? null,
    completedAt: task.completedAt ?? null,
    evidence: task.evidence ?? null,
    blockedReason: task.blockedReason ?? null,
    subTasks: task.subTasks?.map(normalizeTask),
  };
}

function inferDecisionPolicy(
  task: Partial<TaskItem>,
  config: ReturnType<typeof readConfig>,
): DecisionPolicy {
  if ((task.deliberateWith?.length ?? 0) > 0) return "deliberate";
  if ((task.title ?? "").match(/review|approve|confirm|security|deploy|money/i)) return "confirm";
  if (config.permissionMode === "confirm-each") return "confirm";
  return "auto";
}

function findTask(tasks: TaskItem[], taskId: string): TaskItem | undefined {
  for (const task of tasks) {
    if (task.id === taskId) return task;
    const nested = task.subTasks ? findTask(task.subTasks, taskId) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

function cloneWorkflowState(state: WorkflowState): WorkflowState {
  return {
    ...state,
    tasks: state.tasks.map((task) => ({
      ...task,
      subTasks: task.subTasks?.map((sub) => ({ ...sub })),
    })),
    allowedOperations: [...state.allowedOperations],
    auditLog: [...state.auditLog],
  };
}

function formatTaskList(state: WorkflowState, flowId?: string, revision?: number): string {
  const completed = countTasks(state.tasks, (task) => task.status === "completed");
  const total = countTasks(state.tasks, () => true);
  const blocked = countTasks(state.tasks, (task) => task.status === "blocked");
  const lines = [
    `📋 TASK LIST: ${state.title}`,
    flowId ? `Flow: ${flowId}${revision !== undefined ? ` (rev ${revision})` : ""}` : undefined,
    `Progress: ${completed}/${total} complete${blocked > 0 ? ` | ${blocked} blocked` : ""}`,
    "",
  ].filter(Boolean) as string[];

  for (const task of state.tasks) {
    lines.push(renderTask(task, 0));
  }

  if (state.auditLog.length > 0) {
    lines.push("", "📝 Audit Log:");
    const recent = state.auditLog.slice(-5);
    for (const entry of recent) {
      lines.push(
        `  ${entry.timestamp.slice(11, 19)} ${entry.action} → ${entry.target}${entry.reason ? ` (${entry.reason})` : ""}`,
      );
    }
  }

  return lines.join("\n");
}

function renderTask(task: TaskItem, depth: number): string {
  const indent = "  ".repeat(depth);
  const policy = task.decisionPolicy !== "auto" ? ` [${task.decisionPolicy}]` : "";
  const meta = [
    task.assignedAgent ? `agent=${task.assignedAgent}` : null,
    task.sessionKey ? `session=${task.sessionKey}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [
    `${indent}${STATUS_ICONS[task.status]} ${task.id}. ${task.title}${policy}${meta ? ` (${meta})` : ""}`,
  ];
  if (task.description) lines.push(`${indent}  ${task.description}`);
  if (task.evidence) lines.push(`${indent}  evidence: ${task.evidence}`);
  if (task.blockedReason) lines.push(`${indent}  blocked: ${task.blockedReason}`);
  for (const sub of task.subTasks ?? []) lines.push(renderTask(sub, depth + 1));
  return lines.join("\n");
}

function countTasks(tasks: TaskItem[], predicate: (task: TaskItem) => boolean): number {
  let count = 0;
  for (const task of tasks) {
    if (predicate(task)) count += 1;
    if (task.subTasks) count += countTasks(task.subTasks, predicate);
  }
  return count;
}

function containsKeyword(text: string, keywords: string[]): boolean {
  const normalized = text.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

export function shouldActivateFlow(text: string, config: ReturnType<typeof readConfig>): boolean {
  if (config.flowDetectionMode === "keyword-only") {
    return containsKeyword(text, config.activationKeywords);
  }
  if (containsKeyword(text, config.activationKeywords)) return true;
  return COMPLEXITY_HINTS.some((pattern) => pattern.test(text)) && text.length > 80;
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
