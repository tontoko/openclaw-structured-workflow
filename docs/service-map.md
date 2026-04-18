# Service Map

Repo-local facts for shared external-service skills live here. Shared skills should read this file before using any repo-specific IDs, slugs, or routing targets.

## Ownership

- Repository: `openclaw-structured-workflow`
- Repo-local discovery: `.agent/skills`
- Shared skill source: `/home/hirakitomohiko/.codex/skills`

## GitHub

- Execution repo: `tontoko/openclaw-structured-workflow`
- Review automation scope: GitHub PRs and review threads for this repository
- Review automation routing: use the shared `github-review-automation` skill; this repo does not define repo-local workflow or channel overrides in its docs

## Linear

- Workspace/team mapping: not recorded in this repo-local doc set yet
- Demand linkage rule: use the shared `linear-demand-routing` skill and record the actual workspace/team IDs here once this repo is wired into a live Linear lane
- Demand routing rule: only adopted demand leaves the GitHub/OpenClaw routing surface

## Slack

- Founder / ops hub: not recorded in this repo-local doc set yet
- PR visibility channel: not recorded in this repo-local doc set yet
- Incident route: not recorded in this repo-local doc set yet
- Chat transport rule: Slack remains the live transport surface, but this repo does not yet capture distinct repo-local channel IDs

## Sentry

- Org/project mapping: not recorded in this repo-local doc set yet
- Provisioning note: use the shared `sentry-signal-routing` skill; record the real org/project mapping here once Sentry is provisioned for this repo
- Signal routing rule: use Sentry for signal intake, not as a demand tracker

## OpenClaw

- ChatOps hub: enabled
- Routing role: founder-facing routing and visibility, not source of truth
- ChatOps routing: use the shared `openclaw-chatops-routing` skill; no repo-local channel override is recorded here yet
- Canonical references: `docs/agents/README.md` and `docs/agents/external-service-skills.md`
