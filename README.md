# Structured Workflow Plugin for OpenClaw

Task-list driven workflow with structured decomposition, decision policies, permission modes, and forced continuation.

## Features

- **Structured Task Lists**: Create decomposed task lists with IDs, titles, descriptions, and decision policies
- **Decision Policies**: `auto`, `deliberate`, `confirm`, `notify` — control how each task is executed
- **Permission Modes**: `bypass`, `allow-after-first`, `confirm-each` — scope agent autonomy
- **Forced Continuation**: `before_prompt_build` hook injects context to keep agents on-task
- **TaskFlow Compatible**: Uses OpenClaw's TaskFlow runtime when available; falls back to standalone in-memory mode
- **Cancel Keywords**: Users can cancel with `/stop`, `キャンセル`, etc.

## Installation

```bash
# From local source
openclaw plugins install ~/openclaw-structured-workflow

# Restart gateway to load
openclaw gateway restart
```

### Required Configuration

Add plugin tools to `tools.alsoAllow` in your OpenClaw config (`~/.openclaw/openclaw.json`):

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

> **Note**: The `coding` profile does not include plugin-provided tools by default. You must add them to `alsoAllow`.

### Plugin Config (Optional)

```json
{
  "plugins": {
    "entries": {
      "structured-workflow": {
        "enabled": true,
        "config": {
          "permissionMode": "bypass",
          "forceContinuation": true,
          "cancelKeywords": ["/stop", "キャンセル", "cancel", "stop"],
          "flowDetectionMode": "auto",
          "activationKeywords": ["ultrawork", "ulw", "task-driven"]
        }
      }
    }
  }
}
```

## Tools

### `tasklist_create`

Create a structured task list for a complex instruction.

```json
{
  "title": "Implement Feature X",
  "tasks": [
    { "id": "1", "title": "Design schema", "decisionPolicy": "auto" },
    { "id": "2", "title": "Implement API", "description": "CRUD endpoints", "decisionPolicy": "auto" },
    { "id": "3", "title": "Security review", "decisionPolicy": "confirm" },
    { "id": "4", "title": "Deploy", "decisionPolicy": "notify" }
  ]
}
```

### `tasklist_update`

Update a task's status in the workflow.

```json
{
  "taskId": "1",
  "status": "running",
  "assignedAgent": "worker-coder",
  "sessionKey": "agent:worker-coder:subagent:abc123"
}
```

Valid statuses: `running`, `completed`, `skipped`, `blocked`

### `tasklist_status`

Show current task list status for a workflow.

```json
{ "flowId": "standalone-1" }
```

### `tasklist_permission`

Switch permission mode.

```json
{ "mode": "allow-after-first" }
```

Valid modes: `bypass`, `allow-after-first`, `confirm-each`

## Decision Policies

| Policy | Behavior |
|--------|----------|
| `auto` | Agent proceeds without confirmation |
| `deliberate` | Agent discusses approach before proceeding |
| `confirm` | Agent waits for explicit user approval |
| `notify` | Agent informs user after completion |

## Standalone Mode

When OpenClaw's TaskFlow runtime is not available (e.g., sub-agent sessions without `sessionKey`), the plugin automatically falls back to an in-memory store. All tools work in standalone mode:

- Workflows are stored in memory for the gateway process lifetime
- Revision tracking still works
- `tasklist_permission` requires `api.updateConfig` (not available in standalone)

## Hook: `before_prompt_build`

When a workflow has incomplete tasks, the plugin injects a system context reminder:

```
Continue the active structured workflow.
Workflow: Implement Feature X
Remaining tasks: 2
Focus on the next pending or running task before answering anything else.
If the user explicitly requested cancellation, honor it instead.
```

This keeps the agent focused on completing the task list.

## Development

```bash
# Install dependencies
npm install

# Lint and format
npx @biomejs/biome check --write src/index.ts

# Reinstall after changes
rm -rf ~/.openclaw/extensions/structured-workflow
openclaw plugins install ~/openclaw-structured-workflow
openclaw gateway restart
```

## License

MIT
