# Design: Structured Workflow Plugin v0.4.0

## Responsibility

TaskFlow 前提の薄い behavior layer。

### やる
- tasklist tools (create/update/status/permission)
- phase 注入 (plan→exec→verify→fix)
- current/next/completion condition 注入
- evidence 要求
- idle 検知 (停滞検出 + hook 発火まで)
- reference 統合 (宣言正規化 + path/url + short note 整形)

### やらない
- standalone fallback / 独自 state store
- 独自永続化
- audit log
- IntentGate / safety policy
- 承認・権限ポリシー本体
- 他 agent orchestration 本体

## 3-Layer Separation

```
┌─────────────────────────────────────┐
│  OpenClaw                           │
│  実行基盤: session/tool/runtime/権限  │
│  /安全/配信/監査                     │
├─────────────────────────────────────┤
│  TaskFlow                           │
│  durable state machine: flow ID,    │
│  revision, wait/resume, child-link, │
│  state 永続                         │
├─────────────────────────────────────┤
│  structured-workflow plugin         │
│  薄い behavior layer: phase 注入,   │
│  current/next/completion, evidence, │
│  idle hook, reference 統合           │
└─────────────────────────────────────┘
```

### 境界破壊の例 (やってはいけないこと)
- OpenClaw が phase 分岐を持つ
- TaskFlow が承認判定ポリシーを持つ
- plugin が DB 永続化や独自 state store を持つ

## Tools

4 tools (変更なし):
- `tasklist_create`: task list 作成
- `tasklist_update`: status 更新
- `tasklist_status`: 現在状態表示
- `tasklist_permission`: permission mode 切替

## Hook: before_prompt_build

### 注入テンプレ構造

```
🔴 WORKFLOW ACTIVE — [title]
Phase: [current_phase]

▸ Current: [id]. [title] ([status])
  [description (1-2行)]
▸ Next: [id]. [title] ([status])

Completion:
  - [condition_1]
  - [condition_2]

Evidence required:
  - [evidence_description]

[IF blocked tasks exist]
🚫 Blocked:
  - [id]. [title]: [blockedReason]
[END]

[IF idle detected]
⚠️ IDLE: No progress on task/evidence in 3 turns / 15 min.
  → Resume current task or resolve blockers.
[END]

[IF references exist]
📎 References:
  - [path|url] [value] — [note (≤120 chars)]
[END]

Rules:
- Complete all tasks before declaring workflow done.
- Provide evidence for completed tasks.
- If blocked, explain why and what's needed.
```

### Idle Detection

複合条件 (全て満たしたら発火):
1. running task が存在
2. 直近 3 ターンの assistant 応答に `task/current/next/evidence` のいずれも未言及
3. 15 分以上経過

発火時の挙動:
- warning 注入
- current task 再提示
- blocked 候補提示
- verify 送りはしない

### References

task ごとに optional:
```ts
references?: Array<{
  type: "path" | "url";
  value: string;
  note?: string; // max 120 chars
}>
```

- plugin は宣言の正規化 + `path/url — short note` 整形まで
- 実際の read/fetch/要約は skill/agent 側の責務

## Storage

TaskFlow runtime のみ使用。standalone fallback は v0.4.0 で削除。

## Configuration

```json
{
  "permissionMode": "bypass" | "allow-after-first" | "confirm-each",
  "forceContinuation": true,
  "cancelKeywords": ["/stop", "キャンセル", "cancel", "stop"]
}
```

## 他プラグインからの採用

### 採用
- ClaudeCode 系の phase 構造 (plan→exec→verify→fix)
- Claude Code 公式の hook/event 駆動
- AWS Amplify 系の reference 統合
- Todo Enforcer 系の idle 検知

### 条件付き採用
- deep-interview→plan: 常時ではなく曖昧/高リスク時のみ

### 不採用
- ULW 200+行の巨大注入
- Ralph Loop
- IntentGate
- audit log
- 独自 persistent memory / 自律改善

## Key Learnings (v0.1.0〜v0.3.0)

1. **TaskFlow fromToolContext throws**: `ctx.sessionKey` が必要。try-catch 必須。
2. **Plugin tools need alsoAllow**: `tools.profile: "coding"` は plugin tools を含まない。
3. **@sinclair/typebox**: dependencies に必須 (runtime path resolution の問題)。
4. **責務が広がりやすい**: plugin に state store / audit / safety を混ぜると境界破壊。
5. **standalone fallback は負債**: TaskFlow 前提に割り切る方が健全。
