/**
 * Structured Workflow Plugin for OpenClaw v0.9.0
 *
 * TaskFlow 前提の薄い workflow layer。
 *
 * Design goals:
 * - core tasklist capabilities は維持
 * - active workflow では cache-safe な phase banner を注入
 * - owner-scoped workflow lookup を使い、他 controller の flow を拾わない
 * - reminder / internal runtime context では余計な注入や invalid-state amplification を避ける
 * - forceContinuation は deprecated にし、実行セマンティクスから外す
 */

import { Type } from "@sinclair/typebox";
// @ts-expect-error openclaw plugin SDK is provided by the host at build/runtime.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildWorkflowBootstrapPrompt,
  DEFAULT_ACTIVATION_KEYWORDS,
  DEFAULT_VISIBLE_ACK,
  isVolatilePrompt,
  matchActivationKeyword,
  normalizeVisibleText,
  prependVisibleAckToText,
  shouldSuggestWorkflow,
} from "./workflow-helpers.js";

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
  flowDetectionMode?: "auto" | "keyword-only";
  activationKeywords?: string[];
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
  runTask: (input: Record<string, unknown>) => {
    created: boolean;
    reason?: string;
    flow?: any;
    task?: any;
  };
  updateManaged?: (input: Record<string, unknown>) => {
    applied: boolean;
    flow: any;
    code?: string;
  };
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

type MessageSendingEvent = {
  content?: string;
};

type LlmOutputEvent = {
  assistantTexts?: string[];
};

type BeforeAgentReplyEvent = {
  cleanedBody?: string;
};

// --- Constants ---

const PLUGIN_ID = "structured-workflow";
const WORKFLOW_CONTROLLER_ID = `${PLUGIN_ID}/tasklist`;
const ACTIVE_FLOW_STATUSES = new Set(["queued", "running", "waiting", "blocked"]);
const VERIFY_KEYWORDS = [
  "verify",
  "verification",
  "test",
  "tests",
  "qa",
  "check",
  "review",
  "validate",
  "validation",
  "確認",
  "検証",
  "テスト",
  "試験",
  "レビュー",
  "動作確認",
];
const MAX_REFERENCE_COUNT = 3;
const MAX_REFERENCE_NOTE_CHARS = 96;

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
  description: "Owner-scoped tasklist workflow plugin with cache-safe active-workflow guidance.",

  register(api: any) {
    const logger = api.logger ?? { info: () => {}, warn: () => {}, error: () => {} };

    const flowApi = resolveFlowApi(api);
    const pendingVisibleAckSessions = new Set<string>();
    const pendingVisibleAckTextByKey = new Map<string, string>();

    // --- Tool factory pattern (lobster-style) ---
    api.registerTool(
      (ctx: ToolContext) => {
        if (!ctx?.sessionKey) {
          logger.warn?.(`[${PLUGIN_ID}] Tool factory: no sessionKey. Tools not registered.`);
          return null;
        }

        const taskFlow = flowApi
          ? flowApi.fromToolContext({
              sessionKey: ctx.sessionKey,
              deliveryContext: ctx.deliveryContext,
            })
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
              controllerId: WORKFLOW_CONTROLLER_ID,
              goal: params.title,
              currentStep: "create task list",
              stateJson: JSON.stringify(state),
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
            const latest = findLatestStructuredWorkflow(taskFlow, { includeTerminal: false });
            const current = readWorkflowState(latest?.stateJson);
            if (!latest || !current) {
              return textResult("No active structured workflow in this session.");
            }

            if (
              params.expectedRevision !== undefined &&
              latest.revision !== undefined &&
              params.expectedRevision !== latest.revision
            ) {
              return toolError(
                `Revision conflict: expected ${params.expectedRevision}, current ${latest.revision}.`,
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

            const flowId = latest.flowId;
            const revision = latest.revision ?? 0;

            const allDone = next.tasks.every(
              (t) => t.status === "completed" || t.status === "skipped",
            );

            if (allDone) {
              const finished = taskFlow.finish({
                flowId,
                expectedRevision: revision,
                stateJson: JSON.stringify(next),
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
              stateJson: JSON.stringify(next),
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
            const latest = findLatestStructuredWorkflow(taskFlow, { includeTerminal: true });
            if (!latest) return textResult("No structured workflow found in this session.");

            const state = readWorkflowState(latest.stateJson);
            if (!state) {
              logger.warn?.(
                `[${PLUGIN_ID}] Ignoring structured workflow with unreadable state (${latest.flowId}).`,
              );
              return textResult("Structured workflow state is unavailable for the latest flow.");
            }

            return textResult(formatTaskList(state, latest.flowId, latest.revision));
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
      },
      { optional: true },
    );

    // --- Hook: before_prompt_build ---
    // vNext behavior:
    // - active structured workflow => inject a short, deterministic phase banner
    // - no active workflow + complex intent => prompt tasklist_create bootstrap
    // - volatile/system turns => inject nothing to avoid prefix churn
    api.on("before_prompt_build", async (event: PromptBuildEvent, hookCtx: HookAgentContext) => {
      const sessionKey = hookCtx?.sessionKey;
      if (!sessionKey) return {};

      if (!flowApi) return {};

      const cfg = readConfig(api);
      const promptSnapshot = readPromptSnapshot(event);
      if (isVolatilePrompt(promptSnapshot.latestText)) return {};

      const boundFlow = flowApi.bindSession({ sessionKey });
      const activeWorkflow = findLatestStructuredWorkflow(boundFlow, { includeTerminal: false });

      if (activeWorkflow) {
        const state = readWorkflowState(activeWorkflow.stateJson);
        if (!state) {
          logger.warn?.(
            `[${PLUGIN_ID}] Skipping active banner because workflow state is unreadable (${activeWorkflow.flowId}).`,
          );
          return {};
        }

        return {
          prependSystemContext: buildActiveWorkflowBanner(state),
        };
      }

      if (shouldSuggestWorkflow(promptSnapshot.latestText, cfg)) {
        const skeleton = DEFAULT_TASK_SKELETON.map((t) => `- ${t.id}: ${t.title}`).join("\n");
        const ackKey = collectAckKey(hookCtx);
        if (ackKey) pendingVisibleAckSessions.add(ackKey);
        logger.info?.(`[${PLUGIN_ID}] queued visible ack for key: ${ackKey ?? "(none)"}`);
        return {
          prependSystemContext: buildWorkflowBootstrapPrompt(
            skeleton,
            matchActivationKeyword(promptSnapshot.latestText, cfg),
          ),
        };
      }

      return {};
    });

    api.on("llm_output", (event: LlmOutputEvent, hookCtx: HookAgentContext) => {
      const ackKey = collectAckKey(hookCtx);
      if (!ackKey || !pendingVisibleAckSessions.has(ackKey)) {
        return;
      }
      if (pendingVisibleAckTextByKey.has(ackKey)) return;

      const firstVisibleText = (event.assistantTexts ?? []).find((text) => text.trim().length > 0);
      if (!firstVisibleText) return;

      const normalized = normalizeVisibleText(firstVisibleText);
      if (!normalized) return;

      pendingVisibleAckTextByKey.set(ackKey, normalized);
    });

    api.on("before_agent_reply", (event: BeforeAgentReplyEvent, hookCtx: HookAgentContext) => {
      const ackKey = collectAckKey(hookCtx);
      if (!ackKey || !pendingVisibleAckSessions.has(ackKey)) {
        return undefined;
      }

      const cleanedBody = typeof event?.cleanedBody === "string" ? event.cleanedBody : "";
      const normalizedBody = normalizeVisibleText(cleanedBody);
      if (!normalizedBody) return undefined;

      const expectedText = pendingVisibleAckTextByKey.get(ackKey);
      if (expectedText && expectedText !== normalizedBody) {
        return undefined;
      }

      pendingVisibleAckTextByKey.delete(ackKey);
      pendingVisibleAckSessions.delete(ackKey);

      return {
        handled: true,
        reply: {
          text: prependVisibleAckToText(cleanedBody, DEFAULT_VISIBLE_ACK),
        },
      };
    });

    api.on("message_sending", (event: MessageSendingEvent) => {
      const content = typeof event?.content === "string" ? event.content : "";
      const normalizedContent = normalizeVisibleText(content);
      if (!normalizedContent) return undefined;

      const matchedEntry = Array.from(pendingVisibleAckTextByKey.entries()).find(
        ([, expectedText]) => expectedText === normalizedContent,
      );
      if (!matchedEntry) return undefined;

      const [matchedKey] = matchedEntry;
      pendingVisibleAckTextByKey.delete(matchedKey);
      pendingVisibleAckSessions.delete(matchedKey);

      return {
        content: prependVisibleAckToText(content, DEFAULT_VISIBLE_ACK),
      };
    });

    api.on("session_end", async (_event: unknown, hookCtx: HookAgentContext) => {
      const ackKey = collectAckKey(hookCtx);
      if (!ackKey) return;
      pendingVisibleAckSessions.delete(ackKey);
      pendingVisibleAckTextByKey.delete(ackKey);
    });
  },
});

// --- TaskFlow Resolution ---

function resolveFlowApi(api: any): TaskFlowApi | undefined {
  return api?.runtime?.taskFlow ?? api?.runtime?.tasks?.flow;
}

function collectAckKey(ctx: HookAgentContext | undefined): string | undefined {
  const key = ctx?.sessionKey ?? ctx?.sessionId ?? ctx?.agentId;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

function readPromptSnapshot(event: PromptBuildEvent): { latestText: string } {
  const messageContents = (event.messages ?? [])
    .map((message) => readOptionalText(message.content))
    .filter((content): content is string => Boolean(content));
  const latestText =
    [readOptionalText(event.prompt), ...messageContents.slice().reverse()].find(Boolean) ?? "";
  return {
    latestText,
  };
}

function readOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

// --- Utilities ---

function readConfig(api: Record<string, unknown>): PluginConfig {
  const cfg =
    typeof api.getConfig === "function" ? (api.getConfig() as PluginConfig | undefined) : undefined;
  return {
    permissionMode: cfg?.permissionMode ?? "bypass",
    forceContinuation: cfg?.forceContinuation,
    cancelKeywords: cfg?.cancelKeywords,
    flowDetectionMode: cfg?.flowDetectionMode ?? "keyword-only",
    activationKeywords: cfg?.activationKeywords ?? DEFAULT_ACTIVATION_KEYWORDS,
  };
}

type StructuredWorkflowFlow = {
  flowId: string;
  revision: number;
  status: string;
  controllerId?: string;
  stateJson?: unknown;
  updatedAt?: number;
};

function findLatestStructuredWorkflow(
  taskFlow: Pick<BoundTaskFlow, "list">,
  options: { includeTerminal: boolean },
): StructuredWorkflowFlow | undefined {
  const candidates = taskFlow
    .list()
    .filter(isStructuredWorkflowFlow)
    .sort((left, right) => {
      const updatedDiff = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
      if (updatedDiff !== 0) return updatedDiff;
      return right.revision - left.revision;
    });

  if (options.includeTerminal) return candidates[0];
  return candidates.find((flow) => ACTIVE_FLOW_STATUSES.has(flow.status));
}

function isStructuredWorkflowFlow(value: unknown): value is StructuredWorkflowFlow {
  if (!value || typeof value !== "object") return false;
  const flow = value as Partial<StructuredWorkflowFlow>;
  return (
    typeof flow.flowId === "string" &&
    typeof flow.revision === "number" &&
    typeof flow.status === "string" &&
    flow.controllerId === WORKFLOW_CONTROLLER_ID
  );
}

function readWorkflowState(value: unknown): WorkflowState | undefined {
  if (!value) return undefined;

  // stateJson may be a JSON string (persisted) or an object (in-memory)
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  if (!parsed || typeof parsed !== "object") return undefined;
  const s = parsed as Partial<WorkflowState>;
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

function flattenTasks(tasks: TaskItem[]): TaskItem[] {
  return tasks.flatMap((task) => [task, ...(task.subTasks ? flattenTasks(task.subTasks) : [])]);
}

function cloneState(state: WorkflowState): WorkflowState {
  return JSON.parse(JSON.stringify(state)) as WorkflowState;
}

function buildActiveWorkflowBanner(state: WorkflowState): string {
  const tasks = flattenTasks(state.tasks);
  const currentTask = selectCurrentTask(tasks);
  const nextTask = selectNextTask(tasks, currentTask?.id);
  const blockedTasks = tasks.filter((task) => task.status === "blocked");
  const references = normalizeReferences(currentTask?.references ?? []);

  const lines = [
    "🔴 WORKFLOW ACTIVE",
    `Title: ${state.title}`,
    `Phase: ${determinePhase(tasks)}`,
    `Current: ${formatTaskSummary(currentTask)}`,
    `Next: ${formatTaskSummary(nextTask)}`,
    `Blocked: ${formatBlockedSummary(blockedTasks)}`,
    "References:",
    ...(references.length > 0 ? references.map((reference) => `- ${reference}`) : ["- none"]),
    "Rules:",
    "- Update the workflow when current or next task status changes.",
    "- Do not declare completion until every task is completed or skipped.",
    "- Include evidence when marking a task completed.",
  ];

  return lines.join("\n");
}

function determinePhase(tasks: TaskItem[]): "plan" | "execute" | "verify" | "fix" {
  if (tasks.some((task) => task.status === "blocked")) return "fix";

  const started = tasks.some((task) => task.status !== "pending");
  if (!started) return "plan";

  const remaining = tasks.filter((task) => task.status === "pending" || task.status === "running");
  if (
    remaining.length > 0 &&
    remaining.every((task) => {
      const probe = `${task.id} ${task.title} ${task.description ?? ""}`.toLowerCase();
      return VERIFY_KEYWORDS.some((keyword) => probe.includes(keyword.toLowerCase()));
    })
  ) {
    return "verify";
  }

  return "execute";
}

function selectCurrentTask(tasks: TaskItem[]): TaskItem | undefined {
  return (
    tasks.find((task) => task.status === "running") ??
    tasks.find((task) => task.status === "blocked") ??
    tasks.find((task) => task.status === "pending")
  );
}

function selectNextTask(tasks: TaskItem[], currentTaskId?: string): TaskItem | undefined {
  return tasks.find((task) => task.status === "pending" && task.id !== currentTaskId);
}

function formatTaskSummary(task: TaskItem | undefined): string {
  if (!task) return "none";
  return `${task.id}. ${task.title} [${task.status}]`;
}

function formatBlockedSummary(tasks: TaskItem[]): string {
  if (tasks.length === 0) return "none";
  return tasks
    .slice(0, 2)
    .map(
      (task) => `${task.id} (${task.blockedReason ? clipText(task.blockedReason, 72) : "blocked"})`,
    )
    .join(" | ");
}

function normalizeReferences(references: TaskReference[]): string[] {
  return references.slice(0, MAX_REFERENCE_COUNT).map((reference) => {
    const note = reference.note ? ` — ${clipText(reference.note, MAX_REFERENCE_NOTE_CHARS)}` : "";
    return `${reference.type}:${reference.value}${note}`;
  });
}

function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
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
