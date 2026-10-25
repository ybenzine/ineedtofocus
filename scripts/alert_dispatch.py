#!/usr/bin/env python3
"""The alert dispatch (#34): what Grafana sends GitHub when an alert fires or resolves.

    python3 scripts/alert_dispatch.py check-event "$GITHUB_EVENT_PATH"
        # the on-call workflow (.github/workflows/oncall.yml): validate the
        # repository_dispatch event, print it, write a job summary; exit 1 if invalid
    python3 scripts/alert_dispatch.py check <request.json> [--local [<grafana url>]]
        # validate a request body (`event_type` + `client_payload`), e.g. a rendered template
    python3 scripts/alert_dispatch.py receive [--port 8765] [--out <file.jsonl>]
        # the local drill: a stand-in for GitHub's dispatch endpoint that the local Grafana's
        # contact point posts to (scripts/alert_routing.py apply local). It requires the
        # bearer token it prints at start, validates every dispatch and answers 204 like
        # GitHub, or 422 with the problems

Grafana's webhook contact point posts straight to GitHub's REST API,
`POST /repos/ybenzine/ineedtofocus/dispatches`, with a token that only Grafana Cloud holds
(_docs/observability.md, "Alert routing"). GitHub turns it into a `repository_dispatch`
event of type `grafana-alert` whose `client_payload` is the contract below; #35's on-call
agent reads the same fields.

    {"event_type": "grafana-alert",
     "client_payload": {
       "alert": "session-save-errors" | "history-latency",   # the rule's `alert` label
       "environment": "prod" | "dev",
       "status": "firing" | "resolved",
       "title": "Session saves failing (prod)",              # the rule's title
       "summary": "...", "description": "...",               # the rule's annotations
       "started_at": "2026-10-25T08:37:51Z",
       "resolved_at": "" | "2026-10-25T08:43:46Z",           # empty while firing
       "links": {"dashboard": ..., "traces": ..., "runbook": ..., "alert": ...}}}

Every field is required and nothing else is allowed: an unexpected field is how customer
data would sneak in, so it fails the check. The text never holds an email address or a
YouTube link (AGENTS.md, telemetry privacy). The payload is untrusted input: whoever holds
a token with write access to the repo can send one, so a consumer passes it through
environment variables and files, never `${{ }}` in a script. Stdlib only.
"""

from __future__ import annotations

import contextlib
import hmac
import http.server
import json
import os
import re
import secrets
import sys
import urllib.parse
from collections.abc import Sequence
from pathlib import Path
from typing import Any

EVENT_TYPE = "grafana-alert"
REPOSITORY = "ybenzine/ineedtofocus"
DISPATCH_PATH = f"/repos/{REPOSITORY}/dispatches"
ALERTS = ("session-save-errors", "history-latency")
STATUSES = ("firing", "resolved")
DEPLOYED = ("prod", "dev")
GRAFANA_CLOUD = "https://ineedtofocus.grafana.net/"
LOCAL_GRAFANA = "http://localhost:3000/"  # grafana/otel-lgtm's root URL, whatever the port
RUNBOOKS = f"https://github.com/{REPOSITORY}/blob/main/_docs/runbooks/"
RUNBOOK_INDEX = f"{RUNBOOKS}README.md"  # linked while an alert's runbook isn't written yet
FIELDS = (
    "alert",
    "environment",
    "status",
    "title",
    "summary",
    "description",
    "started_at",
    "resolved_at",
    "links",
)
LINKS = ("dashboard", "traces", "runbook", "alert")
MAX_LENGTH = {"title": 200, "summary": 500, "description": 2000}
MAX_LINK = 4000
# GitHub allows at most 10 top-level properties in client_payload.
assert len(FIELDS) <= 10
TIMESTAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
YOUTUBE = re.compile(r"youtube\.com|youtu\.be|youtube-nocookie\.com", re.IGNORECASE)
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def problems(
    payload: Any,
    *,
    grafana: str = GRAFANA_CLOUD,
    environments: Sequence[str] = DEPLOYED,
) -> list[str]:
    """What's wrong with a `client_payload` (empty: nothing). `grafana` is the Grafana the
    links must point into, `environments` the environments it may come from."""
    if not isinstance(payload, dict):
        return ["client_payload is not an object"]
    found: list[str] = []
    missing = [f for f in FIELDS if f not in payload]
    extra = sorted(set(payload) - set(FIELDS))
    if missing:
        found.append(f"missing fields: {', '.join(missing)}")
    if extra:
        found.append(f"unexpected fields: {', '.join(extra)}")
    for name in FIELDS:
        if name != "links" and name in payload and not isinstance(payload[name], str):
            found.append(f"{name} is not a string")
    if found:
        return found

    alert, env, status = payload["alert"], payload["environment"], payload["status"]
    if alert not in ALERTS:
        found.append(f"alert {alert!r} is not one of {', '.join(ALERTS)}")
    if env not in environments:
        found.append(f"environment {env!r} is not one of {', '.join(environments)}")
    if status not in STATUSES:
        found.append(f"status {status!r} is not one of {', '.join(STATUSES)}")
    for name, limit in MAX_LENGTH.items():
        if not payload[name].strip():
            found.append(f"{name} is empty")
        elif len(payload[name]) > limit:
            found.append(f"{name} is longer than {limit} characters")
    if not TIMESTAMP.fullmatch(payload["started_at"]):
        found.append(f"started_at {payload['started_at']!r} is not a UTC timestamp")
    resolved_at = payload["resolved_at"]
    if status == "resolved" and not TIMESTAMP.fullmatch(resolved_at):
        found.append(f"resolved_at {resolved_at!r} is not a UTC timestamp, but status is resolved")
    if status == "firing" and resolved_at:
        found.append("resolved_at is set, but status is firing")

    links = payload["links"]
    if not isinstance(links, dict) or set(links) != set(LINKS):
        found.append(f"links must have exactly: {', '.join(LINKS)}")
    elif not all(isinstance(v, str) for v in links.values()):
        found.append("links are not all strings")
    else:
        expected = {
            "dashboard": f"{grafana}d/focus-key-journey-{env}?",
            "traces": f"{grafana}explore?",
            "alert": f"{grafana}alerting/",
        }
        for name, prefix in expected.items():
            link = links[name]
            if not link.startswith(prefix):
                found.append(f"links.{name} {link[:120]!r} does not start with {prefix}")
            elif len(link) > MAX_LINK:
                found.append(f"links.{name} is longer than {MAX_LINK} characters")
        # The alert's own runbook, or the index while it isn't written yet.
        runbooks = (f"{RUNBOOKS}{alert}.md", RUNBOOK_INDEX)
        if links["runbook"] not in runbooks:
            found.append(f"links.runbook {links['runbook'][:120]!r} is not {' or '.join(runbooks)}")

    for name, text in _texts(payload):
        if CONTROL.search(text):
            found.append(f"{name} holds control characters")
        if EMAIL.search(text):
            found.append(f"{name} holds an email address (no customer data in alerts)")
        if YOUTUBE.search(text):
            found.append(f"{name} holds a YouTube link (no customer data in alerts)")
    return found


def _texts(payload: dict[str, Any]) -> list[tuple[str, str]]:
    texts = [(k, v) for k, v in payload.items() if isinstance(v, str)]
    links = payload.get("links")
    if isinstance(links, dict):
        texts += [
            (f"links.{k}", urllib.parse.unquote_plus(v))
            for k, v in links.items()
            if isinstance(v, str)
        ]
    return texts


def request_problems(body: Any, **kwargs: Any) -> list[str]:
    """Problems with a dispatch request body, as Grafana sends it to GitHub."""
    if not isinstance(body, dict) or set(body) != {"event_type", "client_payload"}:
        return ["the body must have exactly event_type and client_payload"]
    if body["event_type"] != EVENT_TYPE:
        return [f"event_type {body['event_type']!r} is not {EVENT_TYPE}"]
    return problems(body["client_payload"], **kwargs)


def event_problems(event: Any) -> list[str]:
    """Problems with the repository_dispatch event GitHub hands the workflow."""
    if not isinstance(event, dict):
        return ["the event is not an object"]
    if event.get("action") != EVENT_TYPE:
        return [f"event type {event.get('action')!r} is not {EVENT_TYPE}"]
    return problems(event.get("client_payload"))


def _cell(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def summary(payload: dict[str, Any], sender: str | None = None) -> str:
    """A job summary in Markdown. Only call it on a payload that passed the check."""
    links = payload["links"]
    rows = [
        ("Alert", f"`{payload['alert']}`: {_cell(payload['title'])}"),
        ("Environment", f"`{payload['environment']}`"),
        ("Status", f"**{payload['status']}**"),
        ("Started", payload["started_at"]),
        ("Resolved", payload["resolved_at"] or "not yet"),
        ("Summary", _cell(payload["summary"])),
        ("Description", _cell(payload["description"])),
        (
            "Links",
            f"[dashboard]({links['dashboard']}) · [traces]({links['traces']}) · "
            f"[runbook]({links['runbook']}) · [alert rule]({links['alert']})",
        ),
    ]
    if sender:
        rows.append(("Sent by", f"`{_cell(sender)}`"))
    lines = ["### Alert dispatch", "", "| | |", "|---|---|"]
    lines += [f"| {k} | {v} |" for k, v in rows]
    return "\n".join(lines) + "\n"


def check_event(path: str) -> int:
    event = json.loads(Path(path).read_text())
    payload = event.get("client_payload") if isinstance(event, dict) else None
    found = event_problems(event)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    # Printed as indented JSON, so no line of the payload can start with `::` and be read
    # as a workflow command.
    print(json.dumps(payload, indent=2, sort_keys=True))
    if found:
        for problem in found:
            print(f"::error title=Invalid alert dispatch::{json.dumps(problem)}")
        if step_summary:
            with open(step_summary, "a") as f:
                f.write("### Alert dispatch: invalid\n\n")
                f.writelines(f"- {_cell(p)}\n" for p in found)
        return 1
    sender = (event.get("sender") or {}).get("login")
    assert isinstance(payload, dict)
    if step_summary:
        with open(step_summary, "a") as f:
            f.write(summary(payload, sender))
    print(
        f"ok    {payload['alert']} {payload['status']} in {payload['environment']}"
        f" (sent by {sender})"
    )
    return 0


# --- The local drill: a stand-in for GitHub's dispatch endpoint --------------------------


class _Receiver(http.server.BaseHTTPRequestHandler):
    token = ""
    grafana = LOCAL_GRAFANA
    out: Path | None = None

    def _answer(self, code: int, body: dict[str, Any] | None = None) -> None:
        raw = b"" if body is None else json.dumps(body).encode()
        self.send_response(code)
        if raw:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:
        if self.path != DISPATCH_PATH:
            self._answer(404, {"message": "Not Found"})
            return
        given = self.headers.get("Authorization", "")
        if not hmac.compare_digest(given.encode(), f"Bearer {self.token}".encode()):
            print("401   a request without the right bearer token", flush=True)
            self._answer(401, {"message": "Requires authentication"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as e:
            self._answer(400, {"message": f"Problems parsing JSON: {e}"})
            return
        found = request_problems(body, grafana=self.grafana, environments=("local",))
        payload = body.get("client_payload") if isinstance(body, dict) else None
        record = {
            "headers": {h: self.headers.get(h) for h in ("Accept", "Content-Type", "User-Agent")},
            "body": body,
            "problems": found,
        }
        if self.out:
            with self.out.open("a") as f:
                f.write(json.dumps(record) + "\n")
        if found:
            print(f"422   invalid dispatch: {'; '.join(found)}", flush=True)
            self._answer(422, {"message": "Invalid alert dispatch", "problems": found})
            return
        assert isinstance(payload, dict)
        print(
            f"204   {payload['alert']} {payload['status']} in {payload['environment']}"
            f" (started {payload['started_at']}, resolved {payload['resolved_at'] or '-'})",
            flush=True,
        )
        self._answer(204)

    def log_message(self, format: str, *args: Any) -> None:
        pass  # one line per dispatch above instead


def receiver(
    port: int, token: str, out: Path | None = None, grafana: str = LOCAL_GRAFANA
) -> http.server.ThreadingHTTPServer:
    """The stand-in, bound to 127.0.0.1 (Docker Desktop's host.docker.internal reaches it)."""
    handler = type("Receiver", (_Receiver,), {"token": token, "grafana": grafana, "out": out})
    return http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)


def receive(port: int, out: Path | None, grafana: str) -> None:
    # A throwaway value for this local stand-in only, never a GitHub token.
    token = secrets.token_urlsafe(24)
    server = receiver(port, token, out, grafana)
    print(f"stand-in token (local drill only): {token}")
    print(f"listening on http://127.0.0.1:{server.server_port}{DISPATCH_PATH}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


def _option(argv: list[str], name: str) -> str | None:
    if name in argv:
        at = argv.index(name)
        if at + 1 >= len(argv):
            raise SystemExit(f"{name} needs a value")
        value = argv[at + 1]
        del argv[at : at + 2]
        return value
    return None


def main(argv: list[str]) -> int:
    argv = list(argv)
    command = argv.pop(0) if argv else ""
    if command == "check-event" and len(argv) == 1:
        return check_event(argv[0])
    if command == "check" and argv and argv[0] != "--local":
        body = json.loads(Path(argv[0]).read_text())
        if argv[1:2] == ["--local"]:
            grafana = argv[2] if len(argv) > 2 else LOCAL_GRAFANA
            found = request_problems(body, grafana=grafana, environments=("local",))
        elif len(argv) == 1:
            found = request_problems(body)
        else:
            print(__doc__, file=sys.stderr)
            return 2
        for problem in found:
            print(f"FAIL  {problem}", file=sys.stderr)
        if not found:
            print("ok    a valid alert dispatch")
        return 1 if found else 0
    if command == "receive":
        port = int(_option(argv, "--port") or 8765)
        out = _option(argv, "--out")
        grafana = _option(argv, "--grafana") or LOCAL_GRAFANA
        if argv:
            print(__doc__, file=sys.stderr)
            return 2
        receive(port, Path(out) if out else None, grafana)
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
