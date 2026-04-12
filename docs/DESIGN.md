# Design: Structured Workflow Plugin vNext

## Goals

- preserve core tasklist capabilities
- add cache-safe active-workflow phase injection
- scope workflow lookup to this plugin's managed flows
- avoid invalid-state amplification on reminder / internal-context turns
- clean up dead `forceContinuation` semantics

## Responsibility

### Do

- create/update/show structured task lists
- inject a short active-workflow banner on meaningful turns
- suggest workflow bootstrap for complex requests
- keep workflow state inside TaskFlow managed flows

### Do Not

- implement forced continuation
- own approval policy
- own standalone persistence
- own compaction or prompt pruning
- rewrite unrelated TaskFlow controllers

## State Ownership

Managed flows created by this plugin always use:

```text
controllerId = "structured-workflow/tasklist"
```

Lookup rules:

1. enumerate `taskFlow.list()`
2. keep only flows with this controller id
3. prefer active statuses: `queued`, `running`, `waiting`, `blocked`
4. otherwise fall back to the latest terminal flow for `tasklist_status`

This replaces blind `findLatest()`, which can pick another controller's flow and cause false `invalid state` errors.

## Active Workflow Injection

### Why

The original docs implied always-on phase injection. The idea is valid, but naive per-turn injection is hostile to provider-side prompt caching. vNext keeps the guidance while making the injected block short and deterministic.

### Injection contract

The plugin injects a banner only when:

- an active structured workflow exists
- the incoming turn is not a volatile system/runtime wrapper

Injected fields:

```text
🔴 WORKFLOW ACTIVE
Title: ...
Phase: plan|execute|verify|fix
Current: ...
Next: ...
Blocked: ...
References:
- ...
Rules:
- ...
```

### Volatile turn suppression

No injection on turns that begin with or contain wrappers such as:

- `System: [...]`
- `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>`
- `[Queued messages while agent was busy]`
- `Conversation info (untrusted metadata):`
- async exec completion notices
- heartbeat / tasklist reminder prompts

This avoids adding one more volatile prefix block on turns that already tend to break cache reuse.

## Phase Heuristic

The banner phase is derived from task state:

- `fix`: any blocked task exists
- `plan`: nothing has started yet
- `verify`: all remaining work looks verification-oriented
- `execute`: otherwise

`verify` is heuristic, based on task id/title/description keywords such as `verify`, `test`, `review`, `確認`, `検証`, `動作確認`.

## Bootstrap Detection

If no active workflow exists, the plugin can inject a bootstrap prompt that requires `tasklist_create`.

Modes:

- `auto`: complex-instruction heuristic OR activation keyword
- `keyword-only`: activation keyword only

Default activation keywords:

- `ultrawork`
- `ulw`
- `task-driven`

## Deprecated Config

`forceContinuation` and `cancelKeywords` remain accepted for compatibility, but are intentionally ignored.

Reason:

- `before_prompt_build` runs before the next response, not after the agent decides to stop
- true forced continuation would need a different lifecycle hook or stop gate

Keeping the field but marking it deprecated avoids breaking existing local config while removing false promises from behavior.

## Output Design

### `tasklist_status`

- never calls another controller's flow
- never emits `invalid state` as a user-facing error for unrelated flows
- returns the latest structured workflow if available

### `tasklist_update`

- updates only the latest active structured workflow
- if none exists, returns a calm informational message instead of error amplification

## Non-goals for vNext

- idle detection
- reminder-aware task automation
- workflow-specific approval gates
- persistent audit logging
- active workflow summarization beyond the short banner
