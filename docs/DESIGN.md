# Design: Structured Workflow Plugin

## Architecture

```
┌─────────────────────────────────────────────┐
│              OpenClaw Gateway                │
├─────────────────────────────────────────────┤
│  Plugin: structured-workflow                │
│  ├─ Tools (4)                               │
│  │  ├─ tasklist_create                      │
│  │  ├─ tasklist_update                      │
│  │  ├─ tasklist_status                      │
│  │  └─ tasklist_permission                  │
│  └─ Hook (1)                                │
│     └─ before_prompt_build (forced continu.)│
├─────────────────────────────────────────────┤
│  Storage Layer                              │
│  ├─ TaskFlow Runtime (preferred)            │
│  │  └─ api.runtime.tasks.flow               │
│  └─ Standalone Fallback (in-memory Map)     │
│     └─ standaloneStore (max 50 entries)     │
└─────────────────────────────────────────────┘
```

## Dual Storage Mode

### TaskFlow Mode (preferred)
- Used when `api.runtime.tasks.flow.fromToolContext(ctx)` succeeds
- Durable state, revision tracking, session binding
- Requires `ctx.sessionKey` (available in main/agent sessions)

### Standalone Mode (fallback)
- Activated when TaskFlow throws (missing `sessionKey`)
- In-memory `Map<string, { state, revision }>`
- GC: prunes to 50 entries on new workflow creation
- Survives for gateway process lifetime only
- `tasklist_permission` stores mode in `standalonePermissionMode`

## Tool Flow

```
tasklist_create:
  1. Try getTaskFlow(api, ctx) → catch → undefined
  2. If TaskFlow: createManaged() → flowId + revision
  3. If standalone: increment counter → store in Map
  4. Return formatted task list

tasklist_update:
  1. Try getTaskFlow → TaskFlow state
  2. If no TaskFlow: find latest from standaloneStore
  3. Apply status change, optional fields
  4. Write back to respective store
  5. If running + sessionKey + TaskFlow: runTask()

tasklist_status:
  1. Try TaskFlow first, then standalone
  2. Return formatted progress

tasklist_permission:
  1. Try api.updateConfig() (plugin config persistence)
  2. If unavailable: store in standalonePermissionMode + update all workflows
```

## Hook: before_prompt_build

```
On every prompt build:
  1. Check forceContinuation config (default: true)
  2. Check cancel keywords in incoming message → skip if found
  3. Check STOP_REQUEST in previous response → skip if found
  4. Try findActiveWorkflow(api, event) → TaskFlow
  5. If no TaskFlow: check standaloneStore for latest workflow
  6. Find incomplete tasks (pending/running)
  7. If found: inject prependSystemContext with continuation reminder
```

## Configuration Requirements

### tools.alsoAllow
Plugin tools are NOT included in `tools.profile: "coding"`. Must add:
```json
"alsoAllow": ["tasklist_create", "tasklist_update", "tasklist_status", "tasklist_permission"]
```

### Plugin config
```json
{
  "permissionMode": "bypass" | "allow-after-first" | "confirm-each",
  "forceContinuation": true,
  "cancelKeywords": ["/stop", "キャンセル", "cancel", "stop"],
  "flowDetectionMode": "auto" | "keyword-only",
  "activationKeywords": ["ultrawork", "ulw", "task-driven"]
}
```

## Key Learnings

1. **TaskFlow fromToolContext throws**: `ctx.sessionKey` is validated inside OpenClaw's runtime before returning. Must use try-catch.
2. **Plugin tools need alsoAllow**: `tools.profile: "coding"` is a whitelist that excludes plugin tools.
3. **@sinclair/typebox**: Must be in plugin's `dependencies` even though OpenClaw provides it at runtime (path resolution issue).
4. **SeaORM Proxy API**: `ProxyRow`/`ProxyExecResult` are not re-exported at crate root. Use simpler Extension-based approaches instead.
