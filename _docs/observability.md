# Observability

> **Status: outline.** Filled in with #31–#35. The plan is in [tech_stack.md §4](tech_stack.md).

## Key user journey

Save a finished session (including offline sync batches) and load history.

## Signals

- **Traces:** every request, FastAPI + SQLAlchemy instrumentation; the browser sends `traceparent` so a save shares one trace ID end to end.
- **Metrics:** session saves and history loads, by outcome and latency.
- **Logs:** JSON, with `trace_id` and `span_id` on every line.

## Telemetry privacy (non-negotiable)

Never sent to logs, traces or metrics: email addresses, passwords, cookies or session tokens, session goals, YouTube links. Users appear only as an opaque internal ID. Enforced by an attribute allowlist and covered by a test.

## Alerts (user impact, not resources)

| Alert | Condition |
|---|---|
| Session saves failing | Error rate > 5% over 5 min, with a minimum request count |
| History slow | p95 latency > 2 s over 5 min |

## Where to look

Locally: Grafana from `grafana/otel-lgtm` (`make up`). Deployed: Grafana Cloud dashboards per environment.
