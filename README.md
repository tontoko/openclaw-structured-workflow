# OpenClaw Structured Workflow Plugin

Task-list driven workflow plugin for [OpenClaw](https://github.com/openclaw/openclaw), inspired by [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)'s ULW (Ultrawork) mode.

Built on OpenClaw's **TaskFlow** runtime for durability across gateway restarts.

## Features

- **Structured Task Decomposition**: Automatically breaks complex instructions into phased task lists (research → design → test → implement → test → verify)
- **Decision Policies**: Each task can have a different decision level:
  - `auto` — Agent proceeds independently
  - `deliberate` — Dispatch discussion to multiple agents (configurable)
  - `confirm` — Requires human approval before proceeding
  - `notify` — Execute then report result
- **Permission Modes** (Claude Code-style):
  - `bypass` — No confirmation needed, full speed ahead
  - `allow-after-first` — Confirm once per operation type, then auto
  - `confirm-each` — Confirm every step
- **Forced Continuation**: Via `before_prompt_build` hook — incomplete tasks trigger continuation instructions. Cancel keywords always take priority.
- **Durable State**: TaskFlow `stateJson` persists task lists, agent assignments, and session links across restarts
- **Task ↔ Agent ↔ Session Tracking**: Each task links to the executing agent and session for full traceability
- **Normal Conversation Friendly**: Flow detection passes simple messages through without creating task flows

## Install

```bash
openclaw plugins install @tontoko/openclaw-structured-workflow
```

## Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "structured-workflow": {
        "enabled": true,
        "config": {
          "permissionMode": "bypass",
          "forceContinuation": true,
          "deliberateDefaultAgents": [],
          "deliberateMaxRounds": 3,
          "cancelKeywords": ["/stop", "やめて", "cancel", "stop"]
        }
      }
    }
  }
}
```

## Architecture

```
User Instruction
  ↓
before_prompt_build: Flow Detection
  ├─ Simple message → pass through (no flow created)
  └─ Complex task → TaskFlow.createManaged()
       ↓
  Task List Generation (each task with decisionPolicy)
       ↓
  Execution Loop:
    ├─ auto → dispatch to target agent → await completion
    ├─ deliberate → dispatch discussion to multiple agents → await consensus
    ├─ confirm → setWaiting() → await human response → resume()
    └─ notify → execute + send result notification
       ↓
  Force Continuation Check (before_prompt_build):
    ├─ All complete → finish()
    ├─ Incomplete + no cancel keyword → inject continuation prompt
    └─ Cancel keyword detected → allow stop
```

## CLI

```bash
openclaw tasks flow list          # List active workflows
openclaw tasks flow show <id>     # Inspect a workflow with all tasks and agent links
```

## License

MIT
