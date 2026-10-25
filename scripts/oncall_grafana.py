#!/usr/bin/env python3
"""Read-only Grafana for the on-call agent (#35): metrics, logs, traces and alert states.

    python3 scripts/oncall_grafana.py journey <env>            # the alerts' numbers now
    python3 scripts/oncall_grafana.py alerts <env>             # the env's two rules' states
    python3 scripts/oncall_grafana.py wait <alert> <env> normal|firing [--minutes 20]
    python3 scripts/oncall_grafana.py errors <env> [--minutes 30] [--limit 20]
    python3 scripts/oncall_grafana.py failed <env> [--minutes 30] [--limit 10]
    python3 scripts/oncall_grafana.py slow <env> [--minutes 30] [--limit 10]
    python3 scripts/oncall_grafana.py trace <trace id>
    python3 scripts/oncall_grafana.py prom '<PromQL>' [--minutes 0]   # >0: a range
    python3 scripts/oncall_grafana.py logs '<LogQL>' [--minutes 30] [--limit 20]
    python3 scripts/oncall_grafana.py traces '<TraceQL>' [--minutes 30] [--limit 10]

Grafana: `GRAFANA_URL` (default https://ineedtofocus.grafana.net), with the Viewer token in
`GRAFANA_READONLY_TOKEN` (the `oncall` environment's secret, _docs/observability.md). The
token goes only to an https:// Grafana, in a header, and is never printed; a redirect is
never followed, since it would carry the token elsewhere. A local stack works too:
`GRAFANA_URL=http://127.0.0.1:3000`, no token. Data source UIDs default to Grafana Cloud's
built-in ones (grafana/otel-lgtm's locally); `GRAFANA_PROM_UID`, `GRAFANA_LOGS_UID` and
`GRAFANA_TRACES_UID` override them.

Every request is a GET. The output is compact JSON or one line per item, cut to a few
hundred characters a line, so a noisy query can't flood the agent's context. Telemetry
never holds customer data (observability.md, Telemetry privacy); trace spans print only a
few attributes (`SPAN_ATTRIBUTES`). The journey queries are the alert rules' own
(scripts/grafana_alerts.py), so "X% of saves failing" here is what the alert saw. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import grafana_alerts as ga
import grafana_dashboards as g

GRAFANA_CLOUD = "https://ineedtofocus.grafana.net"
LOCAL_HOSTS = ("localhost", "127.0.0.1")
ALERTS = ("session-save-errors", "history-latency")
ENVS = ("prod", "dev", "local")
TRACE_ID = re.compile(r"[0-9a-f]{32}")
LINE = 400  # characters per printed line
LOG_LABELS = ("severity_text", "exception_type", "scope_name", "trace_id")
UID_OVERRIDES = {
    "metrics": "GRAFANA_PROM_UID",
    "logs": "GRAFANA_LOGS_UID",
    "traces": "GRAFANA_TRACES_UID",
}
SPAN_ATTRIBUTES = (
    "http.request.method",
    "http.route",
    "http.response.status_code",
    "error.type",
    "exception.type",
    "db.operation.name",
    "db.system",
    "service.version",
)


class GrafanaError(RuntimeError):
    pass


def base_url() -> str:
    """GRAFANA_URL without a trailing slash: https://, or http:// on this machine only."""
    url = os.environ.get("GRAFANA_URL", GRAFANA_CLOUD).rstrip("/")
    parts = urllib.parse.urlsplit(url)
    if parts.scheme == "https" and parts.hostname:
        return url
    if parts.scheme == "http" and parts.hostname in LOCAL_HOSTS:
        return url
    raise GrafanaError(f"GRAFANA_URL must be https://, or http:// on localhost: {url!r}")


def _local(url: str) -> bool:
    return urllib.parse.urlsplit(url).scheme == "http"


def datasource(kind: str, url: str) -> str:
    """The `metrics`, `logs` or `traces` data source UID for that Grafana."""
    override = os.environ.get(UID_OVERRIDES[kind])
    if override:
        return override
    return g.DATASOURCES["local" if _local(url) else "cloud"][kind]


def get(api: str, params: dict[str, str] | None = None) -> Any:
    """GET `api` on the Grafana, with the token over https only. JSON back."""
    url = base_url()
    full = f"{url}{api}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
    headers = {"Accept": "application/json"}
    token = os.environ.get("GRAFANA_READONLY_TOKEN", "")
    if not _local(url):
        if not token:
            raise GrafanaError("GRAFANA_READONLY_TOKEN is not set (the oncall environment's)")
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(full, headers=headers, method="GET")
    try:
        with ga._OPENER.open(request, timeout=30) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise GrafanaError(f"GET {api} -> HTTP {e.code} redirect, not followed") from None
        raise GrafanaError(f"GET {api} -> HTTP {e.code}: {e.read().decode()[:300]}") from None
    except urllib.error.URLError as e:
        raise GrafanaError(f"GET {api} -> {e.reason}") from None
    return json.loads(raw) if raw else None


def _proxy(kind: str) -> str:
    return f"/api/datasources/proxy/uid/{urllib.parse.quote(datasource(kind, base_url()))}"


def _cut(text: str) -> str:
    text = re.sub(r"\s*[\r\n\t]+\s*", " ", str(text)).strip()
    return text if len(text) <= LINE else text[: LINE - 1] + "…"


# --- Metrics --------------------------------------------------------------------------


def prom(expr: str, minutes: int = 0, step: int = 60) -> list[dict[str, Any]]:
    """Series of an instant query (minutes=0) or a range over the last `minutes`."""
    now = int(time.time())
    if minutes > 0:
        params = {
            "query": expr,
            "start": str(now - minutes * 60),
            "end": str(now),
            "step": str(step),
        }
        found = get(f"{_proxy('metrics')}/api/v1/query_range", params)
    else:
        found = get(f"{_proxy('metrics')}/api/v1/query", {"query": expr, "time": str(now)})
    if not isinstance(found, dict) or found.get("status") != "success":
        raise GrafanaError(f"query refused: {_cut(json.dumps(found))}")
    return list((found.get("data") or {}).get("result") or [])


def scalar(expr: str) -> float | None:
    """The value of a one-series instant query; None when it returns no data."""
    series = prom(expr)
    if not series:
        return None
    return float(series[0]["value"][1])


def journey(env: str) -> dict[str, Any]:
    """The alert rules' queries now: what the alert sees, over the last 5 minutes."""
    error_rate = scalar(ga.save_error_rate(env))
    p95 = scalar(ga.history_p95(env))
    return {
        "environment": env,
        "window": ga.WINDOW,
        "save_error_rate": None if error_rate is None else round(error_rate, 4),
        "sessions_submitted": _rounded(scalar(ga.sessions_submitted(env))),
        "save_alert_fires_above": ga.SAVE_ERROR_RATE_LIMIT,
        "save_alert_minimum_sessions": ga.SAVE_MIN_SESSIONS,
        "history_p95_seconds": None if p95 is None else round(p95, 3),
        "history_loads": _rounded(scalar(ga.history_loads(env))),
        "history_alert_fires_above_seconds": ga.HISTORY_P95_LIMIT_S,
        "history_alert_minimum_loads": ga.HISTORY_MIN_LOADS,
        "note": "null means no data: no traffic in the window, which is not an outage",
    }


def _rounded(value: float | None) -> int | None:
    return None if value is None else round(value)


# --- Alert states ---------------------------------------------------------------------


def alert_states(env: str) -> dict[str, dict[str, Any]]:
    """The env's rules, by alert name: state, health, last error, active since."""
    found = get("/api/prometheus/grafana/api/v1/rules")
    states: dict[str, dict[str, Any]] = {}
    for group in (found or {}).get("data", {}).get("groups", []):
        if group.get("name") != ga.group_name(env):
            continue
        for rule in group.get("rules", []):
            name = (rule.get("labels") or {}).get("alert", rule.get("name"))
            active = [
                a["activeAt"]
                for a in rule.get("alerts") or []
                if a.get("activeAt") and ga.normalised(str(a.get("state", ""))) != "normal"
            ]
            states[name] = {
                "state": ga.normalised(str(rule.get("state", "unknown"))),
                "health": rule.get("health"),
                "last_error": rule.get("lastError") or None,
                "active_since": min(active) if active else None,
            }
    return states


def wait(alert: str, env: str, state: str, minutes: float, poll_s: float = 30) -> bool:
    """Wait until the rule reaches `state`; one line per change. False on timeout."""
    deadline = time.monotonic() + minutes * 60
    last = None
    while True:
        try:
            current = alert_states(env).get(alert, {}).get("state", "missing")
        except GrafanaError as e:
            current = f"unreadable ({_cut(str(e))})"
        if current != last:
            print(f"{time.strftime('%H:%M:%SZ', time.gmtime())}  {alert} ({env}): {current}")
            sys.stdout.flush()
            last = current
        if current == state:
            return True
        if time.monotonic() > deadline:
            return False
        time.sleep(poll_s)


# --- Logs -----------------------------------------------------------------------------


def logs(query: str, minutes: int = 30, limit: int = 20) -> list[str]:
    """The newest log lines first, as `<UTC time>  <line>`."""
    now = time.time_ns()
    params = {
        "query": query,
        "start": str(now - minutes * 60 * 10**9),
        "end": str(now),
        "limit": str(limit),
        "direction": "backward",
    }
    found = get(f"{_proxy('logs')}/loki/api/v1/query_range", params)
    if not isinstance(found, dict) or found.get("status") != "success":
        raise GrafanaError(f"query refused: {_cut(json.dumps(found))}")
    entries: list[tuple[int, str]] = []
    for stream in (found.get("data") or {}).get("result") or []:
        labels = stream.get("stream") or {}
        # Only these labels: exception_message and the stack trace can quote input.
        extra = "".join(f"  {k}={labels[k]}" for k in LOG_LABELS if labels.get(k))
        for ts, line in stream.get("values") or []:
            entries.append((int(ts), f"{line}{extra}"))
    entries.sort(reverse=True)
    return [f"{_utc(ts)}  {_cut(line)}" for ts, line in entries[:limit]]


def _utc(ns: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ns / 10**9))


def error_logs_query(env: str) -> str:
    return g._logs(env)


# --- Traces ---------------------------------------------------------------------------


def traces(query: str, minutes: int = 30, limit: int = 10) -> list[str]:
    """Matching traces, one line each: id, start, duration, root span."""
    now = int(time.time())
    params = {"q": query, "start": str(now - minutes * 60), "end": str(now), "limit": str(limit)}
    found = get(f"{_proxy('traces')}/api/search", params) or {}
    lines = []
    for t in found.get("traces") or []:
        start = int(t.get("startTimeUnixNano") or 0)
        lines.append(
            f"{t.get('traceID')}  {_utc(start)}  {t.get('durationMs', '?')} ms  "
            f"{_cut(str(t.get('rootTraceName', '')))}"
        )
    return lines


def failed_query(env: str) -> str:
    return g._traceql(env, 'status=error && span.http.route=~"/api/(sessions|history).*"')


def slow_query(env: str) -> str:
    return g._traceql(env, 'duration > 1s && span.http.route=~"/api/(sessions|history).*"')


def _value(v: dict[str, Any]) -> Any:
    for key in ("stringValue", "intValue", "doubleValue", "boolValue"):
        if key in v:
            return v[key]
    return None


def trace(trace_id: str) -> list[str]:
    """One line per span: name, status, duration and the allowlisted attributes."""
    if not TRACE_ID.fullmatch(trace_id):
        raise GrafanaError("a trace ID is 32 lowercase hex characters")
    found = get(f"{_proxy('traces')}/api/traces/{trace_id}") or {}
    lines = []
    for batch in found.get("batches") or found.get("resourceSpans") or []:
        resource = {
            a["key"]: _value(a.get("value") or {})
            for a in (batch.get("resource") or {}).get("attributes") or []
        }
        for scope in batch.get("scopeSpans") or batch.get("instrumentationLibrarySpans") or []:
            for span in scope.get("spans") or []:
                attrs = {
                    a["key"]: _value(a.get("value") or {}) for a in span.get("attributes") or []
                }
                attrs.update({k: v for k, v in resource.items() if k == "service.version"})
                for event in span.get("events") or []:
                    for a in event.get("attributes") or []:
                        if a.get("key") == "exception.type":
                            attrs["exception.type"] = _value(a.get("value") or {})
                kept = {k: attrs[k] for k in SPAN_ATTRIBUTES if k in attrs}
                start, end = (
                    int(span.get("startTimeUnixNano", 0)),
                    int(span.get("endTimeUnixNano", 0)),
                )
                status = (span.get("status") or {}).get("code", "")
                lines.append(
                    _cut(
                        f"{_utc(start)}  {(end - start) / 1e6:.1f} ms  {span.get('name')}  "
                        f"status={status or 'unset'}  {json.dumps(kept, sort_keys=True)}"
                    )
                )
    return lines


# --- CLI ------------------------------------------------------------------------------


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="oncall_grafana.py", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("journey").add_argument("env", choices=ENVS)
    sub.add_parser("alerts").add_argument("env", choices=ENVS)
    w = sub.add_parser("wait")
    w.add_argument("alert", choices=ALERTS)
    w.add_argument("env", choices=ENVS)
    w.add_argument("state", choices=("normal", "pending", "firing"))
    w.add_argument("--minutes", type=float, default=20)
    for name, default_limit in (("errors", 20), ("failed", 10), ("slow", 10)):
        s = sub.add_parser(name)
        s.add_argument("env", choices=ENVS)
        s.add_argument("--minutes", type=int, default=30)
        s.add_argument("--limit", type=int, default=default_limit)
    sub.add_parser("trace").add_argument("trace_id")
    q = sub.add_parser("prom")
    q.add_argument("query")
    q.add_argument("--minutes", type=int, default=0)
    q.add_argument("--step", type=int, default=60)
    for name, default_limit in (("logs", 20), ("traces", 10)):
        s = sub.add_parser(name)
        s.add_argument("query")
        s.add_argument("--minutes", type=int, default=30)
        s.add_argument("--limit", type=int, default=default_limit)
    return p


def main(argv: list[str]) -> int:
    args = _parser().parse_args(argv)
    limit = min(getattr(args, "limit", 0) or 0, 100)
    minutes = min(getattr(args, "minutes", 0) or 0, 7 * 24 * 60)
    try:
        if args.command == "journey":
            print(json.dumps(journey(args.env), indent=2))
        elif args.command == "alerts":
            print(json.dumps(alert_states(args.env), indent=2, sort_keys=True))
        elif args.command == "wait":
            return 0 if wait(args.alert, args.env, args.state, args.minutes) else 1
        elif args.command == "errors":
            print("\n".join(logs(error_logs_query(args.env), int(minutes), limit)) or "no lines")
        elif args.command in ("failed", "slow"):
            query = failed_query(args.env) if args.command == "failed" else slow_query(args.env)
            print("\n".join(traces(query, int(minutes), limit)) or "no traces")
        elif args.command == "trace":
            print("\n".join(trace(args.trace_id)) or "no spans")
        elif args.command == "prom":
            series = prom(args.query, int(minutes), args.step)
            for s in series[:50]:
                print(_cut(json.dumps(s, sort_keys=True)))
            print(f"{len(series)} series" if series else "no data")
        elif args.command == "logs":
            print("\n".join(logs(args.query, int(minutes), limit)) or "no lines")
        elif args.command == "traces":
            print("\n".join(traces(args.query, int(minutes), limit)) or "no traces")
    except GrafanaError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
