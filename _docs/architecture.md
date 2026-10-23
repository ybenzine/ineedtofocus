# Architecture

> **Status: outline.** Filled in by the backend and frontend agents as #6, #7 and the API issues (#8, #10–#12) land.

## Components

```mermaid
flowchart LR
    subgraph Device["User's device (browser / installed app)"]
        UI[React app] --> IDB[(IndexedDB<br/>sessions + sync queue)]
        SW[Service worker<br/>app shell, sounds, rain] -.-> UI
    end
    UI -- "HTTPS, same origin<br/>session cookie" --> API[FastAPI]
    API --> PG[(PostgreSQL)]
    API -- OTLP --> COL[OpenTelemetry Collector]
    COL --> GC[Grafana Cloud]
```

- **Frontend** (`frontend/`): timer engine, audio, offline storage and sync, history and settings screens. Served by the backend so app and API share one origin.
- **Backend** (`backend/`): accounts, sessions, history aggregation, settings. Owns the API contract.
- **Database:** PostgreSQL; UTC timestamps; history grouping in the user's time zone.

## Data model

Models live in `backend/app/models/`, migrations in `backend/migrations/versions/` (Alembic, async: `migrations/env.py` uses `DATABASE_URL`). All timestamps are `timestamptz` (UTC). Primary keys are UUIDs; deleting a user cascades to their rows. Enumerated values are lower-case text with `CHECK` constraints (no Postgres enum types, so adding a value is a plain constraint change).

| Table | Columns and constraints |
|---|---|
| `users` | `id` (uuid, default generated), `email` (unique case-insensitively via an index on `lower(email)`), `password_hash`, `created_at` |
| `user_settings` | one row per user (`user_id` PK/FK): `week_start_day` 0-6 (0 = Sunday, default), `alert_volume` and `background_volume` 0-100, `keep_screen_awake`, `default_reminder_minutes` (NULL = Off, else 15/30/45/60/90/120), `pomodoro_config` (JSONB, last used), `last_tag`, `updated_at` |
| `focus_sessions` | `id` (uuid, **client-generated**, no default), `user_id`, `mode` (`countdown`/`pomodoro`/`unlimited`), `tag` (`work`/`study`/`nap`/`read`/`meditation`/`exercise`), `goal` (nullable, <= 120 chars), `started_at`, `ended_at` (>= `started_at`), `focus_seconds` >= 0, `paused_seconds` >= 0, `status` (`completed`/`ended_early`), `mode_config` (JSONB), `blocks_completed` >= 0, `archived_at` (NULL = active), `created_at` |
| `youtube_recent_links` | `id`, `user_id`, `url`, `last_used_at`; unique per `(user_id, url)`. The API keeps only the 5 most recent per user |

Indexes on `focus_sessions` support history: `(user_id, started_at DESC)`, `(user_id, tag, started_at DESC)` for the tag filter, and a partial `(user_id, archived_at) WHERE archived_at IS NOT NULL` for the Archive view. Archived sessions stay in the same table (`archived_at`), so history queries add `archived_at IS NULL`.

### Migrations

- **Apply:** `make migrate` (`alembic upgrade head` against `DATABASE_URL`). Deploys run `alembic upgrade head` before the app starts; the wiring lands with whichever of the compose app service (#4) and the schema (#6) merges second.
- **Backward-compatible (expand/contract).** The app version being rolled back to must still work on the migrated schema, so a release only *adds* (tables, nullable or defaulted columns, indexes); removals and renames happen in a later release once no deployed version uses them. This is checked by a lint test for common cases, not proven: `tests/unit/test_migration_safety.py` fails CI if `upgrade()` calls `drop_table`, `drop_column`, `drop_constraint`, `drop_index`, `rename_table`, `alter_column`, `execute` or `exec_driver_sql` (including through aliases), or adds a NOT NULL column without a `server_default`, unless the file has a real comment line `# contract-migration: <reason>` with a non-empty reason. Reviewers still check every migration for expand/contract compliance. A drift test also fails if the models and migrations disagree (columns, server defaults, indexes and CHECK constraints).
- `downgrade()` exists for local use and is tested, but rollbacks in production redeploy the previous app version and do not downgrade the database.

## API contract

The OpenAPI document exported from FastAPI lives at `_docs/api/openapi.json` (added by the first backend API PR). The frontend generates its TypeScript types from it.

### Conventions (from #7)

- **Error envelope.** Every non-2xx response is `{"error": {"code", "message", "details"?}}`. Validation failures are 422 with `code: "validation_error"` and `details: [{"field", "message", "type"}]`. `field` is a dotted path; client-chosen keys are never echoed (non-identifier keys show as `<key>`, unexpected extra fields as `<unknown>`), and submitted values are never returned. OpenAPI documents this as `ErrorResponse`.
- **`/healthz` vs `/readyz`.** `/healthz` means the process is up and never touches the database (liveness). `/readyz` runs `SELECT 1` with a timeout and returns 503 if the database is unreachable (readiness). The deploy script checks both.
- **Frontend serving.** The API lives under `/api` (plus `/healthz`, `/readyz`). If `frontend/dist` exists, any other unmatched GET serves the matching file or falls back to `index.html` (SPA routing). Unknown `/api/*` paths return the JSON 404. Implemented as a fallback after routing fails, so routes are never shadowed.
- **Database access.** SQLAlchemy 2 async with the asyncpg driver; `DATABASE_URL` is `postgresql+asyncpg://...`.

## Frontend timer engine (#13)

`frontend/src/timer/` holds the timer logic for all three modes, with no UI.

- **Timestamps, not ticks.** An active session is its config plus wall-clock timestamps: start, each pause and resume, each skipped break. Focus time, paused time, the Pomodoro phase and remaining time are all derived from those and the current time (`engine.ts`), so the display is correct after backgrounding, sleep or a reload. "Active time" is wall time minus paused time; Pomodoro phases are laid out along it.
- **Events.** `advance(session, now)` reports what fell since the last call (`phase-change`, `reminder`, `session-end`) and, if the session reached its own end, the exact wall time it ended. The UI and sounds (#15, #16) call `TimerController.tick()` on an interval and on `visibilitychange`.
- **One active session, on the device.** `TimerController` (`controller.ts`) allows one session at a time and writes every change to an `ActiveSessionStore` (`store.ts`; `localStorage` in the app). `restore()` on app start picks the session up again; a countdown or Pomodoro that ended while the app was closed is saved as Completed at its scheduled end, and bells missed while closed aren't replayed.
- **Never lost.** A finished session's record stays in the store as `pendingRecord` until `saveRecord` (the IndexedDB session store, #19) has accepted it; failures leave it there and it is handed over again by `retryPending()`, `restore()` or the next `start()`. Sessions under 1 minute of focus are discarded with a message instead.
- **12-hour limit.** The unlimited timer stops at 12 hours of focus time (paused time excluded, like its reminders).

## Key decisions

| Decision | Why | Where |
|---|---|---|
| Timestamp-based timers | Correct time after backgrounding/reload | product_decisions F6 |
| Client-generated session UUIDs | Idempotent offline sync, no duplicates | product_decisions AC13.4 |
| Same-origin cookie auth | Simpler and safer than tokens for a web app | tech_stack §1 |
