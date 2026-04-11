# Design Document

## Overview

Structured Workflow is an OpenClaw plugin that brings ULW (Ultrawork)-style task-list driven workflows to OpenClaw agents. It leverages the built-in TaskFlow runtime for durable state management.

## Core Concepts

### Task Lifecycle

```
pending → running → completed
                 → skipped
                 → blocked
```

### Decision Policies

Each task has a `decisionPolicy` that determines how decisions are made:

| Policy | Who decides | Use case |
|--------|------------|----------|
| `auto` | Assigned agent autonomously | Implementation, testing, research |
| `deliberate` | Multiple agents discuss | Architecture, design, strategy |
| `confirm` | Human must approve | Money-path, security, deployment |
| `notify` | Agent executes, reports result | Status updates, summaries |

### Permission Modes

Inspired by Claude Code's permission system:

| Mode | Behavior |
|------|----------|
| `bypass` | No confirmations. Full autonomous execution. |
| `allow-after-first` | First occurrence of each operation type requires confirmation. Subsequent same-type operations proceed automatically. |
| `confirm-each` | Every step requires human confirmation. |

Mode can be switched at any time via the `tasklist_permission` tool or a slash command.

### Flow Detection

Messages are classified into:

1. **Simple conversation** — No flow created. Agent responds normally.
2. **Complex task** — Flow created, task list generated, execution begins.

Detection strategies:
- `auto` — Plugin + agent heuristics analyze message complexity
- `keyword-only` — Only activate on explicit keywords (ultrawork, ulw, task-driven)

### Forced Continuation

When `forceContinuation` is enabled:
- `before_prompt_build` hook checks active flows for incomplete tasks
- If incomplete tasks exist and no cancel keyword detected → inject continuation prompt
- Cancel keywords (`/stop`, `やめて`, `cancel`, etc.) always take priority

### Deliberate (Multi-agent Discussion)

When a task has `decisionPolicy: "deliberate"`:
1. Plugin dispatches discussion to configured agents
2. Rounds: configurable (default 3 max)
3. Termination: consensus score threshold OR max rounds reached
4. Result is written back to the task's state

This generalizes the T1 discussion pattern. Project-specific discussion formats are handled by skills, not the plugin.

## Task State (stateJson)

```json
{
  "type": "workflow",
  "title": "Stripe Cancellation Flow",
  "tasks": [
    {
      "id": "1",
      "title": "Requirements Research",
      "status": "completed",
      "decisionPolicy": "auto",
      "assignedAgent": "worker-coder",
      "sessionKey": "agent:worker-coder:subagent:abc123",
      "completedAt": "2026-04-11T01:03:00Z",
      "evidence": "Found existing patterns in src/stripe/"
    },
    {
      "id": "2",
      "title": "Architecture Design",
      "status": "running",
      "decisionPolicy": "deliberate",
      "deliberateWith": ["brain", "worker-frontend"],
      "assignedAgent": "brain",
      "sessionKey": "agent:brain:subagent:def456"
    }
  ],
  "permissionMode": "bypass",
  "createdAt": "2026-04-11T01:00:00Z",
  "updatedAt": "2026-04-11T01:03:00Z"
}
```

## Tools Provided

| Tool | Description |
|------|-------------|
| `tasklist_create` | Create a structured task list with decision policies |
| `tasklist_update` | Update task status with evidence |
| `tasklist_status` | Show current workflow status |
| `tasklist_permission` | Switch permission mode |

## Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| Forced continuation | `before_prompt_build` | Inject continuation prompt for incomplete tasks |

## Configuration

See `openclaw.plugin.json` for the full config schema.
