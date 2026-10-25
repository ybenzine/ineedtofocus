#!/usr/bin/env bash
# Stops a stack target in a subagent worktree that has no .env (#188).
#
# A subagent started with worktree isolation works in <main checkout>/.claude/worktrees/<name>/,
# and git-ignored files such as .env don't come along. Without one, Compose there uses
# compose.yaml's defaults: project focus-local on ports 8000, 3000, 4317/4318 and 5432, which
# is the main checkout's stack. `make up` would replace it with the subagent's code, `make down`
# would stop it, and the e2e targets and `make check-stack` would test it as if it were this
# worktree's (_docs/process.md, Parallel sessions, Subagent worktrees).
#
#   scripts/require-worktree-env.sh "<target>"   exit 0 when this checkout's path has no
#                                                /.claude/worktrees/ in it (main checkout,
#                                                session worktree, CI) or it has a .env;
#                                                otherwise say what to do on stderr, exit 1
#
# Only the checkout's path and its .env decide, never CI or other variables. CI checks out to
# /home/runner/work/<repo>/<repo>, outside .claude/worktrees/, so the guard never fires there.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
target=${1:-This target}

if [[ $root/ != */.claude/worktrees/* || -f $root/.env ]]; then
  exit 0
fi

cat >&2 <<EOF
$target stopped: this checkout is a subagent worktree with no .env.
  $root
Without one, Compose here uses the defaults (project focus-local, app on port 8000): that is
the main checkout's stack, so this would replace, stop or test that stack instead of its own.
Copy your session's .env first (the lead names the session folder when it delegates):
  cp <session folder>/.env .env
See _docs/process.md → Parallel sessions → Subagent worktrees.
EOF
exit 1
