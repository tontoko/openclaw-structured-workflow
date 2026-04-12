# Structured Workflow Plugin for OpenClaw

TaskFlow 前提の薄い behavior layer。task 状態に応じて、phase と completion guidance を動的注入します。

## Responsibility

この plugin の責務は次だけです。

- **Structured Task Lists**: tasklist tools で task 状態を扱う
- **Phase Injection**: `plan -> exec -> verify -> fix` を注入する
- **Completion Guidance**: current / next / completion condition / evidence を注入する
- **Idle Detection**: 停滞を検出し、current task へ戻す warning を出す
- **Reference Integration**: task に紐づく reference を軽量整形して注入する

この plugin が**持たない**責務:

- standalone fallback / 独自 state store
- 独自永続化
- audit log
- IntentGate / safety policy
- 承認・権限ポリシー本体
- 他 agent orchestration 本体

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
          "cancelKeywords": ["/stop", "キャンセル", "cancel", "stop"]
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

## Hook: `before_prompt_build`

この plugin の中核です。workflow が active なとき、動的に次を注入します。

### Core sections (毎回)
- workflow title
- current phase
- current task (+ status)
- next task (+ status)
- completion condition
- required evidence

### Conditional sections (必要時のみ)
- blocked summary
- idle warning
- references
- short rules

テンプレ方針:
- 通常 40-70 行
- 最大でも 100 行未満
- 2k tokens 未満
- 長文禁止、要約優先

### Idle detection

次の複合条件で停滞を検出します。
- running task が継続中
- 直近 3 ターンで `task/current/next/evidence` に未言及
- 15 分以上経過

発火時は:
- warning を注入
- current task を再提示
- blocked 候補を提示

### References

task ごとに次の形式を持てます。

```json
{
  "references": [
    { "type": "path", "value": "docs/design.md", "note": "設計正本" },
    { "type": "url", "value": "https://docs.example.com", "note": "外部仕様" }
  ]
}
```

- `type`: `path | url`
- `note`: 任意、120 文字以内
- plugin は宣言の正規化と `path/url + short note` 整形まで担当
- 実際の read/fetch/要約は skill / agent 側の責務

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
