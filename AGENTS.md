# AGENTS.md

This file is the canonical agent instruction file for `openclaw-structured-workflow`.
`CLAUDE.md` must be a symlink to this file.

## Shared-service model

- Shared external-service skills are surfaced through `.agent/skills/` symlinks to `/home/hirakitomohiko/.codex/skills`.
- Repo-local GitHub, Linear, Slack, Sentry, and OpenClaw facts belong in `docs/service-map.md`.
- Do not duplicate shared skill bodies into the repo; keep this repo as discovery plus local facts only.

## Support docs

- `docs/agents/README.md` is the entrypoint for agent-facing references in this repo.
- `docs/agents/external-service-skills.md` is the pointer for shared service-routing skills.
