# Observability

Instrumented in #31. Alerts and dashboards follow in later issues.

## Key user journey

Save a finished session (including offline sync batches) and load history.

## Signals

- **Traces:** every request is a FastAPI server span (`/healthz` is not traced), with a child span per SQL statement from the SQLAlchemy instrumentation (`app/telemetry.py`, `instrument_engine`; the stock instrumentor refuses SQLAlchemy 2.1, so the engine is wired directly). `db.statement` is the parameterised SQL (`$1`, `$2`), never bound values. The browser sends a W3C `traceparent` header on saves, sync batches, history loads and archive calls (`frontend/src/telemetry/tracedFetch.ts`), and the server continues that trace, so one trace ID covers click to database. The browser does not export spans, so the parent span ID in that header never arrives: Tempo shows the server span with a missing parent ("root span not yet received"). That is expected and harmless. Signed-in requests carry `enduser.id`, the opaque user UUID, on the server span.
- **Metrics** (`app/metrics.py`, OTLP, fixed low-cardinality labels):

  | Metric | Type | Labels |
  |---|---|---|
  | `focus.session.saves` | counter, per session | `kind` (single, sync); `outcome` (created, existing, rejected, error) |
  | `focus.session.save.duration` | histogram, seconds, per request | `kind`; `outcome` (ok, client_error, error) |
  | `focus.sync.batch.size` | histogram, sessions per sync request | none |
  | `focus.history.loads` | counter, per request | `outcome` (ok, invalid, error) |
  | `focus.history.load.duration` | histogram, seconds | `outcome` (ok, client_error, error) |

  The duration histograms use second-based buckets with an edge at 2 s (the history alert threshold); the SDK defaults are in milliseconds and would put every request in one bucket.

  What the outcomes cover: a failure inside the handler counts as `rejected` (the client's mistake: a conflict, an invalid session) or `error`. A failure before the handler, namely FastAPI's own 422 validation and an unexpected error such as the sign-in lookup failing during a database outage, is counted by the error handlers (`app/errors.py`): `rejected` or `invalid` for 422, `error` for the rest, once per request (a sync batch that fails that early counts as one). Requests answered 401 or 429 never reach a save or a load and are not counted. The duration histograms time the handler only (after authentication), and only for requests that reach it. The save error rate is `outcome="error"` over all `focus.session.saves`.
- **How the signals link:** logs, traces and metrics share the trace ID. In Grafana: a log line's `trace_id` links to the trace in Tempo; a trace shows its logs; the journey histograms carry exemplars (the OTel SDK attaches the trace ID of the sampled request to a measurement), so a latency panel point opens the trace behind it (enable exemplars on the panel). `make check-stack` proves all three links on a real save: the trace has the request and its SQL spans, Loki has the save's log line with that `trace_id`, and Prometheus has an exemplar with that `trace_id`.
- **Logs:** one JSON object per line on stdout, also shipped over OTLP. Every line has `trace_id` and `span_id` (32 and 16 hex characters; `null` outside a request, e.g. at startup), the same IDs as the spans, so Grafana jumps between a log line and its trace. Only the `extra=` fields in `ALLOWED_EXTRA` (`app/logging_config.py`) are kept; uvicorn's `color_message` (ANSI codes) never ships.

## Telemetry privacy (non-negotiable)

Never sent to logs, traces or metrics: email addresses, passwords, cookies or session tokens, session goals, YouTube links. Users appear only as an opaque internal ID. Enforced by allowlists and covered by tests (`tests/unit/test_telemetry.py`, `tests/unit/test_logging_fields.py`, `tests/integration/test_journey_telemetry.py`):

- **Span attributes:** only names in `ALLOWED_SPAN_ATTRIBUTES` leave the process (no user agent, client address, headers, cookies); exception events keep the type only and span status keeps the code but not the description (both can quote database rows or bound values). The allowlist runs first in the span-processor chain, before the exporter queues the span.
- **Paths and queries:** `url.query` is `REDACTED`. `url.path` and the path inside `url.full`, `http.url` and `http.target` are the route template (`/api/sessions/{session_id}`) for a matched request and `UNMATCHED` otherwise, so an email or an encoded YouTube link typed into a URL is never exported. The API contract therefore keeps emails, goals and YouTube links out of paths too.
- **Log fields:** the `extra=` allowlist above; message and exception text are scrubbed of Postgres `DETAIL` lines, SQL parameters, asyncpg's `invalid input for query argument $N: '<value>'` and ANSI codes. The save and sync handlers log one line each (`session saved`, `sessions synced`) so a trace has a log to link to.
- **Metric labels:** only the fixed words in the table; never a user, tag, goal or time zone.

## Alerts (user impact, not resources)

| Alert | Condition |
|---|---|
| Session saves failing | Error rate > 5% over 5 min, with a minimum request count |
| History slow | p95 latency > 2 s over 5 min |

## Where to look

Locally: Grafana from `grafana/otel-lgtm` (`make up`). Deployed: Grafana Cloud dashboards per environment.
