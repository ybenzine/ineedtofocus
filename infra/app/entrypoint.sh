#!/bin/sh
# Container entrypoint for the app image (Dockerfile): migrate the database, then
# start the server given as the command (by default `opentelemetry-instrument uvicorn ...`).
#
# A failed migration exits non-zero, so the container fails to start instead of
# serving against a schema it doesn't expect. Alembic's paths (alembic.ini,
# migrations/) are relative to /app, so it runs from there. It reads DATABASE_URL.
#
# MIGRATE_ON_START (default 1): set to 0 to skip the migration step. Deploys (#27/#30)
# run migrations as their own step and roll back to an older image with it off: an
# older image doesn't know newer revisions, and expand-only migrations keep it working.
set -eu

cd /app
case "${MIGRATE_ON_START:-1}" in
  1 | true)
    echo "entrypoint: alembic upgrade head" >&2
    alembic upgrade head
    echo "entrypoint: migrations applied" >&2
    ;;
  0 | false)
    echo "entrypoint: MIGRATE_ON_START=${MIGRATE_ON_START}, skipping migrations" >&2
    ;;
  *)
    echo "entrypoint: MIGRATE_ON_START must be 1/true or 0/false, got '${MIGRATE_ON_START}'" >&2
    exit 2
    ;;
esac

echo "entrypoint: starting: $1" >&2
exec "$@"
