#!/bin/sh
# Container entrypoint for the app image (Dockerfile): migrate the database, then
# start the server given as the command (by default `opentelemetry-instrument uvicorn ...`).
#
# A failed migration exits non-zero, so the container fails to start instead of
# serving against a schema it doesn't expect. Alembic's paths (alembic.ini,
# migrations/) are relative to /app, so it runs from there. It reads DATABASE_URL.
set -eu

cd /app
echo "entrypoint: alembic upgrade head" >&2
alembic upgrade head
echo "entrypoint: migrations applied, starting: $1" >&2

exec "$@"
