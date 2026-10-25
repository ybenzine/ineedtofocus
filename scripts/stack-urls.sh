#!/usr/bin/env bash
# The URLs of this checkout's local stack (compose.yaml), from the host ports Compose actually
# published. Each git worktree runs its own stack under its own COMPOSE_PROJECT_NAME and ports
# (.env, #83), so this reports and tests that worktree's stack, never another checkout's.
#
#   scripts/stack-urls.sh       the Compose project and each service's URL (`make up` prints it)
#   scripts/stack-urls.sh app   this checkout's app URL: the published port while its stack
#                               runs, otherwise APP_PORT from the environment or .env (default
#                               8000). The e2e targets use it as PLAYWRIGHT_BASE_URL's default.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The host port Compose published for <service> <container port>, or nothing.
published_port() {
  local address
  address=$(docker compose port "$1" "$2" 2>/dev/null) || return 0
  if [[ $address =~ :([0-9]+)$ && ${BASH_REMATCH[1]} != 0 ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  fi
}

# APP_PORT as Compose resolves it: the environment wins over .env, then the default.
configured_app_port() {
  local port=${APP_PORT-}
  if [[ -z $port && -f .env ]]; then
    port=$(sed -n 's/^[[:space:]]*APP_PORT[[:space:]]*=[[:space:]]*//p' .env | tail -n 1)
    port=${port%%[[:space:]#]*}
    port=${port//\"/}
    port=${port//\'/}
  fi
  printf '%s\n' "${port:-8000}"
}

line() {  # <label> <service> <container port> <scheme>
  local port
  port=$(published_port "$2" "$3")
  if [[ -n $port ]]; then
    printf '%-9s %slocalhost:%s\n' "$1:" "$4" "$port"
  else
    printf '%-9s not running\n' "$1:"
  fi
}

case "${1:-all}" in
  app)
    port=$(published_port app 8000)
    printf 'http://localhost:%s\n' "${port:-$(configured_app_port)}"
    ;;
  all)
    project=$(docker compose config 2>/dev/null | sed -n 's/^name: //p' | head -n 1)
    printf '%-9s %s\n' "Project:" "${project:-unknown}"
    line App app 8000 http://
    line Grafana lgtm 3000 http://
    line OTLP lgtm 4318 http://
    line Postgres db 5432 ""
    ;;
  *)
    echo "usage: scripts/stack-urls.sh [app]" >&2
    exit 2
    ;;
esac
