#!/usr/bin/env python3
"""Check the running local stack (`make up`): app health, frontend, sign-in, telemetry in Grafana.

    make check-stack                      # or: python3 scripts/check_local_stack.py

1. GET /healthz and /readyz answer 200 and / serves the built frontend.
   Signs up a throwaway account: the session cookie must not be `Secure` (the local stack
   is plain http, where browsers and curl drop Secure cookies; #79), and it must sign in.
2. Sends a request (unique path) whose query string and cookie carry a secret marker.
3. Polls Grafana (from grafana/otel-lgtm) until it has, for service `ineedtofocus`:
   traces (Tempo), metrics (Prometheus) and logs (Loki).
4. Fails if the marker shows up in the probe's trace or in any log line or log attribute
   from the last hour, or if any log carries an unredacted Postgres `DETAIL: Key (...)`
   line: query strings, cookies and row values must never reach telemetry
   (_docs/observability.md).

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


def setting(name: str, default: str) -> str:
    """Like Compose: the environment wins, then the repo's .env, then the default."""
    if name in os.environ:
        return os.environ[name]
    env_file = Path(__file__).resolve().parents[1] / ".env"
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() == name:
                return value.strip().strip("\"'")
    return default


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


def post_json(url: str, payload: dict[str, str]) -> tuple[int, list[str], str]:
    """POST a JSON body; returns the status, the Set-Cookie headers and the body."""
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
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


def check_sign_up() -> None:
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
    check_sign_up()

    # The path identifies this run's trace; the marker is the secret that must not leak.
    probe_path = f"/api/stack-check-{uuid.uuid4().hex[:12]}"
    marker = f"secret{uuid.uuid4().hex}"
    since = int(time.time()) - 60
    get(
        f"{APP}{probe_path}?email={marker}%40example.com",
        {"Cookie": f"session={marker}"},
    )

    def traces() -> list[str]:
        """This run's probe trace (a JSON 404, traced like any request)."""
        q = f'{{resource.service.name="{SERVICE}" && span.url.path="{probe_path}"}}'
        found = get_json(
            f"{PROXY}/tempo/api/search",
            q=q,
            start=str(since),
            end=str(int(time.time()) + 5),
            limit="50",
        )
        return [t["traceID"] for t in found.get("traces", [])]

    poll("traces in Tempo (the probe request)", lambda: len(traces()) > 0)
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
    redacted = False
    for trace_id in traces():
        _, body = get(f"{PROXY}/tempo/api/traces/{trace_id}")
        if marker in body:
            leaks.append(f"trace {trace_id}")
        redacted = redacted or "REDACTED" in body
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
        sys.exit(f"FAIL  query string or cookie reached telemetry: {', '.join(leaks)}")
    if not redacted:
        sys.exit("FAIL  the probe's trace has no redacted query string")
    print("ok    no query string or cookie in traces or logs (url.query is REDACTED)")


if __name__ == "__main__":
    main()
