#!/usr/bin/env bash
# One headless Claude Code session of the on-call workflow (#35, .github/workflows/oncall.yml).
#
#   scripts/oncall-claude.sh oncall|reviewer <max turns> <max USD> <prompt file> <result json> \
#     [extra denied tool rule ...]
#
# Runs `claude -p` with the agent definition (.claude/agents/<agent>.md: its model and
# effort), the project's permission rules in `dontAsk` mode (anything not pre-approved is
# refused, nobody is asked), a turn cap and a dollar cap. The step that calls this sets a
# time cap. The session's token is read-only and the workflow does every write, so the
# denied rules below only stop mistakes early.
#
# First it checks that the pinned CLI knows every flag used: each takes a value, so given
# alone it fails to parse with "argument missing", before any API call. An unknown flag
# says "unknown option" instead, and the run stops here rather than mid-incident.
set -euo pipefail

[[ $# -ge 5 ]] || { echo "usage: $0 oncall|reviewer <turns> <usd> <prompt> <result> [denied ...]" >&2; exit 2; }
agent=$1 turns=$2 budget=$3 prompt=$4 result=$5
shift 5
case $agent in oncall | reviewer) ;; *) echo "unknown agent: $agent" >&2; exit 2 ;; esac
[[ $turns =~ ^[1-9][0-9]?$ && $budget =~ ^[1-9][0-9]?$ ]] || { echo "bad caps" >&2; exit 2; }
[[ -s $prompt ]] || { echo "no prompt at $prompt" >&2; exit 2; }

FLAGS=(--agent --permission-mode --max-turns --max-budget-usd --output-format --add-dir --disallowedTools)
for flag in "${FLAGS[@]}"; do
  said=$(claude -p "$flag" < /dev/null 2>&1 || true)
  [[ $said == *"argument missing"* ]] || {
    echo "::error title=Claude Code flag::the pinned CLI doesn't take $flag: $said"
    exit 1
  }
done

DENIED=(
  'Bash(gh workflow *)' 'Bash(gh run rerun *)' 'Bash(gh run cancel *)'
  'Bash(git push *)' 'Bash(gh pr create *)' 'Bash(gh pr merge *)' 'Bash(gh pr review *)'
  'Bash(gh pr comment *)' 'Bash(gh issue create *)' 'Bash(gh issue comment *)'
  'Bash(gh issue edit *)' 'Bash(gh issue close *)' 'Bash(gh api * -X *)'
  'Bash(gh api * --method *)' 'Bash(scripts/reviewer-review.sh *)'
)

# The Bash tool's default timeout is 2 minutes; a test run can take longer. The waits on
# alert states happen in workflow steps, not in a session.
export BASH_DEFAULT_TIMEOUT_MS=600000 BASH_MAX_TIMEOUT_MS=900000
mkdir -p /tmp/oncall
claude -p --agent "$agent" --permission-mode dontAsk \
  --max-turns "$turns" --max-budget-usd "$budget" --output-format json \
  --add-dir /tmp/oncall \
  --disallowedTools "${DENIED[@]}" "$@" \
  < "$prompt" > "$result"
