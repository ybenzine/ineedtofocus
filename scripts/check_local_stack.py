#!/usr/bin/env python3
"""Check the running local stack (`make up`): app health, frontend, sign-in, telemetry in Grafana.

    make check-stack                      # or: python3 scripts/check_local_stack.py

1. GET /healthz and /readyz answer 200 and / serves the built frontend.
   Signs up a throwaway account: the session cookie must not be `Secure` (the local stack
   is plain http, where browsers and curl drop Secure cookies; #79), and it must sign in.
2. Sends a request (unique path) whose query string and cookie carry a secret marker, with a
   `traceparent` header of a known trace ID, as the browser does. The trace is fetched from
   Tempo by that ID.
3. Saves a session the way the browser does (a sync batch, with its own `traceparent`) and
   checks that the three signals link up (#31): the trace has the request and its database
   spans, Loki has the app's log line for that same `trace_id`, and Prometheus holds an
   exemplar of the save-latency histogram pointing at that trace ID. Then loads history
   once, so the history metrics have data for steps 6 and 7.
4. Polls Grafana (from grafana/otel-lgtm) until it has, for service `ineedtofocus`:
   traces (Tempo), metrics (Prometheus) and logs (Loki).
5. Fails if the marker or the probe's raw path shows up in the probe's trace or in any log
   line or log attribute from the last hour, or if any log carries an unredacted Postgres
   `DETAIL: Key (...)` line: query strings, cookies, paths and row values must never reach
   telemetry (_docs/observability.md). An unmatched path is exported as `UNMATCHED`.
6. The key-journey dashboard (#32) is provisioned in Grafana and every one of its queries
   runs against Prometheus, Loki and Tempo; each metrics query returns data, so a renamed
   metric or label can't blank a panel silently (scripts/grafana_dashboards.py verify).
7. The user-impact alert rules (#33) are provisioned, Grafana evaluates them without
   errors, their queries run and every metric they query has series
   (scripts/grafana_alerts.py verify).

Ports: APP_PORT (8000) and GRAFANA_PORT (3000), from the environment or .env. Stdlib only.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import grafana_alerts
import grafana_dashboards

ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


def setting(name: str, default: str, env_file: Path = ENV_FILE) -> str:
    """Like Compose: the environment wins, then the repo's .env (its last line for the name),
    then the default. Takes `NAME=value` and `export NAME=value` alike, as Compose's .env
    parser does (#188).
    """
    if name in os.environ:
        return os.environ[name]
    found = default
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and key.split() in ([name], ["export", name]):
                found = value.strip().strip("\"'")
    return found


SERVICE = "ineedtofocus"
SESSION_COOKIE = "focus_session"  # backend/app/deps.py
APP = f"http://localhost:{setting('APP_PORT', '8000')}"
GRAFANA = f"http://localhost:{setting('GRAFANA_PORT', '3000')}"
PROXY = f"{GRAFANA}/api/datasources/proxy/uid"
# Postgres quotes row values in DETAIL lines (e.g. an email); the app redacts them.
UNSCRUBBED_DETAIL = re.compile(r"DETAIL:\s+Key \(")
TIMEOUT_S = float(os.environ.get("CHECK_TIMEOUT_SECONDS", "90"))


def get(url: str, headers: dict[str, str] | None = None) -> tuple[int, str]:
    req = urllib.request.Request(url, headers=headers or {})  # GET
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def post_json(
    url: str, payload: dict[str, Any], headers: dict[str, str] | None = None
) -> tuple[int, list[str], str]:
    """POST a JSON body; returns the status, the Set-Cookie headers and the body."""
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.headers.get_all("Set-Cookie") or [], r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get_all("Set-Cookie") or [], e.read().decode()


def find_cookie(set_cookies: list[str], name: str) -> tuple[str, set[str]] | None:
    """The named cookie in Set-Cookie headers: (value, lower-cased attribute names)."""
    for header in set_cookies:
        first, *attrs = header.split(";")
        key, sep, value = first.partition("=")
        if sep and key.strip() == name:
            return value.strip(), {a.split("=", 1)[0].strip().lower() for a in attrs}
    return None


def check_sign_up() -> str:
    """Sign up a throwaway account over plain http and use its session cookie."""
    email = f"stack-check-{uuid.uuid4().hex[:12]}@example.com"
    status, set_cookies, body = post_json(
        f"{APP}/api/auth/signup", {"email": email, "password": uuid.uuid4().hex}
    )
    if status != 201:
        sys.exit(f"FAIL  POST /api/auth/signup -> {status}: {body[:200]}")
    cookie = find_cookie(set_cookies, SESSION_COOKIE)
    if cookie is None:
        sys.exit(f"FAIL  POST /api/auth/signup set no {SESSION_COOKIE} cookie")
    token, attrs = cookie
    if "secure" in attrs:
        sys.exit(
            f"FAIL  the {SESSION_COOKIE} cookie is Secure, which plain http drops: "
            "the local app needs COOKIE_SECURE=0 (compose.yaml)"
        )
    print(f"ok    POST /api/auth/signup -> 201, {SESSION_COOKIE} cookie not Secure")
    status, _ = get(f"{APP}/api/auth/me", {"Cookie": f"{SESSION_COOKIE}={token}"})
    if status != 200:
        sys.exit(f"FAIL  GET /api/auth/me with the sign-up cookie -> {status}")
    print("ok    GET /api/auth/me with that cookie -> 200 (signed in over http)")
    return token


def get_json(url: str, **params: str) -> Any:
    status, body = get(f"{url}?{urllib.parse.urlencode(params)}" if params else url)
    if status != 200:
        raise RuntimeError(f"{url} -> {status}: {body[:200]}")
    return json.loads(body)


def poll(what: str, check: Callable[[], bool]) -> None:
    deadline = time.monotonic() + TIMEOUT_S
    while True:
        try:
            if check():
                print(f"ok    {what}")
                return
        except (RuntimeError, OSError, KeyError, ValueError):
            pass
        if time.monotonic() > deadline:
            sys.exit(f"FAIL  {what}: nothing after {TIMEOUT_S:.0f}s")
        time.sleep(3)


def main() -> None:
    for path in ("/healthz", "/readyz"):
        status, body = get(APP + path)
        if status != 200:
            sys.exit(f"FAIL  GET {path} -> {status}: {body[:200]}")
        print(f"ok    GET {path} -> 200")
    status, body = get(APP + "/")
    if status != 200 or "<html" not in body.lower():
        sys.exit(f"FAIL  GET / did not serve the frontend ({status})")
    print("ok    GET / serves the frontend")
    token = check_sign_up()

    # The marker is the secret that must not leak; the trace ID (sent as the browser does)
    # identifies this run's trace, since the path is no longer exported.
    probe_path = f"/api/stack-check-{uuid.uuid4().hex[:12]}"
    marker = f"secret{uuid.uuid4().hex}"
    probe_trace = uuid.uuid4().hex
    since = int(time.time()) - 60
    get(
        f"{APP}{probe_path}?email={marker}%40example.com",
        {
            "Cookie": f"session={marker}",
            "traceparent": f"00-{probe_trace}-{uuid.uuid4().hex[:16]}-01",
        },
    )

    def trace_body(trace_id: str) -> str:
        status, body = get(f"{PROXY}/tempo/api/traces/{trace_id}")
        if status != 200 or "spans" not in body:
            raise RuntimeError(f"trace {trace_id} not in Tempo yet ({status})")
        return body

    poll(
        "traces in Tempo (the probe request, found by its trace ID)",
        lambda: bool(trace_body(probe_trace)),
    )

    # The key journey: a save, as the browser's sync queue sends it, in one trace.
    journey_trace = uuid.uuid4().hex
    session = {
        "id": str(uuid.uuid4()),
        "mode": "countdown",
        "tag": "work",
        "goal": f"goal-{marker}",
        "started_at": "2026-10-23T09:00:00Z",
        "ended_at": "2026-10-23T09:25:30Z",
        "focus_seconds": 1500,
        "paused_seconds": 30,
        "status": "completed",
        "mode_config": {"mode": "countdown", "minutes": 25},
        "blocks_completed": 0,
    }
    status, _, body = post_json(
        f"{APP}/api/sessions/sync",
        {"sessions": [session]},
        {
            "Cookie": f"{SESSION_COOKIE}={token}",
            "traceparent": f"00-{journey_trace}-{uuid.uuid4().hex[:16]}-01",
        },
    )
    if status != 200 or '"created":1' not in body.replace(" ", ""):
        sys.exit(f"FAIL  POST /api/sessions/sync -> {status}: {body[:200]}")
    print("ok    POST /api/sessions/sync saved a session")
    cookie = {"Cookie": f"{SESSION_COOKIE}={token}"}
    status, body = get(f"{APP}/api/history?view=all&tz=UTC", cookie)
    if status != 200 or '"session_count":1' not in body.replace(" ", ""):
        sys.exit(f"FAIL  GET /api/history -> {status}: {body[:200]}")
    print("ok    GET /api/history loads the saved session")

    def journey_has_database_spans() -> bool:
        body = trace_body(journey_trace)
        return "/api/sessions/sync" in body and "db.statement" in body

    poll("the save is one trace: the request and its database spans", journey_has_database_spans)

    def log_for_trace() -> bool:
        found = get_json(
            f"{PROXY}/loki/loki/api/v1/query_range",
            query=f'{{service_name="{SERVICE}"}} | trace_id="{journey_trace}"',
            since="1h",
            limit="5",
        )["data"]["result"]
        return any(v[1] == "sessions synced" for stream in found for v in stream["values"])

    poll("logs link to the trace: Loki has the save's log line with its trace_id", log_for_trace)

    def exemplar_for_trace() -> bool:
        found = get_json(
            f"{PROXY}/prometheus/api/v1/query_exemplars",
            query="focus_session_save_duration_seconds_bucket",
            start=str(since),
            end=str(int(time.time()) + 5),
        )["data"]
        return any(
            e["labels"].get("trace_id") == journey_trace
            for series in found
            for e in series["exemplars"]
        )

    poll(
        "metrics link to the trace: an exemplar of the save latency has its trace_id",
        exemplar_for_trace,
    )
    poll(
        "metrics in Prometheus",
        lambda: bool(
            get_json(
                f"{PROXY}/prometheus/api/v1/query",
                query=f'count({{service_name="{SERVICE}", __name__=~"http_server_.*"}})',
            )["data"]["result"]
        ),
    )
    poll(
        "logs in Loki",
        lambda: bool(
            get_json(
                f"{PROXY}/loki/loki/api/v1/query_range",
                query=f'{{service_name="{SERVICE}"}}',
                since="1h",
                limit="5",
            )["data"]["result"]
        ),
    )

    leaks = []
    probe = trace_body(probe_trace)
    journey = trace_body(journey_trace)
    for name, body in (("probe trace", probe), ("save trace", journey)):
        # The raw path (exported as UNMATCHED instead), the query marker, the goal.
        if probe_path in body or marker in body:
            leaks.append(name)
    if "UNMATCHED" not in probe:
        sys.exit("FAIL  the probe's unmatched path is not exported as UNMATCHED")
    if "REDACTED" not in probe:
        sys.exit("FAIL  the probe's trace has no redacted query string")
    if token in journey:
        leaks.append("save trace (session cookie)")
    # All of the service's recent log lines, no line filter: a `|= "..."` filter only
    # matches the body, and a leak can sit in attributes (structured metadata such as
    # exception_message / exception_stacktrace), which Loki returns with each stream.
    logs = json.dumps(
        get_json(
            f"{PROXY}/loki/loki/api/v1/query_range",
            query=f'{{service_name="{SERVICE}"}}',
            since="1h",
            limit="5000",
        )["data"]["result"]
    )
    if marker in logs:
        leaks.append("logs (this run's marker)")
    if UNSCRUBBED_DETAIL.search(logs):
        leaks.append("logs (an unredacted Postgres 'DETAIL: Key (...)' line)")
    if leaks:
        sys.exit(f"FAIL  query string, path, goal or cookie reached telemetry: {', '.join(leaks)}")
    print(
        "ok    no query string, path, goal or cookie in traces or logs "
        "(url.query is REDACTED, an unmatched url.path is UNMATCHED)"
    )

    problems = grafana_dashboards.verify(GRAFANA, wait_s=TIMEOUT_S)
    if problems:
        sys.exit("FAIL  key-journey dashboard: " + "; ".join(problems))
    print(
        f"ok    dashboard {grafana_dashboards.uid('local')} is provisioned, its queries run "
        "and every metrics query returns data"
    )
    problems = grafana_alerts.verify(GRAFANA, wait_s=TIMEOUT_S)
    if problems:
        sys.exit("FAIL  alert rules: " + "; ".join(problems))
    print(
        f"ok    alert rules {grafana_alerts.group_name('local')} are provisioned, evaluate "
        "without errors and the metrics they query have series"
    )


if __name__ == "__main__":
    main()
