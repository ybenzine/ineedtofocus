"""The alert dispatch contract (#34): what Grafana sends GitHub and the on-call workflow
checks. scripts/alert_dispatch.py; `make check-stack` renders the real template against it."""

from __future__ import annotations

import copy
import http.client
import json
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import alert_dispatch as d
import pytest

GRAFANA = d.GRAFANA_CLOUD


def payload(**changes: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "alert": "session-save-errors",
        "environment": "prod",
        "status": "firing",
        "title": "Session saves failing (prod)",
        "summary": "Over 5% of session saves are failing in prod",
        "description": "19.67% of the 65 sessions submitted in the last 5 minutes failed",
        "started_at": "2026-10-25T08:37:51Z",
        "resolved_at": "",
        "links": {
            "dashboard": f"{GRAFANA}d/focus-key-journey-prod?orgId=1&from=1&to=now",
            "traces": f"{GRAFANA}explore?schemaVersion=1&orgId=1&panes=%7B%7D",
            "runbook": f"{d.RUNBOOKS}session-save-errors.md",
            "alert": f"{GRAFANA}alerting/grafana/focus-session-save-errors-prod/view?orgId=1",
        },
    }
    base.update(changes)
    return base


def test_a_valid_payload_passes() -> None:
    assert d.problems(payload()) == []
    resolved = payload(status="resolved", resolved_at="2026-10-25T08:43:46Z")
    assert d.problems(resolved) == []


def test_the_contract_fits_githubs_limit() -> None:
    """GitHub accepts at most 10 top-level properties in client_payload."""
    assert len(d.FIELDS) <= 10
    assert set(payload()) == set(d.FIELDS)


@pytest.mark.parametrize("field", d.FIELDS)
def test_every_field_is_required(field: str) -> None:
    broken = payload()
    del broken[field]
    assert d.problems(broken) == [f"missing fields: {field}"]


def test_nothing_else_is_allowed() -> None:
    """An unexpected field is how customer data would get in."""
    assert d.problems(payload(user="someone")) == ["unexpected fields: user"]


@pytest.mark.parametrize(
    ("changes", "says"),
    [
        ({"alert": "cpu-high"}, "alert 'cpu-high' is not one of"),
        ({"environment": "local"}, "environment 'local' is not one of prod, dev"),
        ({"environment": "staging"}, "environment 'staging'"),
        ({"status": "pending"}, "status 'pending'"),
        ({"title": " "}, "title is empty"),
        ({"summary": "x" * 501}, "summary is longer than 500"),
        ({"started_at": "yesterday"}, "started_at 'yesterday' is not a UTC timestamp"),
        ({"started_at": "2026-10-25T08:37:51+02:00"}, "is not a UTC timestamp"),
        ({"status": "resolved"}, "resolved_at '' is not a UTC timestamp, but status is resolved"),
        ({"resolved_at": "2026-10-25T08:43:46Z"}, "resolved_at is set, but status is firing"),
        ({"description": "line\x1b[31m"}, "description holds control characters"),
        ({"title": 3}, "title is not a string"),
    ],
)
def test_bad_values_fail(changes: dict[str, Any], says: str) -> None:
    found = d.problems(payload(**changes))
    assert any(says in p for p in found), found


@pytest.mark.parametrize(
    ("link", "value"),
    [
        ("dashboard", "https://evil.example/d/focus-key-journey-prod?x"),
        ("dashboard", f"{GRAFANA}d/focus-key-journey-dev?orgId=1"),  # another environment's
        ("traces", "https://ineedtofocus.grafana.net.evil.example/explore?"),
        ("alert", "javascript:alert(1)"),
        ("runbook", f"{d.RUNBOOKS}history-latency.md"),  # another alert's runbook
        ("runbook", "https://github.com/someone/else/blob/main/_docs/runbooks/x.md"),
    ],
)
def test_links_point_into_our_grafana_and_runbooks(link: str, value: str) -> None:
    broken = payload()
    broken["links"][link] = value
    assert any(p.startswith(f"links.{link} ") for p in d.problems(broken))


def test_links_are_exactly_the_four() -> None:
    broken = payload()
    broken["links"]["logs"] = f"{GRAFANA}explore?"
    assert d.problems(broken) == ["links must have exactly: dashboard, traces, runbook, alert"]
    del broken["links"]["logs"], broken["links"]["traces"]
    assert d.problems(broken) == ["links must have exactly: dashboard, traces, runbook, alert"]


@pytest.mark.parametrize(
    ("field", "value", "says"),
    [
        ("description", "failed for someone@example.com", "email address"),
        ("summary", "goal: https://www.youtube.com/watch?v=x", "YouTube link"),
        ("traces", f"{GRAFANA}explore?panes=%7Bq%3A%22a%40b.example.org%22%7D", "email address"),
        ("traces", f"{GRAFANA}explore?panes=youtu.be%2Fx", "YouTube link"),
    ],
)
def test_customer_data_is_refused(field: str, value: str, says: str) -> None:
    broken = payload()
    if field in d.LINKS:
        broken["links"][field] = value
    else:
        broken[field] = value
    assert any(says in p for p in d.problems(broken))


def test_local_mode_takes_the_local_grafana_and_environment() -> None:
    local = payload(environment="local")
    for name, link in local["links"].items():
        local["links"][name] = link.replace(GRAFANA, d.LOCAL_GRAFANA).replace("-prod", "-local")
    assert d.problems(local) != []
    assert d.problems(local, grafana=d.LOCAL_GRAFANA, environments=("local",)) == []


def test_request_and_event_shapes() -> None:
    body = {"event_type": d.EVENT_TYPE, "client_payload": payload()}
    assert d.request_problems(body) == []
    assert d.request_problems({**body, "event_type": "other"}) == [
        f"event_type 'other' is not {d.EVENT_TYPE}"
    ]
    assert d.request_problems({**body, "ref": "main"}) == [
        "the body must have exactly event_type and client_payload"
    ]
    event = {"action": d.EVENT_TYPE, "client_payload": payload(), "sender": {"login": "x"}}
    assert d.event_problems(event) == []
    assert d.event_problems({**event, "action": "other"}) == [
        f"event type 'other' is not {d.EVENT_TYPE}"
    ]
    assert d.event_problems({**event, "client_payload": None}) == [
        "client_payload is not an object"
    ]


def test_check_event_logs_and_summarises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    event = tmp_path / "event.json"
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    good = payload(description="a | b\nc")
    event.write_text(
        json.dumps(
            {"action": d.EVENT_TYPE, "client_payload": good, "sender": {"login": "ybenzine"}}
        )
    )
    assert d.check_event(str(event)) == 0
    out = capsys.readouterr().out
    assert "ok    session-save-errors firing in prod (sent by ybenzine)" in out
    assert json.loads(out[: out.index("\nok ")]) == good
    text = summary.read_text()
    assert "| Status | **firing** |" in text
    assert "a \\| b c" in text  # a pipe or newline can't break the table
    assert "[runbook](https://github.com/ybenzine/ineedtofocus/blob/main/_docs/runbooks/" in text


def test_check_event_fails_red_on_a_bad_payload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    event = tmp_path / "event.json"
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    event.write_text(json.dumps({"action": d.EVENT_TYPE, "client_payload": payload(alert="x")}))
    assert d.check_event(str(event)) == 1
    out = capsys.readouterr().out
    assert "::error title=Invalid alert dispatch::" in out
    assert "Alert dispatch: invalid" in summary.read_text()


def test_the_payload_never_prints_a_line_github_reads_as_a_command(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Values are printed inside indented JSON, so a `::` command can't start a line."""
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    event = tmp_path / "event.json"
    sneaky = payload(description="x\n::add-mask::y")  # valid: a newline is allowed text
    event.write_text(json.dumps({"action": d.EVENT_TYPE, "client_payload": sneaky}))
    d.check_event(str(event))
    lines = capsys.readouterr().out.splitlines()
    assert not [line for line in lines if line.startswith("::") and "Invalid alert" not in line]


def test_cli(tmp_path: Path) -> None:
    good = tmp_path / "good.json"
    good.write_text(json.dumps({"event_type": d.EVENT_TYPE, "client_payload": payload()}))
    assert d.main(["check", str(good)]) == 0
    assert d.main(["check", str(good), "--local"]) == 1
    assert d.main(["check"]) == 2
    assert d.main([]) == 2


# --- The local stand-in for GitHub's endpoint ---------------------------------------------


@pytest.fixture
def stand_in(tmp_path: Path) -> Iterator[tuple[int, Path]]:
    out = tmp_path / "received.jsonl"
    server = d.receiver(0, "s3cret", out)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_port, out
    server.shutdown()


def post(port: int, path: str, body: Any, token: str | None) -> int:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    conn.request("POST", path, json.dumps(body), headers)
    status = conn.getresponse().status
    conn.close()
    return status


def local_body() -> dict[str, Any]:
    p = payload(environment="local")
    for name, link in p["links"].items():
        p["links"][name] = link.replace(GRAFANA, d.LOCAL_GRAFANA).replace("-prod", "-local")
    return {"event_type": d.EVENT_TYPE, "client_payload": p}


def test_the_stand_in_answers_like_github(stand_in: tuple[int, Path]) -> None:
    port, out = stand_in
    body = local_body()
    assert post(port, d.DISPATCH_PATH, body, None) == 401
    assert post(port, d.DISPATCH_PATH, body, "wrong") == 401
    assert post(port, "/repos/other/repo/dispatches", body, "s3cret") == 404
    assert post(port, d.DISPATCH_PATH, body, "s3cret") == 204
    broken = copy.deepcopy(body)
    broken["client_payload"]["status"] = "pending"
    assert post(port, d.DISPATCH_PATH, broken, "s3cret") == 422
    records = [json.loads(line) for line in out.read_text().splitlines()]
    assert [r["problems"] == [] for r in records] == [True, False]
    assert "s3cret" not in out.read_text()
