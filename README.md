# Structured Workflow for OpenClaw

`structured-workflow` is a TaskFlow-backed OpenClaw plugin that adds a thin,
owner-scoped workflow layer on top of the built-in tasklist tools.

It is designed for explicit ultrawork-style sessions where the user opts into a
workflow by using `ulw` or `ultrawork` in the request. Once a workflow is
active, the plugin injects a short, deterministic phase banner on meaningful
turns so the agent can keep its place without adding large, volatile prompt
blocks.

## What It Does

- Registers `tasklist_create`, `tasklist_update`, `tasklist_status`, and
  `tasklist_permission`
- Stores workflow state in TaskFlow, scoped to this plugin's own controller
- Injects a compact active-workflow banner only when a structured workflow is
  already active
- Skips injection on volatile turns such as reminders, internal runtime context,
  queued-message wrappers, and async command notices
- Offers workflow bootstrap guidance only for explicit ultrawork triggers
- Requests a one-time visible acknowledgement (`ULW enabled.`) when explicit
  ultrawork bootstrap is triggered

## What It Does Not Do

- Force continuation after every assistant turn
- Replace OpenClaw compaction or context pruning
- Provide its own state store outside TaskFlow
- Orchestrate sub-agents by itself

## Trigger Model

By default, workflow bootstrap is **keyword-only**.

That means the plugin suggests or starts a structured workflow only when the
incoming prompt explicitly includes one of these activation keywords:

- `ulw`
- `ultrawork`

Complex-looking requests without those keywords do **not** trigger workflow
bootstrap by default.

When bootstrap is triggered by `ulw` or `ultrawork`, the plugin asks the agent
to begin its first visible reply with:

```text
ULW enabled.
```

This keeps the opt-in state visible without adding a noisy banner on every
subsequent turn.

## Installation

```bash
openclaw plugins install ~/openclaw-structured-workflow
openclaw gateway restart
```

## Required OpenClaw Tool Access

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": [
      "browser",
      "tasklist_create",
      "tasklist_update",
      "tasklist_status",
      "tasklist_permission"
    ]
  }
}
```

## Plugin Configuration

```json
{
  "plugins": {
    "entries": {
      "structured-workflow": {
        "enabled": true,
        "config": {
          "permissionMode": "bypass",
          "flowDetectionMode": "keyword-only",
          "activationKeywords": ["ultrawork", "ulw"]
        }
      }
    }
  }
}
```

### Config Fields

- `permissionMode`
  Permission mode used for task execution state.
- `flowDetectionMode`
  `keyword-only` means workflow bootstrap is only triggered by activation
  keywords. `auto` is still supported for experiments, but is no longer the
  default.
- `activationKeywords`
  Keywords that opt the session into structured workflow bootstrap.
- `forceContinuation`
  Deprecated compatibility field. Accepted but ignored.
- `cancelKeywords`
  Deprecated compatibility field. Accepted but ignored.

## Tools

### `tasklist_create`

Creates a structured task list for the current session.

```json
{
  "title": "Implement Feature X",
  "tasks": [
    { "id": "investigate", "title": "Investigate requirements", "decisionPolicy": "auto" },
    { "id": "design", "title": "Design the approach", "decisionPolicy": "deliberate" },
    { "id": "implement", "title": "Implement the change", "decisionPolicy": "auto" },
    { "id": "verify", "title": "Verify behavior", "decisionPolicy": "auto" }
  ]
}
```

### `tasklist_update`

Updates task state for the latest active workflow owned by this plugin.

```json
{
  "taskId": "implement",
  "status": "running",
  "assignedAgent": "worker-coder",
  "sessionKey": "agent:worker-coder:subagent:abc123"
}
```

Valid statuses:

- `running`
- `completed`
- `skipped`
- `blocked`

### `tasklist_status`

Returns the latest structured workflow for the current session. If an active
workflow exists, it is preferred. Otherwise the latest terminal workflow is
returned.

```json
{}
```

### `tasklist_permission`

Updates the workflow permission mode.

```json
{ "mode": "allow-after-first" }
```

Valid modes:

- `bypass`
- `allow-after-first`
- `confirm-each`

## Active Workflow Guidance

When a structured workflow is active, the plugin injects a short phase banner in
`before_prompt_build`.

The banner is intentionally small and deterministic. It includes:

- workflow title
- current phase (`plan`, `execute`, `verify`, or `fix`)
- current task
- next task
- blocked summary
- compact references for the current task
- short execution rules

The plugin does **not** inject that banner on volatile turns, including:

- scheduled reminders
- `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>`
- `[Queued messages while agent was busy]`
- conversation metadata wrappers
- async exec completion notices
- heartbeat and tasklist reminder wrappers

This is deliberate: the plugin keeps workflow guidance available without adding
avoidable prompt-cache churn.

## Development

This repo should point at the shared `~/.codex/skills` library used by polku,
including the shared external-service skills.

```bash
npm install
npx ultracite fix src/index.ts README.md docs/DESIGN.md openclaw.plugin.json package.json
npx tsc --noEmit
openclaw plugins install ~/openclaw-structured-workflow
openclaw gateway restart
```

## License

MIT
