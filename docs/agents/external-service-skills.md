# External Service Skills

Use these shared Codex skills when the workflow touches GitHub, Linear, Sentry, Slack, or OpenClaw routing.
Repo-local IDs and routing facts stay in [`docs/service-map.md`](../service-map.md); the skills themselves are surfaced through `.agent/skills/` symlinks.

## Shared skills

- `external-service-ops`: shared operating model for cross-repo service work
- `linear-demand-routing`: Linear issue/project decomposition and GitHub linkage
- `sentry-signal-routing`: Sentry signal routing and triage
- `openclaw-chatops-routing`: OpenClaw ChatOps and channel routing
- `github-review-automation`: automated GitHub PR review behavior

## Notes

- Keep the repo-local docs as pointers only.
- Do not duplicate the operating model here; reuse the shared skill docs instead.
