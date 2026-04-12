# Structured Workflow Plugin for OpenClaw

TaskFlow 前提の薄い workflow layer です。core の tasklist capabilities は維持しつつ、active workflow のときだけ短く決定的な phase banner を注入します。

vNext では次を重視しています。

- core tasklist capabilities の維持
- cache-safe な active-workflow phase injection
- owner-scoped workflow lookup
- reminder / internal runtime context での invalid-state amplification 回避
- dead だった `forceContinuation` の整理

## Responsibility

この plugin が持つ責務:

- `tasklist_create` / `tasklist_update` / `tasklist_status` / `tasklist_permission`
- active workflow 中の short phase banner 注入
- complex instruction に対する workflow bootstrap 提案
- TaskFlow durable state の owner-scoped な利用

この plugin が持たない責務:

- forced continuation の実現
- standalone state store
- 独自 compaction / context pruning
- approval policy 本体
- 他 agent orchestration 本体

## Installation

```bash
openclaw plugins install ~/openclaw-structured-workflow
openclaw gateway restart
```

### Required OpenClaw Config

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

## Plugin Config

```json
{
  "plugins": {
    "entries": {
      "structured-workflow": {
        "enabled": true,
        "config": {
          "permissionMode": "bypass",
          "flowDetectionMode": "auto",
          "activationKeywords": ["ultrawork", "ulw", "task-driven"]
        }
      }
    }
  }
}
```

### Config notes

- `permissionMode`: task 実行時の permission mode
- `flowDetectionMode`: `auto` なら複雑指示検知 + activation keyword、`keyword-only` なら activation keyword のみ
- `activationKeywords`: workflow bootstrap を強制したいキーワード
- `forceContinuation`: **deprecated / ignored**。互換性のため受け付けるだけで、vNext では挙動に影響しません
- `cancelKeywords`: **deprecated / ignored**。旧版設定との互換性のためだけに受け付けます

## Tools

### `tasklist_create`

複雑な作業を structured task list として開始します。

```json
{
  "title": "Implement Feature X",
  "tasks": [
    { "id": "investigate", "title": "要件調査", "decisionPolicy": "auto" },
    { "id": "design", "title": "設計", "decisionPolicy": "deliberate" },
    { "id": "implement", "title": "実装", "decisionPolicy": "auto" },
    { "id": "verify", "title": "動作確認", "decisionPolicy": "auto" }
  ]
}
```

### `tasklist_update`

owner-scoped な active workflow の task 状態を更新します。

```json
{
  "taskId": "implement",
  "status": "running",
  "assignedAgent": "worker-coder",
  "sessionKey": "agent:worker-coder:subagent:abc123"
}
```

valid statuses:

- `running`
- `completed`
- `skipped`
- `blocked`

### `tasklist_status`

この session に紐づく最新の structured workflow を表示します。active workflow があればそれを優先し、なければ最新の terminal workflow を返します。

```json
{}
```

### `tasklist_permission`

permission mode を切り替えます。

```json
{ "mode": "allow-after-first" }
```

valid modes:

- `bypass`
- `allow-after-first`
- `confirm-each`

## Active Workflow Injection

active workflow があるとき、plugin は `before_prompt_build` で短い phase banner を注入します。

注入される内容:

- workflow title
- phase (`plan` / `execute` / `verify` / `fix`)
- current task
- next task
- blocked summary
- current task references
- short rules

重要なのは、**毎 turn でなんでも注入しない**ことです。次の volatile turn では注入をスキップします。

- `System: [...]` で始まる reminder
- `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>`
- `[Queued messages while agent was busy]`
- `Conversation info (untrusted metadata):`
- async exec completion notice
- heartbeat / tasklist reminder 系

この制限により、active workflow guidance を維持しながら prefix churn を抑えます。

## Bootstrap Detection

active workflow が無い場合だけ、complex instruction に対して `tasklist_create` を促します。

- `flowDetectionMode: "auto"`  
  複雑指示検知と activation keyword のどちらでも発火
- `flowDetectionMode: "keyword-only"`  
  activation keyword のみで発火

activation keyword の既定値:

- `ultrawork`
- `ulw`
- `task-driven`

## Development

```bash
npm install
npx ultracite fix src/index.ts README.md docs/DESIGN.md openclaw.plugin.json package.json
npx tsc --noEmit
openclaw plugins install ~/openclaw-structured-workflow
openclaw gateway restart
```

## License

MIT
