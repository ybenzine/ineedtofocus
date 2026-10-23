#!/usr/bin/env bash
# Smoke-test the production stack on this machine (#27): `make test-prod-stack`.
# Needs Docker; CI runs it in the `image` job on the image it's about to publish.
#
# It starts the real infra/compose.edge.yml and infra/compose.prod.yml, as prod and as
# dev, under test project names, and checks:
#
#   - migrations run as a one-shot step (`run --rm app alembic upgrade head`), then
#     the app starts with MIGRATE_ON_START=0 and turns healthy;
#   - Caddy serves https://ineedtofoc.us and https://dev.ineedtofoc.us (certificates
#     from Caddy's internal CA here, Let's Encrypt on the server) and redirects http;
#   - each host reaches its own environment: with the dev app stopped, dev answers 502
#     and prod still answers 200;
#   - the app trusts X-Forwarded-* from Caddy's address only: through Caddy it sees
#     https, while a request straight from another container with spoofed headers
#     doesn't get them honoured;
#   - dev's collector forwards traces to a fake Grafana Cloud gateway with basic auth,
#     tagged deployment.environment.name=dev and service.version=<tag>; prod's
#     collector (no Grafana Cloud settings) is up and accepts the data.
#
#   APP_TAG=<tag>               test ghcr.io/ybenzine/ineedtofocus:<tag> (must exist
#                               locally); unset: build the image as :smoke-local first
#   FOCUS_TEST_PREFIX=<name>    project-name prefix (default focus-smoke): projects
#                               <prefix>-edge, <prefix>-prod, <prefix>-dev
#   SMOKE_HTTP_PORT / SMOKE_HTTPS_PORT   host ports on 127.0.0.1 (default 18080 / 18443)
#   SMOKE_LOG_DIR=<dir>         save every container's logs there when done
#
# Everything it starts is removed at the end, volumes included, so it refuses to run
# with the real project names or on the server. The edge networks use the real fixed
# subnets, so only one run at a time per machine.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
infra=$(dirname "$here")
repo=$(dirname "$infra")
prefix=${FOCUS_TEST_PREFIX:-focus-smoke}
export SMOKE_HTTP_PORT=${SMOKE_HTTP_PORT:-18080}
export SMOKE_HTTPS_PORT=${SMOKE_HTTPS_PORT:-18443}
export SMOKE_DIR=$here
image_repo=ghcr.io/ybenzine/ineedtofocus
spoofed=203.0.113.7

if [[ $prefix == focus ]]; then
  echo "refusing: FOCUS_TEST_PREFIX=focus would use the real projects focus-prod/focus-dev" >&2
  exit 2
fi
if [[ -e /opt/focus ]]; then
  echo "refusing: /opt/focus exists, this looks like the server" >&2
  exit 2
fi

fail() {
  echo "FAIL  $*" >&2
  exit 1
}
ok() { echo "ok    $*"; }

if [[ -z ${APP_TAG:-} ]]; then
  export APP_TAG=smoke-local
  echo "Building $image_repo:$APP_TAG ..."
  docker build -t "$image_repo:$APP_TAG" "$repo"
fi
export APP_TAG
docker image inspect "$image_repo:$APP_TAG" > /dev/null ||
  fail "image $image_repo:$APP_TAG not found locally"

work=$(mktemp -d)
edge_project=$prefix-edge
# The env projects join the test edge project's networks, not focus-edge_*.
edge_files=(-f "$infra/compose.edge.yml" -f "$here/compose.edge.smoke.yml")

edge() { docker compose -p "$edge_project" "${edge_files[@]}" "$@"; }
prod() {
  EDGE_NETWORK=$edge_project"_prod" FOCUS_SECRETS_FILE=$work/prod.env \
    FOCUS_COMPOSE_PROJECT=$prefix-prod "$infra/compose.sh" prod "$@"
}
dev() { # compose.sh's invocation plus the fake Grafana Cloud override
  EDGE_NETWORK=$edge_project"_dev" docker compose -p "$prefix-dev" \
    -f "$infra/compose.prod.yml" -f "$here/compose.dev.smoke.yml" \
    --env-file "$work/dev.env" --env-file "$infra/env/dev.env" "$@"
}

cleanup() {
  local status=$?
  set +e
  if [[ -n ${SMOKE_LOG_DIR:-} ]]; then
    mkdir -p "$SMOKE_LOG_DIR"
    edge logs --no-color --timestamps > "$SMOKE_LOG_DIR/edge.log" 2>&1
    prod logs --no-color --timestamps > "$SMOKE_LOG_DIR/prod.log" 2>&1
    dev logs --no-color --timestamps > "$SMOKE_LOG_DIR/dev.log" 2>&1
  fi
  if [[ $status -ne 0 ]]; then
    echo "--- last log lines (status $status) ---" >&2
    for project in prod dev edge; do "$project" logs --no-color --tail 30 >&2 2>&1; done
  fi
  dev down --volumes --remove-orphans > /dev/null 2>&1
  prod down --volumes --remove-orphans > /dev/null 2>&1
  edge down --volumes --remove-orphans > /dev/null 2>&1
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

# Throwaway secrets files, shaped like /opt/focus/<env>/.env.
instance_id=123456
token=smoke-token-$RANDOM$RANDOM
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 16)" > "$work/prod.env"
cat > "$work/dev.env" << VARS
POSTGRES_PASSWORD=$(openssl rand -hex 16)
GRAFANA_CLOUD_OTLP_ENDPOINT=http://fake-grafana:4318/otlp
GRAFANA_CLOUD_INSTANCE_ID=$instance_id
GRAFANA_CLOUD_OTLP_TOKEN=$token
VARS
SMOKE_EXPECTED_AUTH="Basic $(printf '%s:%s' "$instance_id" "$token" | base64 | tr -d '\n')"
export SMOKE_EXPECTED_AUTH

# The real Caddyfile as JSON, with Caddy's internal CA as the only issuer.
caddy_image=$(docker compose -f "$infra/compose.edge.yml" config --images | grep caddy)
docker run --rm -v "$infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" "$caddy_image" \
  caddy adapt --config /etc/caddy/Caddyfile 2> /dev/null |
  python3 -c '
import json, sys
config = json.load(sys.stdin)
config["apps"]["tls"] = {"automation": {"policies": [{"issuers": [{"module": "internal"}]}]}}
config["apps"]["pki"] = {"certificate_authorities": {"local": {"install_trust": False}}}
json.dump(config, sys.stdout)
' > "$work/caddy.json"
export SMOKE_CADDY_JSON=$work/caddy.json

echo "Starting $edge_project, $prefix-prod and $prefix-dev with $image_repo:$APP_TAG ..."
edge up -d --wait --quiet-pull
ok "edge: Caddy is up"
prod run --rm --quiet-pull app alembic upgrade head > "$work/migrate.log" 2>&1 ||
  fail "prod migration: $(cat "$work/migrate.log")"
ok "prod: migrations ran as a one-shot step"
prod up -d --wait --quiet-pull
ok "prod: app, db and collector are up and healthy"
dev run --rm --quiet-pull app alembic upgrade head > "$work/migrate.log" 2>&1 ||
  fail "dev migration: $(cat "$work/migrate.log")"
ok "dev: migrations ran as a one-shot step"
dev up -d --wait --quiet-pull
ok "dev: app, db and collector are up and healthy"

# Logs go to a file first: `grep -q` closing the pipe early would fail under pipefail.
prod logs app > "$work/app.log" 2>&1
grep -q 'MIGRATE_ON_START=0, skipping migrations' "$work/app.log" ||
  fail "prod app didn't start with MIGRATE_ON_START=0"
ok "app starts without migrating (MIGRATE_ON_START=0)"

request() { # <host> <path> [curl args...] -> prints the HTTP status, body in $work/body
  local host=$1 path=$2
  shift 2
  curl -sS -k -o "$work/body" -w '%{http_code}' --max-time 10 \
    --resolve "$host:$SMOKE_HTTPS_PORT:127.0.0.1" "$@" "https://$host:$SMOKE_HTTPS_PORT$path"
}
expect() { # <status> <host> <path> [curl args...]
  local want=$1 got
  shift
  got=$(request "$@") || got="curl failed"
  [[ $got == "$want" ]] || fail "https://$1$2 answered $got, expected $want: $(head -c 300 "$work/body")"
}

for host in ineedtofoc.us dev.ineedtofoc.us; do
  expect 200 "$host" /healthz
  expect 200 "$host" /readyz
  expect 200 "$host" /
  grep -qi '<!doctype html' "$work/body" || fail "https://$host/ didn't serve the frontend"
  ok "https://$host serves /healthz, /readyz and the frontend over HTTPS"
done

status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
  --resolve "ineedtofoc.us:$SMOKE_HTTP_PORT:127.0.0.1" "http://ineedtofoc.us:$SMOKE_HTTP_PORT/")
[[ $status == 308 ]] || fail "http://ineedtofoc.us answered $status, expected a 308 redirect to https"
ok "http:// redirects to https://"

dev stop app > /dev/null 2>&1
expect 502 dev.ineedtofoc.us /healthz
expect 200 ineedtofoc.us /healthz
ok "routing: with the dev app stopped, dev answers 502 and prod still 200"
dev up -d --wait app > /dev/null 2>&1
expect 200 dev.ineedtofoc.us /healthz
ok "routing: dev is back after restarting its app"

# Proxy trust and telemetry, read from the traces that reach the fake Grafana Cloud.
# Caddy talks plain http to the app; the app records url.scheme=https only when it
# trusts the sender's X-Forwarded-Proto. Through Caddy it must; sent straight to the
# app from another container on dev's network (not Caddy), with spoofed headers, it
# must not.
expect 200 dev.ineedtofoc.us /readyz -H "X-Forwarded-For: $spoofed" -H "X-Forwarded-Proto: http"
dev exec -T fake-grafana python -c "
import urllib.request
request = urllib.request.Request('http://app:8000/readyz', headers={
    'X-Forwarded-For': '$spoofed', 'X-Forwarded-Proto': 'https'})
urllib.request.urlopen(request, timeout=5)
" || fail "direct request to the dev app"
summary=""
for _ in $(seq 1 30); do
  dev logs --no-log-prefix fake-grafana > "$work/fake-grafana.log" 2>&1 || true
  if summary=$(python3 - "$work/fake-grafana.log" << 'PY'
import json, sys
via_caddy = direct = None
for raw in open(sys.argv[1]):
    try:
        line = json.loads(raw)
    except ValueError:
        continue
    if line.get("signal") != "traces":
        continue
    for span in line.get("spans", []):
        if span.get("url.path") != "/readyz":
            continue
        if span.get("server.address") == "dev.ineedtofoc.us":
            via_caddy = via_caddy or {**span, "auth_ok": line["auth_ok"], "resources": line["resources"]}
        elif span.get("server.address") == "app":
            direct = direct or span
if via_caddy and direct:
    print(json.dumps({"via_caddy": via_caddy, "direct": direct}))
else:
    sys.exit(1)
PY
  ); then break; fi
  sleep 2
done
[[ -n $summary ]] || fail "the /readyz traces didn't reach the fake Grafana Cloud gateway: $(tail -5 "$work/fake-grafana.log")"
python3 - "$summary" "$APP_TAG" << 'PY' || fail "telemetry and proxy trust: $summary"
import json, sys
summary, tag = json.loads(sys.argv[1]), sys.argv[2]
via_caddy, direct = summary["via_caddy"], summary["direct"]
assert via_caddy["auth_ok"], "the collector didn't send the expected basic auth"
resources = via_caddy["resources"]
assert any(r.get("deployment.environment.name") == "dev" for r in resources), resources
assert any(r.get("service.version") == tag for r in resources), resources
assert via_caddy.get("url.scheme") == "https", f"Caddy's X-Forwarded-Proto not trusted: {via_caddy}"
assert direct.get("url.scheme") == "http", f"proxy headers trusted from a non-Caddy peer: {direct}"
PY
ok "dev collector forwards traces to Grafana Cloud with basic auth (env=dev, version=$APP_TAG)"
ok "app trusts X-Forwarded-* from Caddy only (a direct request with spoofed headers isn't)"

prod exec -T app python -c \
  "import urllib.request; urllib.request.urlopen('http://otel-collector:13133/', timeout=3)" ||
  fail "prod collector health check"
prod logs otel-collector > "$work/otelcol.log" 2>&1
grep -q 'Everything is ready' "$work/otelcol.log" ||
  fail "prod collector didn't report ready"
ok "prod collector is up without Grafana Cloud settings (accepts and drops)"

echo "OK    production stack smoke test passed"
