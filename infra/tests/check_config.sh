#!/usr/bin/env bash
# Validate the production configs without starting anything (#27). `make test-infra`;
# needs Docker (it runs the pinned Caddy and Collector images to validate their configs).
#
#   1. infra/compose.edge.yml and infra/compose.prod.yml render for prod and dev
#      (`docker compose config`) with dummy secrets, and refuse to render without
#      APP_TAG or POSTGRES_PASSWORD;
#   2. the collector picks export.yaml without Grafana Cloud settings and
#      export.grafana-cloud.yaml with them, and `otelcol validate` accepts both;
#   3. `caddy validate` accepts infra/caddy/Caddyfile and `caddy fmt` finds nothing to change;
#   4. scripts/check_prod_compose.py checks the rendered result against the deploy rules
#      (memory budget, dev below prod, ports, proxy trust, routing, cookie, migrations,
#      pinned images, and the process, privilege and disk limits of #117).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
infra=$(dirname "$here")
repo=$(dirname "$infra")
# shellcheck source=/dev/null # exit_guard.sh: exit_guard, harness_done (#183)
. "$here/exit_guard.sh"
work=$(mktemp -d)
cleanup() {
  local status=$?
  exit_guard "$status" || status=$?
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

tag=0123456789abcdef0123456789abcdef01234567
# Render with this tag only: an APP_TAG from the caller (CI sets one for the job) would
# defeat the "refuses to render without APP_TAG" check.
unset APP_TAG
fail() {
  echo "FAIL  $*" >&2
  exit 1
}
ok() { echo "ok    $*"; }

# Dummy secrets files, shaped like /opt/focus/<env>/.env. Not real values.
printf 'POSTGRES_PASSWORD=not-a-real-password\n' > "$work/plain.env"
cat > "$work/grafana.env" <<'VARS'
POSTGRES_PASSWORD=not-a-real-password
GRAFANA_CLOUD_OTLP_ENDPOINT=https://otlp-gateway.example.invalid/otlp
GRAFANA_CLOUD_INSTANCE_ID=123456
GRAFANA_CLOUD_OTLP_TOKEN=not-a-real-token
VARS

render() { # <env> <secrets file> [compose config args...]
  local env_name=$1 secrets=$2
  shift 2
  APP_TAG=$tag FOCUS_SECRETS_FILE=$secrets "$infra/compose.sh" "$env_name" config "$@"
}

# --- 1. Compose ---------------------------------------------------------------
docker compose -f "$infra/compose.edge.yml" config --format json > "$work/edge.json"
ok "compose.edge.yml renders"
for env_name in prod dev; do
  render "$env_name" "$work/plain.env" --format json > "$work/$env_name.json"
  ok "compose.prod.yml renders as $env_name"
done

if FOCUS_SECRETS_FILE=$work/plain.env "$infra/compose.sh" prod config -q 2> "$work/err"; then
  fail "compose.prod.yml rendered without APP_TAG"
fi
grep -q 'APP_TAG' "$work/err" || fail "missing APP_TAG: unexpected error: $(cat "$work/err")"
ok "refuses to render without APP_TAG"

: > "$work/empty.env"
if APP_TAG=$tag FOCUS_SECRETS_FILE=$work/empty.env "$infra/compose.sh" prod config -q 2> "$work/err"; then
  fail "compose.prod.yml rendered without POSTGRES_PASSWORD"
fi
grep -q 'POSTGRES_PASSWORD' "$work/err" || fail "missing POSTGRES_PASSWORD: unexpected error: $(cat "$work/err")"
ok "refuses to render without POSTGRES_PASSWORD"

# --- 2. Collector ------------------------------------------------------------
otelcol_image=$(render prod "$work/plain.env" --images | grep opentelemetry-collector)
collector_config() { # <secrets file> -> the second --config file the collector gets
  render prod "$1" --format json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["otel-collector"]["command"][1])'
}
[[ $(collector_config "$work/plain.env") == --config=/etc/otelcol/export.yaml ]] ||
  fail "without Grafana Cloud settings the collector should use export.yaml"
[[ $(collector_config "$work/grafana.env") == --config=/etc/otelcol/export.grafana-cloud.yaml ]] ||
  fail "with Grafana Cloud settings the collector should use export.grafana-cloud.yaml"
ok "collector picks its exporters from GRAFANA_CLOUD_OTLP_ENDPOINT"

for exporters in export.yaml export.grafana-cloud.yaml; do
  docker run --rm --pull missing \
    -v "$infra/otel-collector:/etc/otelcol:ro" \
    -e FOCUS_ENV=prod \
    -e GRAFANA_CLOUD_OTLP_ENDPOINT=https://otlp-gateway.example.invalid/otlp \
    -e GRAFANA_CLOUD_INSTANCE_ID=123456 \
    -e GRAFANA_CLOUD_OTLP_TOKEN=not-a-real-token \
    "$otelcol_image" validate --config=/etc/otelcol/config.yaml "--config=/etc/otelcol/$exporters"
  ok "otelcol validate: config.yaml + $exporters"
done

# --- 3. Caddy -----------------------------------------------------------------
caddy_image=$(docker compose -f "$infra/compose.edge.yml" config --images | grep caddy)
caddy() {
  docker run --rm --pull missing -v "$infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
    "$caddy_image" caddy "$@"
}
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > "$work/caddy-validate.log" 2>&1 ||
  fail "caddy validate: $(cat "$work/caddy-validate.log")"
ok "caddy validate"
caddy fmt /etc/caddy/Caddyfile > /dev/null || fail "infra/caddy/Caddyfile isn't formatted (caddy fmt --overwrite)"
ok "caddy fmt"
caddy adapt --config /etc/caddy/Caddyfile 2> /dev/null > "$work/caddy.json"
ok "caddy adapt"

# --- 4. Deploy rules ----------------------------------------------------------
python3 "$repo/scripts/check_prod_compose.py" \
  --edge "$work/edge.json" --prod "$work/prod.json" --dev "$work/dev.json" \
  --caddy "$work/caddy.json" --tag "$tag"
harness_done
