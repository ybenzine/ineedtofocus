#!/usr/bin/env bash
# One headless Claude Code session of the on-call workflow (#35, .github/workflows/oncall.yml).
#
#   scripts/oncall-claude.sh respond|review|follow-up <max turns> <max USD> <prompt file> \
#     <result json>
#
# Run from the checkout's root. Runs `claude -p` with the session's agent, a turn cap and a
# dollar cap, in `dontAsk` mode: anything not allowed below is refused, nobody is asked.
# The step that calls this sets a time cap. The session's token is read-only and the
# workflow does every write, so these rules stop mistakes early; the workflow's checks are
# the guard.
#
# The agent: respond and follow-up run .claude/agents/oncall.md. The review runs
# `oncall-reviewer`, built by `scripts/oncall.py reviewer-agent` from
# .claude/agents/reviewer.md plus Write, so it can leave its review files; the reviewer
# people run stays read-only.
#
# Each session's permissions are its own allow list below, on the command line (#232).
# They don't come from .claude/settings.json: on a fresh runner the workspace isn't
# trusted, so Claude Code ignores that file's allow rules (and prints "Ignoring … this
# workspace has not been trusted"), and they're too broad for a session that reads
# untrusted text anyway. Its deny rules still apply. Plain read-only commands (`ls`,
# `grep`, `find`, `git log|show|diff`) in the checkout and $ONCALL_OUT are allowed by
# Claude Code itself. Bash writes (a redirect, say) only where the Edit rules allow, so to
# the session's own output files. Not allowed: Read outside the checkout and $ONCALL_OUT,
# `$(…)`, secret variables, environment prefixes (`GRAFANA_URL=… python3 …`). The respond
# session stages and commits only through scripts/oncall-commit.sh, which checks its
# arguments after the shell has parsed them; `git add` and `git commit` themselves are
# refused. The rules match a command's text, so a deny rule is a second, best-effort layer:
# a quoted option can get past one. That's why nothing here allows a command whose options
# could read a file outside the checkout. scripts/tests/test_oncall_cli.py runs the pinned
# CLI against a fake API to check what each session can and can't do.
#
# First it checks that the pinned CLI knows every flag used: each takes a value, so given
# alone it fails to parse with "argument missing", before any API call. An unknown flag
# says "unknown option" instead, and the run stops here rather than mid-incident.
set -euo pipefail

[[ $# -eq 5 ]] || { echo "usage: $0 respond|review|follow-up <turns> <usd> <prompt> <result>" >&2; exit 2; }
session=$1 turns=$2 budget=$3 prompt=$4 result=$5
case $session in
  respond | follow-up) agent=oncall ;;
  review) agent=reviewer ;;
  *) echo "unknown session: $session" >&2; exit 2 ;;
esac
[[ $turns =~ ^[1-9][0-9]?$ && $budget =~ ^[1-9][0-9]?$ ]] || { echo "bad caps" >&2; exit 2; }
[[ -s $prompt ]] || { echo "no prompt at $prompt" >&2; exit 2; }
[[ -f .claude/agents/$agent.md ]] || { echo "run from the checkout's root" >&2; exit 2; }
# The commands a session runs get no secret-named variable (#266): the workflow's session
# steps set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1, so code a session wrote and ran with
# `make test-*` can't read the Claude key. Without it, no session starts. With it, the CLI
# prints "Permission mode forced to default": in -p mode that refuses whatever the allow
# list doesn't cover, like dontAsk (test_oncall_cli.py checks it on the pinned CLI). On
# Linux it also runs each command in bubblewrap, which scripts/oncall-sandbox.sh installs.
[[ ${CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:-} == 1 ]] || {
  echo "::error title=No env scrub::an on-call session needs CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 (#266)"
  exit 2
}
# The definition's effort: in -p mode Claude Code doesn't apply an agent's `effort:` (it
# sends medium), so it's passed as a flag. Its `model:` does apply (#232, tested).
effort=$(sed -n 's/^effort: *//p' ".claude/agents/$agent.md" | head -n 1)
[[ $effort =~ ^(low|medium|high|xhigh|max)$ ]] || { echo "no effort in $agent.md" >&2; exit 2; }

FLAGS=(--agent --agents --effort --tools --permission-mode --max-turns --max-budget-usd
  --output-format --add-dir --allowedTools --disallowedTools)
for flag in "${FLAGS[@]}"; do
  said=$(claude -p "$flag" < /dev/null 2>&1 || true)
  [[ $said == *"argument missing"* ]] || {
    echo "::error title=Claude Code flag::the pinned CLI doesn't take $flag: $said"
    exit 1
  }
done

# The files a session leaves for the workflow. Absolute rules (`//path`) on the real path:
# the rules match the resolved path.
mkdir -p "${ONCALL_OUT:=/tmp/oncall}"
out=$(cd "$ONCALL_OUT" && pwd -P)

AGENT=(--agent "$agent")
GH_READ=('Bash(gh issue view *)' 'Bash(gh pr view *)' 'Bash(gh pr diff *)' 'Bash(gh pr checks *)')
GRAFANA=('Bash(python3 scripts/oncall_grafana.py *)')
case $session in
  respond)
    TOOLS=Read,Write,Edit,Bash
    ALLOWED=(
      "${GH_READ[@]}" "${GRAFANA[@]}" 'Bash(gh issue list *)' 'Bash(gh pr list *)'
      'Bash(gh run view *)' 'Bash(gh run list *)'
      # The prompt's key check (#266): prints only `absent` or `present`, never the value.
      'Bash(scripts/oncall-key-check.sh)'
      "Edit(/$out/decision.json)" "Edit(/$out/comment.md)" "Edit(/$out/pr.md)"
      # A fix: its branch, its commits (scripts/oncall-commit.sh only), the tests and
      # linters that cover it, and the code.
      'Bash(git switch -c oncall/*)' 'Bash(scripts/oncall-commit.sh *)'
      'Bash(make test-backend-unit)' 'Bash(make test-scripts)' 'Bash(make test-frontend)'
      'Bash(make lint-backend)' 'Bash(make lint-scripts)' 'Bash(make lint-frontend)'
      'Edit(./backend/**)' 'Edit(./frontend/**)' 'Edit(./scripts/**)' 'Edit(./infra/**)'
      'Edit(./_docs/**)'
    )
    DENIED=(
      # Not allowed anyway; denied too, as a second layer.
      'Bash(git add*)' 'Bash(git commit*)'
      # What scripts/oncall.py's check-fix refuses (PROTECTED_PATHS), refused here first.
      'Edit(./infra/github/**)' 'Edit(./scripts/oncall*)' 'Edit(./scripts/oncall*/**)'
      'Edit(./scripts/alert_dispatch.py)' 'Edit(./scripts/alert_routing.py)'
      'Edit(./scripts/check_local_stack.py)' 'Edit(./scripts/grafana_alerts.py)'
      'Edit(./scripts/grafana_dashboards.py)' 'Edit(./scripts/reviewer*)'
      'Edit(./scripts/oncall-commit.sh)' 'Edit(./scripts/tests/test_oncall*)' 'Edit(./scripts/tests/oncall_sim.py)'
      'Edit(./scripts/tests/test_claude_settings.py)'
    )
    ;;
  follow-up)
    TOOLS=Read,Write,Bash
    ALLOWED=("${GH_READ[@]}" "${GRAFANA[@]}" 'Bash(gh run view *)' 'Bash(gh run list *)'
      "Edit(/$out/comment.md)")
    DENIED=()
    ;;
  review)
    AGENT=(--agents "$(python3 scripts/oncall.py reviewer-agent)" --agent oncall-reviewer)
    TOOLS=Read,Write,Bash
    ALLOWED=("${GH_READ[@]}" "Edit(/$out/review.md)" "Edit(/$out/review.json)")
    # The review reads the diff and CI's results; it doesn't run the PR's code.
    DENIED=('Bash(gh pr checkout *)' 'Bash(git checkout *)' 'Bash(git switch *)' 'Bash(make *)')
    ;;
esac
DENIED+=(
  'Bash(gh workflow *)' 'Bash(gh run rerun *)' 'Bash(gh run cancel *)' 'Bash(gh run watch *)'
  'Bash(git push *)' 'Bash(gh pr create *)' 'Bash(gh pr merge *)' 'Bash(gh pr review *)'
  'Bash(gh pr comment *)' 'Bash(gh issue create *)' 'Bash(gh issue comment *)'
  'Bash(gh issue edit *)' 'Bash(gh issue close *)' 'Bash(gh api *)'
  'Bash(scripts/reviewer-review.sh *)' 'Bash(python3 scripts/oncall_grafana.py wait *)'
  'Edit(./.github/**)' 'Edit(./.claude/**)'
)

echo "::notice title=Session permissions::$session: tools $TOOLS, ${#ALLOWED[@]} allow and ${#DENIED[@]} deny rules from scripts/oncall-claude.sh. Claude Code ignores the allow rules in .claude/settings.json here (the workspace isn't trusted), as intended."

# The Bash tool's default timeout is 2 minutes; a test run can take longer. The waits on
# alert states happen in workflow steps, not in a session.
export BASH_DEFAULT_TIMEOUT_MS=600000 BASH_MAX_TIMEOUT_MS=900000
# --add-dir and the rule lists take several values: each list ends at the next flag, and
# the prompt comes on stdin.
claude -p "${AGENT[@]}" --effort "$effort" --tools "$TOOLS" --permission-mode dontAsk \
  --max-turns "$turns" --max-budget-usd "$budget" --output-format json \
  --add-dir "$out" \
  --allowedTools "${ALLOWED[@]}" \
  --disallowedTools "${DENIED[@]}" \
  < "$prompt" > "$result"
