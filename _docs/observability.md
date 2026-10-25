# Observability

Instrumented in #31; Grafana Cloud wiring and the key-journey dashboards in #32; the user-impact alert rules, the fault-injection trigger and the traffic script in #33. Routing alerts to the on-call agent follows in #34.

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

Two Grafana-managed alert rules per environment (#33), on the key journey only. None on CPU, memory or any other resource ([tech_stack.md §4](tech_stack.md)); `scripts/tests/test_grafana_alerts.py` fails if a rule queries anything but the journey metrics.

| Alert | Fires when | Queries (Prometheus, last 5 minutes) |
|---|---|---|
| **Session saves failing** | More than 5% of the sessions submitted failed, with at least 10 sessions submitted | A: `outcome="error"` over all `focus_session_saves_total`, the complement of the dashboards' save success rate, so a `rejected` session doesn't count. B: the sessions submitted. Condition: `$A > 0.05 && $B >= 10` |
| **History slow** | The p95 latency of `GET /api/history` is above 2 s | A: `histogram_quantile(0.95, …focus_history_load_duration_seconds_bucket…)`; 2 s is a bucket edge, so the estimate is exact at the threshold. Condition: `$A > 2` |

- **Evaluation:** every minute; a rule fires once its condition has held for one more minute (pending period `1m`), and resolves on the first evaluation where it no longer holds. A sudden outage therefore fires about 2 minutes after it starts; the 5-minute window keeps a short blip from firing.
- **The minimum count** is per session, not per request: a sync batch of 5 counts 5, as in the error rate. It stops one failed save at 3 a.m. from paging anyone. The history rule has no minimum, as its acceptance criterion says.
- **Quiet periods are "no data", and no data is OK.** The journey counters exist from startup at 0 (below), so a 5-minute window without traffic is 0/0 (or a quantile of nothing), which is NaN, and Grafana takes a NaN condition as true. Each query therefore filters with `> 0`, which turns that into no data. A query that fails keeps the rule's last state (`execErrState: KeepLast`): a broken Grafana Cloud query isn't user impact, and it would otherwise raise an alert of its own.
- **Fresh outages count.** A counter series only exists from its first increment, and `increase()` needs two samples, so the first burst of errors after a start would be invisible: the error series would appear already at its burst value and the error rate would read 0. The app therefore adds 0 to every `kind` × `outcome` of `focus.session.saves` and every `outcome` of `focus.history.loads` at startup (`zero_journey_series` in `app/metrics.py`).
- **Labels** `service=ineedtofocus`, `environment=<env>`, `alert=session-save-errors|history-latency`; the routing (#34) and the on-call agent (#35) go by them. **Annotations:** a summary, a description with the values (e.g. "19.67% of the 65 sessions submitted in the last 5 minutes failed"), the runbook (`_docs/runbooks/<alert>.md`) and the dashboard panel behind the alert.

The rules are generated, like the dashboards, from one model, `scripts/grafana_alerts.py`, which builds the queries with `scripts/grafana_dashboards.py`'s selectors so the two can't drift: `infra/grafana/alerts/key-journey-prod.json`, `-dev.json` and `-local.json`, in Grafana's alert provisioning format (what Grafana's own export writes). Each environment's group filters on its own `deployment_environment_name`. **Changing a rule:** edit the script, run `python3 scripts/grafana_alerts.py`, commit the JSON with it (`make test-scripts` fails when they differ), and after the merge re-apply it to Grafana Cloud ([below](#apply-the-alert-rules-to-grafana-cloud)).

**Locally**, `make up` provisions `key-journey-local.json` into grafana/otel-lgtm (**Alerting → Alert rules → I Need To Focus**). `make check-stack` (in CI too) checks that the rules are provisioned and evaluate without errors, that each of their queries runs, and that every metric selector in them returns series after its probe's save and history load (`python3 scripts/grafana_alerts.py verify`). So a renamed metric or label can't leave a rule quietly evaluating nothing. It checks the selectors, such as `focus_session_saves_total{…, outcome="error"}`, rather than the whole expressions, because those are "no data" by design when the window holds too little traffic: after one history load the latency series exists, but its p95 needs a second sample. The error-outcome series exists only thanks to the zero-initialisation, so this also checks that. Locally the rules have no contact point, so a firing alert shows in the UI only.

### Alert trigger: fault injection

`FAULT_SAVE_ERROR_PERCENT` (0 to 100, default **0, off**) makes that share of session save requests (`POST /api/sessions` and `POST /api/sessions/sync`) fail on purpose (`app/faults.py`). Only the operator can change it:

- It's an environment variable the app reads once at startup. No endpoint reads, shows or changes it (`tests/unit/test_faults.py` checks the routes and the OpenAPI schema), so no user can turn it on.
- Deployed, it comes only from the server's `/opt/focus/<env>/.env`. `infra/compose.prod.yml` defaults it to 0, `infra/env/<env>.env` never sets it (it would win over the server file), and `make test-infra` checks both.
- When it's on, the app logs a warning at startup: `fault injection on: session saves fail on purpose`, with `fault_save_error_percent`.

A request picked to fail raises `InjectedSaveFault` before anything is written, so it fails like a real server error: the client gets a 500 and keeps the session in its offline queue to retry later (nothing is lost), every session in the request counts as `outcome="error"`, and the log line (`unhandled exception`) and the trace carry the exception type `InjectedSaveFault`. That's how whoever is on call tells an injected fault from a real one. A rollback doesn't clear it, since the rolled-back app reads the same server file.

**Fire the save alert on dev** (the operator, on the server):

1. Add `FAULT_SAVE_ERROR_PERCENT=30` to `/opt/focus/dev/.env` and recreate the app: `APP_TAG=<current dev tag> infra/compose.sh dev up -d app`.
2. From any machine: `python3 scripts/traffic.py --base-url https://dev.ineedtofoc.us --minutes 10`.
3. **Session saves failing (dev)** goes pending, then fires, within about 3 minutes.
4. Delete the line (or set it to 0) and recreate the app the same way. The alert resolves within about 6 minutes, once the failures have left its 5-minute window.

### Traffic script

`scripts/traffic.py` sends realistic key-journey traffic. It signs up its own throwaway account (`traffic-<random>@example.com`, with a random password it never prints), then sends single saves (about 45%), offline sync batches of 2 to 5 sessions (15%; some repeat a session already saved, and now and then one holds an invalid session) and history loads over every view and a few time zones (40%). The default is 20 requests a minute for 10 minutes (`--rate`, `--minutes`; at most 120 a minute), enough to clear the save alert's minimum many times over without loading dev's small Droplet. It prints a line a minute, by result. Without fault injection almost nothing fails, so no alert fires. It refuses to run against production (`ineedtofoc.us`): prod's alerts page the on-call agent, and its data is real users'. The default target is this checkout's local stack (`APP_PORT`).

### Proof on the local stack

On 2026-10-25, on a freshly started local stack (so the error series were new, the case the zero-initialisation is for): the app recreated with `FAULT_SAVE_ERROR_PERCENT=30` at 08:35:01Z, then `python3 scripts/traffic.py --rate 30 --minutes 9`, and at 08:38:30Z the app recreated with it back at 0 while the traffic went on. Times UTC:

```text
$ python3 scripts/grafana_alerts.py wait session-save-errors firing
08:35:31Z  session-save-errors: normal
08:36:51Z  session-save-errors: pending
08:37:51Z  session-save-errors: firing
$ python3 scripts/grafana_alerts.py wait session-save-errors normal
08:38:36Z  session-save-errors: firing
08:43:46Z  session-save-errors: normal
```

It fired 2 min 50 s after fault injection went on, and resolved 5 min 16 s after it went off. Grafana's description of the firing alert read "19.67% of the 64.96 sessions submitted in the last 5 minutes failed" (the count is a whole number now). The traffic script's total: 118 single saves ok and 15 failed, 37 sync batches ok and 2 failed, 110 history loads ok; **History slow** stayed normal throughout. `python3 scripts/grafana_alerts.py wait <rule> firing|pending|normal` waits for a local rule's state, for drills like this one.

### Apply the alert rules to Grafana Cloud

Grafana Cloud doesn't read the repo, and no agent has an editor login, so Yacine applies the rules once, and again after a PR changes them. `apply` creates or updates the environment's rule group through Grafana's alerting provisioning API, in the `I Need To Focus` folder (it creates the folder if it's missing). It keeps the rules editable in the UI, and it's idempotent, so a re-run overwrites with the repo's version.

1. In https://ineedtofocus.grafana.net, go to **Administration → Users and access → Service accounts → Add service account**. Name it `alert-rules-apply`, set the role to **Editor** and choose **Create**.
2. Choose **Add service account token**, name it `apply-<date>`, set **Expiration** to a day from now, choose **Generate token** and copy it.
3. From an up-to-date checkout of `main`, run `python3 scripts/grafana_alerts.py apply prod --grafana https://ineedtofocus.grafana.net` and paste the token at the prompt (it isn't echoed, stored or printed). Then run the same command with `dev`.
4. Delete the token (or let it expire). The service account can stay for the next apply.
5. Check: **Alerting → Alert rules** lists **I Need To Focus → key-journey-prod** and **key-journey-dev**, two rules each, with state **Normal** and no error. Choose a rule's **View** to see its queries return a value.

If the stack's Prometheus data source isn't `grafanacloud-prom`, `apply` uses its one `grafanacloud-*-prom` data source, or asks for `--datasource <uid>` (shown in **Connections → Data sources**, in the data source's URL).

Until the contact point and routing land (#34), a firing alert follows the stack's default notification policy (**Alerting → Notification policies**), so it may notify no one; the rule's state in **Alert rules** is what to check.

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
| `grafanacloud-…-prom` | `count by (deployment_environment_name) (http_server_request_duration_seconds_count{service_name="ineedtofocus"})` | A `dev` and a `prod` series (an environment shows once its app has served requests and sent metrics, within a minute) |
| `grafanacloud-…-logs` | `{service_name="ineedtofocus"} \| deployment_environment_name="prod"` | Prod's log lines |
| `grafanacloud-…-traces` | `{resource.service.name="ineedtofocus" && resource.deployment.environment.name="prod"}` | Prod's request traces |

The metrics query counts a request metric's data points, not `target_info`: `target_info` carries the resource attributes even when Grafana Cloud doesn't promote `deployment.environment.name` onto every series, and then every dashboard panel and alert query, which filter on the data points' `deployment_environment_name`, would be empty while that check passed ([#32](https://github.com/ybenzine/ineedtofocus/issues/32#issuecomment-6395384377)).

Then open the dev dashboard (**I Need To Focus: key journey (dev)**) and confirm the panels show data: the **Session saves**, **History loads** and **HTTP, every API route** rows should show lines and numbers, not "No data" (use dev once first if it has had no traffic lately).

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

**Locally**, `make up` provisions `key-journey-local.json` into grafana/otel-lgtm (read-only in the UI). After regenerating it, recreate the container with `docker compose up -d lgtm`. This drops the local telemetry, which lgtm keeps in memory. `make check-stack` (in CI too) checks that the dashboard is provisioned and that each of its queries runs against Prometheus, Loki and Tempo (`python3 scripts/grafana_dashboards.py verify`). Since #33 every Prometheus query must also return data, after the probe's save and history load: an unknown metric or label parses fine and returns nothing, which would otherwise blank a panel silently. The Loki and Tempo queries only have to run, since the error panels are rightly empty while nothing fails.

### Screenshots

These come from the local stack, which uses the same model as prod and dev. They show the last 15 minutes of saves, sync batches (some with an invalid item) and history loads (some with a bad time zone), including a few seconds with Postgres stopped. Retake them with `node scripts/grafana_screenshots.mjs`.

![Key-journey dashboard, local stack: session saves and history loads](images/observability/key-journey-saves-history.png)

![Key-journey dashboard, local stack: errors, logs, traces and every API route](images/observability/key-journey-errors-http.png)

Clicking a `trace_id` in **Error logs with their traces** opens the failed request's trace in Explore:

![The trace of a failed request, opened from its error log line](images/observability/error-log-to-trace.png)
