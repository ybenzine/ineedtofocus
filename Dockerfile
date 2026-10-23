# syntax=docker/dockerfile:1
#
# The one app image: the built frontend served by the FastAPI backend (same origin).
# Used by the local stack (compose.yaml, #4) and, unchanged, by dev and prod (#27): CI
# builds it, smoke-tests it and pushes it to ghcr.io/ybenzine/ineedtofocus:<commit sha>
# (.github/workflows/ci.yml, jobs `image` and `publish`).
#
#   docker build -t focus-app .        # build context: the repo root
#
# Runtime configuration is environment only (see .env.example): DATABASE_URL,
# LOG_LEVEL, READINESS_TIMEOUT_SECONDS and the standard OTEL_* exporter variables.

# --- 1. Frontend: Vite build -> /frontend/dist ---------------------------------
FROM node:24-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- 2. Backend dependencies (uv, locked) --------------------------------------
FROM python:3.12-slim AS backend
COPY --from=ghcr.io/astral-sh/uv:0.11.4 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev

# --- 3. Runtime: no build tools, non-root ---------------------------------------
FROM python:3.12-slim AS runtime
# Links the GHCR package to the repository.
LABEL org.opencontainers.image.source="https://github.com/ybenzine/ineedtofocus" \
      org.opencontainers.image.description="I Need To Focus: FastAPI API + built frontend" \
      org.opencontainers.image.licenses="MIT"
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home app
WORKDIR /app
COPY --from=backend /app/.venv /app/.venv
COPY backend/alembic.ini ./alembic.ini
COPY backend/migrations ./migrations
COPY backend/app ./app
COPY --from=frontend /frontend/dist ./frontend/dist
COPY --chmod=0755 infra/app/entrypoint.sh /usr/local/bin/app-entrypoint
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FRONTEND_DIST=/app/frontend/dist \
    OTEL_SERVICE_NAME=ineedtofocus
USER 10001:10001
EXPOSE 8000
# Runs `alembic upgrade head` first; a failed migration stops the container (#4, #6).
ENTRYPOINT ["app-entrypoint"]
# `opentelemetry-instrument` sets up the tracer, meter and logger providers with OTLP
# exporters (configured by the OTEL_* env vars) and ships Python logs; FastAPI's built-in
# telemetry traces and meters requests through them (backend/app/telemetry.py).
# --proxy-headers: X-Forwarded-For/-Proto are honoured only from the addresses in
# FORWARDED_ALLOW_IPS (uvicorn's default: 127.0.0.1). Deployed, that is Caddy's fixed
# address (infra/env/<env>.env), never `*` (#8, #27).
CMD ["opentelemetry-instrument", "uvicorn", "app.main:app_factory", "--factory", \
     "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
