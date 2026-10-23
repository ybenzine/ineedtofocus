#!/usr/bin/env bash
# Run Docker Compose for one deployed environment (#27) with the right files:
#
#   APP_TAG=<commit sha> infra/compose.sh prod|dev <compose args...>
#
#   APP_TAG=3f2a... infra/compose.sh dev pull app
#   APP_TAG=3f2a... infra/compose.sh dev run --rm app alembic upgrade head
#   APP_TAG=3f2a... infra/compose.sh dev up -d --wait
#
# It runs `docker compose -f infra/compose.prod.yml --env-file <secrets> --env-file
# infra/env/<env>.env`. The committed settings file comes last so its sizing and network
# values win over the server's secrets file. Compose fails if APP_TAG,
# POSTGRES_PASSWORD or a committed setting is missing.
#
# The secrets file is /opt/focus/<env>/.env (server layout, #25). FOCUS_SECRETS_FILE
# points elsewhere, and FOCUS_COMPOSE_PROJECT overrides the project name (focus-<env>);
# the tests use both so they never touch a real environment.
#
# The deploy and rollback scripts (#28-#30) are meant to call this.
set -euo pipefail

usage() {
  echo "usage: APP_TAG=<sha> $0 prod|dev <docker compose args...>" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
env_name=$1
shift
case "$env_name" in
  prod | dev) ;;
  *) usage ;;
esac

infra_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
secrets_file=${FOCUS_SECRETS_FILE:-/opt/focus/$env_name/.env}
settings_file=$infra_dir/env/$env_name.env

if [[ ! -r $secrets_file ]]; then
  echo "$0: can't read the secrets file $secrets_file (see _docs/deployment.md)" >&2
  exit 1
fi

args=(-f "$infra_dir/compose.prod.yml" --env-file "$secrets_file" --env-file "$settings_file")
if [[ -n ${FOCUS_COMPOSE_PROJECT:-} ]]; then
  args+=(-p "$FOCUS_COMPOSE_PROJECT")
fi

exec docker compose "${args[@]}" "$@"
