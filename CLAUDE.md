# CLAUDE.md

Claude Code reads this file automatically. The project's agent instructions live in AGENTS.md so every coding agent shares one source:

@AGENTS.md

## Claude Code specifics

- The agent team is defined in `.claude/agents/` (product-manager, backend, frontend, qa, devops, reviewer, oncall). Delegate an issue to the subagent matching its `agent:*` label (`agent:product_manager` → `product-manager`); run the `reviewer` subagent on every PR before merge and the `product-manager` subagent for final acceptance.
- `/work-issue <n>` runs the whole loop for one issue: delegate → PR → review → merge → QA → acceptance. `/work-backlog [milestone]` runs it over the whole backlog, stopping only at human gates.
- Use `gh` for tracker work (comments, PRs, reviews) and `scripts/board-status.sh <n> "<Status>"` to move cards on the board.

## Permissions for unattended runs

`.claude/settings.json` pre-approves routine work (git, `gh`, `make`, Docker Compose, Node/Python toolchains, repo scripts, file edits in the repo) and denies what sits behind the human gates in `_docs/process.md`: force-push, pushing to `main`, `rm -r`, deleting repos/issues/releases, `gh api` DELETE calls, secrets, the prod deploy workflow (`deploy-prod`, named in #29), and reading `.env` files. Remote and destructive commands (`ssh`, `git reset --hard`, removing Docker volumes, any `gh workflow run`) ask first. Personal overrides go in the git-ignored `.claude/settings.local.json`.

These rules match command text, so they guard against mistakes, not against a determined workaround. The server-side backstops are branch protection on `main` (#5) and prod credentials living only in the approval-gated `production` environment.
