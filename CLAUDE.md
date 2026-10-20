# CLAUDE.md

Claude Code reads this file automatically. The project's agent instructions live in AGENTS.md so every coding agent shares one source:

@AGENTS.md

## Claude Code specifics

- The agent team is defined in `.claude/agents/` (product-manager, backend, frontend, qa, devops, reviewer, oncall). Delegate an issue to the subagent matching its `agent:*` label (`agent:product_manager` → `product-manager`); run the `reviewer` subagent on every PR before merge and the `product-manager` subagent for final acceptance.
- `/work-issue <n>` runs the whole loop for one issue: delegate → PR → review → merge → QA → acceptance. `/work-backlog [milestone]` runs it over the whole backlog, stopping only at human gates.
- Use `gh` for tracker work (comments, PRs, reviews) and `scripts/board-status.sh <n> "<Status>"` to move cards on the board.
