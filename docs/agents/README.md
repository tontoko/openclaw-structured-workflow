# Agent References

This repo uses the shared Codex skill library at `~/.codex/skills` for external-service operations.

## Pointer map

- `@external-service-ops` → shared skill `external-service-ops`
- `@linear-demand-routing` → shared skill `linear-demand-routing`
- `@sentry-signal-routing` → shared skill `sentry-signal-routing`
- `@openclaw-chatops-routing` → shared skill `openclaw-chatops-routing`
- `@github-review-automation` → shared skill `github-review-automation`

## When to use

- use `external-service-ops` for shared operating-model questions across Polku and OpenClaw
- use `linear-demand-routing` for demand decomposition and GitHub linkage
- use `sentry-signal-routing` for alert routing and incident intake
- use `openclaw-chatops-routing` for founder-facing ChatOps and routing changes
- use `github-review-automation` for PR review automation and comment handling
