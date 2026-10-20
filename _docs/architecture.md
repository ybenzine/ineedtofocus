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

To be written by #6. Planned tables: `users`, `user_settings`, `focus_sessions`, `youtube_recent_links`.

## API contract

The OpenAPI document exported from FastAPI lives at `_docs/api/openapi.json` (added by the first backend API PR). The frontend generates its TypeScript types from it.

## Key decisions

| Decision | Why | Where |
|---|---|---|
| Timestamp-based timers | Correct time after backgrounding/reload | product_decisions F6 |
| Client-generated session UUIDs | Idempotent offline sync, no duplicates | product_decisions AC13.4 |
| Same-origin cookie auth | Simpler and safer than tokens for a web app | tech_stack §1 |
