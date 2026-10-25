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

| Where | Grafana | Dashboard |
|---|---|---|
| Local (`make up`) | `grafana/otel-lgtm` at `http://localhost:<GRAFANA_PORT>` (3000 by default) | **I Need To Focus → I Need To Focus: key journey (local)**, provisioned by `compose.yaml` |
| Dev, prod | Grafana Cloud stack https://ineedtofocus.grafana.net | **I Need To Focus: key journey (dev)** / **(prod)**, imported from `infra/grafana/dashboards/` ([below](#dashboards-32)) |

## Grafana Cloud (#32)

| | |
|---|---|
| Stack | https://ineedtofocus.grafana.net |
| OTLP endpoint | `https://otlp-gateway-prod-us-east-3.grafana.net/otlp` |
| Instance ID (OTLP basic-auth user) | `1889715` |

### One collector per environment

Each Compose project (`focus-prod`, `focus-dev`) keeps its own OpenTelemetry Collector (`infra/otel-collector/`, [deployment.md](deployment.md#telemetry-to-grafana-cloud)). #32 settles this; a single shared collector was the alternative. Reasons:

- **Dev can't hurt prod's telemetry.** A burst from dev fills dev's batch queue and trips dev's `memory_limiter`, never prod's. Each collector has its own 96 MiB limit, and dev's has `oom_score_adj: 500` like the rest of dev ([deployment.md](deployment.md#memory-dev-cant-starve-prod)).
- **The environment label can't be wrong.** Each collector upserts `deployment.environment.name` from its own `FOCUS_ENV` (`prod` or `dev`) onto every span, metric and log record. A shared collector would have to trust what each app sends.
- **Separate credentials.** Each environment's token lives in its own `/opt/focus/<env>/.env`. The two files may hold the same token or one each; with one each, dev's can be revoked without touching prod.
- **Cost:** 96 MiB of the Droplet's memory budget, already counted ([deployment.md](deployment.md#memory-dev-cant-starve-prod)).

Dev and prod are told apart in Grafana Cloud by `deployment.environment.name`, the current OpenTelemetry name for `deployment.environment`. Grafana Cloud promotes it to a label:

- metrics: `deployment_environment_name="prod"`;
- logs: `| deployment_environment_name="prod"`, which works whether Loki indexes it or keeps it as structured metadata;
- traces: `resource.deployment.environment.name="prod"`.

The local stack sets `local` (`compose.yaml`).

### Credentials

| Token | Scopes | Lives only in | Read by |
|---|---|---|---|
| OTLP write token (`GRAFANA_CLOUD_OTLP_TOKEN`) | `metrics:write`, `logs:write`, `traces:write` | `/opt/focus/prod/.env` and `/opt/focus/dev/.env` on the server (mode 600), next to `GRAFANA_CLOUD_OTLP_ENDPOINT` and `GRAFANA_CLOUD_INSTANCE_ID` ([.env.example](../.env.example), "Deployed environments") | That environment's collector |
| Read-only token (`GRAFANA_READONLY_TOKEN`) | read metrics, logs, traces | The GitHub `oncall` environment's secrets | The on-call workflow (#35) |

Neither token is ever in git, in repo-level GitHub secrets or in any other environment. `scripts/tests/test_grafana_dashboards.py` fails if a workflow mentions the OTLP token, or reads the read-only token outside a job in the `oncall` environment. To rotate the OTLP token, put the new value in both `.env` files and recreate each collector: `APP_TAG=<current tag> infra/compose.sh <env> up -d otel-collector`.

### Check that both environments arrive

In Grafana Cloud, open **Explore** and run:

| Data source | Query | Expect |
|---|---|---|
| `grafanacloud-…-prom` | `count by (deployment_environment_name) (target_info{service_name="ineedtofocus"})` | A `dev` and a `prod` series (an environment shows once its app has sent metrics, within a minute of starting) |
| `grafanacloud-…-logs` | `{service_name="ineedtofocus"} \| deployment_environment_name="prod"` | Prod's log lines |
| `grafanacloud-…-traces` | `{resource.service.name="ineedtofocus" && resource.deployment.environment.name="prod"}` | Prod's request traces |

If an environment is missing, look at its collector's logs on the server: `APP_TAG=<current tag> infra/compose.sh <env> logs otel-collector`. A 401 there means a wrong instance ID or token.

## Dashboards (#32)

One key-journey dashboard per environment: `infra/grafana/dashboards/key-journey-prod.json`, `-dev.json` and `-local.json`. The three are generated from one model, `scripts/grafana_dashboards.py`, and differ only in the environment they filter on and their default data sources. Each has a fixed UID (`focus-key-journey-<env>`) and links to the others.

| Row | Panels | Source |
|---|---|---|
| Session saves | Save success rate over the time range and over 5-minute windows (with the 95% alert line); sessions saved per minute by `outcome`; save latency p50/p95/p99 by `kind`, with exemplars that open their trace; offline sync batch size; save requests by `kind` and `outcome` | `focus_session_saves_total`, `focus_session_save_duration_seconds`, `focus_sync_batch_size` |
| History loads | p95 latency over the time range; p50/p95/p99 latency with the 2 s alert line and exemplars; loads per minute by `outcome`; error rate | `focus_history_load_duration_seconds`, `focus_history_loads_total` |
| Errors, logs and traces | Error logs (severity ERROR and above); the same lines as a table whose `trace_id` opens the trace in Explore; error log lines per minute by logger; failed requests (TraceQL, `status=error`); key-journey requests over 1 s | Loki, Tempo |
| HTTP, every API route | Requests per minute by route; 5xx ratio and p95 latency of the key-journey routes | `http_server_request_duration_seconds` (FastAPI's standard metric) |

**Metric names.** The dashboards query the Prometheus form of the OpenTelemetry metrics in [Signals](#signals). Dots become underscores, a unit of `s` adds `_seconds`, a counter adds `_total`, and annotation units such as `{session}` add nothing:

| OpenTelemetry (backend, #31) | Prometheus (dashboards) |
|---|---|
| `focus.session.saves` | `focus_session_saves_total` |
| `focus.session.save.duration` | `focus_session_save_duration_seconds_bucket` / `_count` / `_sum` |
| `focus.sync.batch.size` | `focus_sync_batch_size_bucket` / `_count` / `_sum` |
| `focus.history.loads` | `focus_history_loads_total` |
| `focus.history.load.duration` | `focus_history_load_duration_seconds_bucket` / `_count` / `_sum` |
| `http.server.request.duration` (FastAPI) | `http_server_request_duration_seconds_bucket` / `_count` / `_sum` |

**Save success rate** is `1 - outcome="error" / all sessions submitted`, the complement of the alert's save error rate: a `rejected` session (invalid input, an id conflict) was handled correctly, so it doesn't count against it. While nothing has failed, the rate reads 100%, not "no data".

### Import into Grafana Cloud (prod and dev)

Do this once, and again after a PR changes a dashboard. Grafana Cloud doesn't read the repo, and an import needs an editor's login, which no agent has.

1. In https://ineedtofocus.grafana.net, open **Dashboards**. Choose **New → New folder**, name it `I Need To Focus` and create it. Skip this step once the folder exists.
2. Choose **New → Import**. Under **Upload dashboard JSON file**, choose `infra/grafana/dashboards/key-journey-prod.json` from a checkout of `main` (or paste the file's raw GitHub contents).
3. Set **Folder** to `I Need To Focus` and leave the name and UID as they are. Choose **Import**. When re-importing, Grafana says a dashboard with that UID exists; choose **Import (Overwrite)**.
4. Repeat with `key-journey-dev.json`.
5. Open each dashboard. If a panel says the data source wasn't found, pick the stack's data sources in the **Metrics**, **Logs** and **Traces** dropdowns at the top: `grafanacloud-ineedtofocus-prom`, `-logs` and `-traces`. The defaults are Grafana Cloud's built-in UIDs (`grafanacloud-prom`, `grafanacloud-logs`, `grafanacloud-traces`), which normally match. Then **Save dashboard**.

**Changing a dashboard:** edit `scripts/grafana_dashboards.py`, run `python3 scripts/grafana_dashboards.py` and commit the regenerated JSON with it. `make test-scripts` fails when the JSON and the script disagree. After the merge, re-import. Changes made in the Grafana UI are overwritten by the next import, so move them into the script.

**Locally**, `make up` provisions `key-journey-local.json` into grafana/otel-lgtm (read-only in the UI). After regenerating it, recreate the container with `docker compose up -d lgtm`. This drops the local telemetry, which lgtm keeps in memory. `make check-stack` (in CI too) checks that the dashboard is provisioned and that each of its queries runs against Prometheus, Loki and Tempo (`python3 scripts/grafana_dashboards.py verify`).

### Screenshots

Local stack, with the #31 instrumentation, a few minutes of traffic and a 20-second database outage (stopped Postgres), last 15 minutes:

![Key-journey dashboard, local stack: session saves and history rows](images/observability/key-journey-saves-history.png)

![Key-journey dashboard, local stack: errors, logs, traces and HTTP rows](images/observability/key-journey-errors-http.png)

Clicking a `trace_id` in **Error logs with their traces** opens the failed request's trace in Explore:

![The trace of a failed history load, opened from an error log line](images/observability/error-log-to-trace.png)
