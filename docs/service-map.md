# Service Map

Repo-local facts for shared external-service skills live here. Shared skills should read this file before using any repo-specific IDs, slugs, or routing targets.

## Ownership

- Repository: `openclaw-structured-workflow`
- Repo-local discovery: `.agent/skills`
- Shared skill source: `/home/hirakitomohiko/.codex/skills`

## GitHub

- Execution repo: `polku-learning/openclaw-structured-workflow`
- Review automation scope: GitHub PRs and review threads for this repository

## Linear

- Workspace/team mapping: fill in the repo-local workspace and team identifiers here
- Demand routing rule: only adopted demand leaves the GitHub/OpenClaw routing surface

## Slack

- Founder / ops hub: fill in the repo-local channel IDs here
- PR visibility channel: fill in the repo-local channel ID here
- Incident route: fill in the repo-local channel ID here

## Sentry

- Org/project mapping: fill in the repo-local org and project here
- Signal routing rule: use Sentry for signal intake, not as a demand tracker

## OpenClaw

- ChatOps hub: enabled
- Routing role: founder-facing routing and visibility, not source of truth
- Canonical references: `docs/agents/README.md` and `docs/agents/external-service-skills.md`
