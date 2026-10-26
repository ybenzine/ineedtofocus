#!/usr/bin/env bash
# The on-call respond session's only way to stage and commit its fix (#232).
#
#   scripts/oncall-commit.sh "<type>: <subject> (Refs #<incident>)" <file> [<file> ...]
#
# Run from the checkout's root, on the session's `oncall/<n>-<slug>` branch. The session
# may run this script but not `git add` or `git commit` (scripts/oncall-claude.sh): Claude
# Code's rules match the command's text, so a quoted option (`'--pathspec-from-file=…'`)
# could slip past a deny rule and make git read a file outside the checkout, such as
# /proc/self/environ, into an error message or a commit. Here the arguments are checked
# after the shell has parsed them (`scripts/oncall.py commit-check`):
# - the message: one argument, 1 to 500 characters, not starting with `-`, no control
#   character, no closing keyword, no token-shaped text;
# - the files: at least one; each a plain path (not `-…`) to a file inside the checkout,
#   resolved through symlinks, not in .git and not a path check-fix refuses; no directory.
# Then git runs with a clean environment (no caller GIT_* or secrets, no system or global
# config, literal pathspecs) and no hooks: `git add -- <files>`, `git commit -m <message>`.
set -euo pipefail

[[ $# -ge 2 ]] || { echo "usage: $0 \"<message>\" <file>..." >&2; exit 2; }
[[ -f scripts/oncall-commit.sh && -e .git ]] || { echo "run from the checkout's root" >&2; exit 2; }
message=$1
shift

clean=(env -i "PATH=$PATH" HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1
  GIT_CONFIG_GLOBAL=/dev/null GIT_LITERAL_PATHSPECS=1 GIT_TERMINAL_PROMPT=0 LC_ALL=C)
"${clean[@]}" python3 -E -s scripts/oncall.py commit-check "$message" "$@" || exit 1
git=("${clean[@]}" git -c core.hooksPath=/dev/null -c commit.gpgsign=false
  -c core.fsmonitor=false)
"${git[@]}" add -- "$@"
"${git[@]}" commit --no-verify -q -m "$message"
"${git[@]}" log -1 --format='committed %h %s'
