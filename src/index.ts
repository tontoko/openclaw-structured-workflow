/**
 * Structured Workflow Plugin for OpenClaw
 *
 * Task-list driven workflow with decision policies, permission modes,
 * and forced continuation. Built on TaskFlow for durability.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskItem {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "running" | "completed" | "skipped" | "blocked";
  decisionPolicy: "auto" | "deliberate" | "confirm" | "notify";
  deliberateWith?: string[];  // agent IDs for deliberate tasks
  assignedAgent?: string;
  sessionKey?: string;
  completedAt?: string;
  evidence?: string;
  subTasks?: TaskItem[];
}

interface WorkflowState {
  type: "workflow";
  title: string;
  tasks: TaskItem[];
  permissionMode: "bypass" | "allow-after-first" | "confirm-each";
  allowedOperations: Set<string>; // for allow-after-first mode
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ID = "structured-workflow";

const DEFAULT_CANCEL_KEYWORDS = [
  "/stop", "やめて", "ストップ", "キャンセル", "cancel", "stop",
];

const ACTIVATION_KEYWORDS = ["ultrawork", "ulw", "task-driven"];

// ---------------------------------------------------------------------------
// Plugin Entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Structured Workflow",
  description:
    "Task-list driven workflow with structured decomposition, decision policies, and forced continuation.",

  register(api) {
    // -----------------------------------------------------------------------
    // Tool: tasklist_create
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "tasklist_create",
      description:
        "Create a structured task list for a complex instruction. " +
        "Decomposes work into phased tasks with decision policies. " +
        "Use when the instruction requires multiple steps (research, design, implement, test, verify).",
      parameters: Type.Object({
        title: Type.String({ description: "Brief title for the workflow" }),
        tasks: Type.Array(
          Type.Object({
            id: Type.String(),
            title: Type.String(),
            description: Type.Optional(Type.String()),
            decisionPolicy: Type.Union([
              Type.Literal("auto"),
              Type.Literal("deliberate"),
              Type.Literal("confirm"),
              Type.Literal("notify"),
            ]),
            deliberateWith: Type.Optional(Type.Array(Type.String())),
          })
        ),
      }),
      async execute(_id, params, ctx) {
        const taskFlow = api.runtime?.tasks?.flow?.fromToolContext?.(ctx);
        if (!taskFlow) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: TaskFlow runtime not available.",
              },
            ],
          };
        }

        const tasks: TaskItem[] = params.tasks.map((t) => ({
          ...t,
          status: "pending" as const,
        }));

        const now = new Date().toISOString();
        const state: WorkflowState = {
          type: "workflow",
          title: params.title,
          tasks,
          permissionMode: "bypass", // from config in real impl
          allowedOperations: new Set(),
          createdAt: now,
          updatedAt: now,
        };

        const created = taskFlow.createManaged({
          controllerId: `${PLUGIN_ID}/tasklist`,
          goal: params.title,
          currentStep: "execute",
          stateJson: JSON.parse(JSON.stringify(state)),
        });

        const taskListMd = formatTaskList(params.title, tasks);

        return {
          content: [
            {
              type: "text" as const,
              text: `📋 Task list created (flow: ${created.flowId})\n\n${taskListMd}`,
            },
          ],
        };
      },
    });

    // -----------------------------------------------------------------------
    // Tool: tasklist_update
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "tasklist_update",
      description:
        "Update a task's status in the workflow. Provide evidence for completion.",
      parameters: Type.Object({
        flowId: Type.String({ description: "The flow ID to update" }),
        taskId: Type.String({ description: "Task ID to update" }),
        status: Type.Union([
          Type.Literal("running"),
          Type.Literal("completed"),
          Type.Literal("skipped"),
          Type.Literal("blocked"),
        ]),
        evidence: Type.Optional(
          Type.String({ description: "Evidence of completion or reason for skip/block" })
        ),
        assignedAgent: Type.Optional(Type.String()),
        sessionKey: Type.Optional(Type.String()),
      }),
      async execute(_id, params, ctx) {
        const taskFlow = api.runtime?.tasks?.flow?.fromToolContext?.(ctx);
        if (!taskFlow) {
          return {
            content: [
              { type: "text" as const, text: "Error: TaskFlow runtime not available." },
            ],
          };
        }

        // In real impl: read flow, update stateJson, write back with revision
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Task ${params.taskId} → ${params.status}${params.evidence ? `\nEvidence: ${params.evidence}` : ""}`,
            },
          ],
        };
      },
    });

    // -----------------------------------------------------------------------
    // Tool: tasklist_status
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "tasklist_status",
      description: "Show current task list status for a workflow.",
      parameters: Type.Object({
        flowId: Type.String({ description: "The flow ID to inspect" }),
      }),
      async execute(_id, params, ctx) {
        const taskFlow = api.runtime?.tasks?.flow?.fromToolContext?.(ctx);
        if (!taskFlow) {
          return {
            content: [
              { type: "text" as const, text: "Error: TaskFlow runtime not available." },
            ],
          };
        }

        // In real impl: read flow stateJson and format
        return {
          content: [
            { type: "text" as const, text: `Flow ${params.flowId} status: (placeholder)` },
          ],
        };
      },
    });

    // -----------------------------------------------------------------------
    // Tool: tasklist_permission
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "tasklist_permission",
      description:
        "Switch permission mode. Modes: bypass (no confirmation), allow-after-first (confirm once per type), confirm-each (confirm every step).",
      parameters: Type.Object({
        mode: Type.Union([
          Type.Literal("bypass"),
          Type.Literal("allow-after-first"),
          Type.Literal("confirm-each"),
        ]),
      }),
      async execute(_id, params) {
        return {
          content: [
            {
              type: "text" as const,
              text: `🔐 Permission mode set to: ${params.mode}`,
            },
          ],
        };
      },
    });

    // -----------------------------------------------------------------------
    // Hook: before_prompt_build — forced continuation
    // -----------------------------------------------------------------------
    api.on("before_prompt_build", async (event) => {
      // Check if there's an active workflow with incomplete tasks
      // If so, inject continuation instructions
      // Cancel keywords always take priority

      const config = api.getConfig?.() as Record<string, unknown> | undefined;
      const forceContinuation = (config?.forceContinuation ?? true) as boolean;
      if (!forceContinuation) return;

      const cancelKeywords = (
        (config?.cancelKeywords as string[]) ?? DEFAULT_CANCEL_KEYWORDS
      );

      // Check for cancel keywords in the incoming message
      const incomingText = (event as any).context?.bodyForAgent ?? "";
      if (
        cancelKeywords.some((kw) =>
          incomingText.toLowerCase().includes(kw.toLowerCase())
        )
      ) {
        // Let the cancel through
        return;
      }

      // In real impl: check active TaskFlow for incomplete tasks
      // If found, prepend continuation instructions
      // return { prependSystemContext: "..." };
    });
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<TaskItem["status"], string> = {
  pending: "☐",
  running: "🔄",
  completed: "✅",
  skipped: "⏭️",
  blocked: "❌",
};

function formatTaskList(title: string, tasks: TaskItem[]): string {
  const lines = [`📋 TASK LIST: ${title}`, ""];
  let completed = 0;

  for (const task of tasks) {
    const icon = STATUS_ICONS[task.status];
    const policy = task.decisionPolicy !== "auto" ? ` [${task.decisionPolicy}]` : "";
    lines.push(`${icon} ${task.id}. ${task.title}${policy}`);
    if (task.description) {
      lines.push(`   ${task.description}`);
    }
    if (task.status === "completed") completed++;
  }

  lines.push("");
  lines.push(`Status: ${completed}/${tasks.length} complete`);

  return lines.join("\n");
}
