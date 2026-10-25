"""The on-call agent's read-only Grafana client (#35): scripts/oncall_grafana.py. The token
goes only to an https Grafana, never through a redirect, and is never printed."""

from __future__ import annotations

import http.server
import json
import threading
import urllib.parse
from collections.abc import Iterator
from typing import Any, ClassVar

import grafana_alerts as ga
import oncall_grafana as og
import pytest

TOKEN = "glsa_test_token_not_real"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("GRAFANA_URL", "GRAFANA_READONLY_TOKEN", *og.UID_OVERRIDES.values()):
        monkeypatch.delenv(name, raising=False)


class Recorder(http.server.BaseHTTPRequestHandler):
    """A local Grafana stand-in: records every request, answers from `routes`."""

    seen: ClassVar[list[dict[str, Any]]] = []
    routes: ClassVar[dict[str, tuple[int, Any, dict[str, str]]]] = {}

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        self.seen.append(
            {
                "method": "GET",
                "path": parsed.path,
                "query": dict(urllib.parse.parse_qsl(parsed.query)),
                "authorization": self.headers.get("Authorization"),
            }
        )
        code, body, headers = self.routes.get(parsed.path, (404, {"message": "nope"}, {}))
        raw = json.dumps(body).encode()
        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:
        self.seen.append({"method": "POST", "path": self.path})
        self.send_response(405)
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        pass


@pytest.fixture
def grafana(monkeypatch: pytest.MonkeyPatch) -> Iterator[type[Recorder]]:
    handler = type("R", (Recorder,), {"seen": [], "routes": {}})
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("GRAFANA_URL", f"http://127.0.0.1:{server.server_port}")
    yield handler
    server.shutdown()


def test_only_https_or_this_machine(monkeypatch: pytest.MonkeyPatch) -> None:
    assert og.base_url() == og.GRAFANA_CLOUD
    for ok in (
        "https://ineedtofocus.grafana.net/",
        "http://localhost:3000",
        "http://127.0.0.1:3008",
    ):
        monkeypatch.setenv("GRAFANA_URL", ok)
        assert og.base_url() == ok.rstrip("/")
    for bad in ("http://ineedtofocus.grafana.net", "ftp://x", "http://evil.example", "//x"):
        monkeypatch.setenv("GRAFANA_URL", bad)
        with pytest.raises(og.GrafanaError):
            og.base_url()


def test_the_cloud_needs_the_token(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(og.GrafanaError, match="GRAFANA_READONLY_TOKEN is not set"):
        og.get("/api/health")


def test_the_token_never_goes_over_plain_http(
    grafana: type[Recorder], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GRAFANA_READONLY_TOKEN", TOKEN)
    grafana.routes["/api/health"] = (200, {"ok": True}, {})
    assert og.get("/api/health") == {"ok": True}
    assert grafana.seen[-1]["authorization"] is None


def test_a_redirect_is_never_followed(grafana: type[Recorder]) -> None:
    grafana.routes["/api/health"] = (302, {}, {"Location": "http://127.0.0.1:1/steal"})
    with pytest.raises(og.GrafanaError, match="redirect, not followed"):
        og.get("/api/health")
    assert [s["path"] for s in grafana.seen] == ["/api/health"]


def test_the_token_goes_in_the_header_over_https(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[Any] = []

    class Response:
        def __enter__(self) -> Response:
            return self

        def __exit__(self, *args: Any) -> None:
            pass

        def read(self) -> bytes:
            return b'{"status": "success", "data": {"result": []}}'

    def fake_open(request: Any, timeout: float) -> Response:
        seen.append(request)
        return Response()

    monkeypatch.setenv("GRAFANA_READONLY_TOKEN", TOKEN)
    monkeypatch.setattr(ga._OPENER, "open", fake_open)
    assert og.prom("up") == []
    (request,) = seen
    assert request.get_method() == "GET"
    assert request.get_header("Authorization") == f"Bearer {TOKEN}"
    assert request.full_url.startswith(
        "https://ineedtofocus.grafana.net/api/datasources/proxy/uid/grafanacloud-prom/api/v1/query?"
    )
    assert TOKEN not in request.full_url


def test_data_sources_default_per_grafana_and_can_be_overridden(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert og.datasource("metrics", og.GRAFANA_CLOUD) == "grafanacloud-prom"
    assert og.datasource("traces", "http://127.0.0.1:3000") == "tempo"
    monkeypatch.setenv("GRAFANA_PROM_UID", "grafanacloud-ineedtofocus-prom")
    assert og.datasource("metrics", og.GRAFANA_CLOUD) == "grafanacloud-ineedtofocus-prom"


def test_journey_runs_the_alert_rules_own_queries(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[str] = []
    values = {
        ga.save_error_rate("prod"): 0.19671,
        ga.sessions_submitted("prod"): 64.96,
        ga.history_p95("prod"): None,
        ga.history_loads("prod"): None,
    }

    def fake_scalar(expr: str) -> float | None:
        asked.append(expr)
        return values[expr]

    monkeypatch.setattr(og, "scalar", fake_scalar)
    found = og.journey("prod")
    assert sorted(asked) == sorted(values)
    assert found["save_error_rate"] == 0.1967
    assert found["sessions_submitted"] == 65
    assert found["history_p95_seconds"] is None
    assert found["save_alert_fires_above"] == 0.05


def test_scalar_and_prom_over_the_proxy(grafana: type[Recorder]) -> None:
    path = "/api/datasources/proxy/uid/prometheus/api/v1/query"
    grafana.routes[path] = (
        200,
        {"status": "success", "data": {"result": [{"metric": {}, "value": [1, "0.25"]}]}},
        {},
    )
    assert og.scalar("x") == 0.25
    grafana.routes[path] = (200, {"status": "error", "error": "parse error"}, {})
    with pytest.raises(og.GrafanaError, match="query refused"):
        og.prom("x(")
    grafana.routes["/api/datasources/proxy/uid/prometheus/api/v1/query_range"] = (
        200,
        {"status": "success", "data": {"result": []}},
        {},
    )
    assert og.prom("x", minutes=60) == []
    assert grafana.seen[-1]["query"]["step"] == "60"


def test_alert_states_read_the_environments_group(grafana: type[Recorder]) -> None:
    rule = {
        "labels": {"alert": "session-save-errors"},
        "state": "firing",
        "health": "ok",
        "alerts": [{"activeAt": "2026-10-25T08:37:51Z"}],
    }
    other = {"labels": {"alert": "session-save-errors"}, "state": "inactive"}
    grafana.routes["/api/prometheus/grafana/api/v1/rules"] = (
        200,
        {
            "data": {
                "groups": [
                    {"name": "key-journey-dev", "rules": [rule]},
                    {"name": "key-journey-prod", "rules": [other]},
                ]
            }
        },
        {},
    )
    assert og.alert_states("dev") == {
        "session-save-errors": {
            "state": "firing",
            "health": "ok",
            "last_error": None,
            "active_since": "2026-10-25T08:37:51Z",
        }
    }
    assert og.alert_states("prod")["session-save-errors"]["state"] == "normal"
    assert og.wait("session-save-errors", "prod", "normal", minutes=0, poll_s=0)
    assert not og.wait("session-save-errors", "dev", "normal", minutes=0, poll_s=0)


def test_logs_newest_first_with_their_trace(grafana: type[Recorder]) -> None:
    grafana.routes["/api/datasources/proxy/uid/loki/loki/api/v1/query_range"] = (
        200,
        {
            "status": "success",
            "data": {
                "result": [
                    {
                        "stream": {
                            "trace_id": "a" * 32,
                            "exception_type": "InjectedSaveFault",
                            "exception_message": "could quote input",
                        },
                        "values": [
                            ["1761381471000000000", "unhandled exception " + "x" * 1000],
                            ["1761381472000000000", "second\nline"],
                        ],
                    }
                ]
            },
        },
        {},
    )
    lines = og.logs(og.error_logs_query("dev"), minutes=30, limit=5)
    assert lines[0] == (
        '2025-10-25T08:37:52Z  "second line"  exception_type=InjectedSaveFault  trace_id='
        + "a" * 32
    )
    assert not [line for line in lines if "could quote input" in line]
    assert len(lines[1]) <= og.LINE + 22
    assert grafana.seen[-1]["query"]["direction"] == "backward"
    assert 'deployment_environment_name="dev"' in grafana.seen[-1]["query"]["query"]


def test_traces_and_one_trace(grafana: type[Recorder]) -> None:
    grafana.routes["/api/datasources/proxy/uid/tempo/api/search"] = (
        200,
        {
            "traces": [
                {
                    "traceID": "b" * 32,
                    "startTimeUnixNano": "1761381471000000000",
                    "durationMs": 31,
                    "rootTraceName": "POST /api/sessions",
                }
            ]
        },
        {},
    )
    assert og.traces(og.failed_query("dev")) == [
        f"{'b' * 32}  2025-10-25T08:37:51Z  31 ms  POST /api/sessions"
    ]
    assert "status=error" in grafana.seen[-1]["query"]["q"]
    span = {
        "name": "POST /api/sessions",
        "startTimeUnixNano": "1761381471000000000",
        "endTimeUnixNano": "1761381471031000000",
        "status": {"code": "STATUS_CODE_ERROR"},
        "attributes": [
            {"key": "http.route", "value": {"stringValue": "/api/sessions"}},
            {"key": "enduser.id", "value": {"stringValue": "opaque-id"}},
        ],
        "events": [
            {
                "attributes": [
                    {"key": "exception.type", "value": {"stringValue": "InjectedSaveFault"}}
                ]
            }
        ],
    }
    grafana.routes[f"/api/datasources/proxy/uid/tempo/api/traces/{'b' * 32}"] = (
        200,
        {
            "batches": [
                {
                    "resource": {
                        "attributes": [{"key": "service.version", "value": {"stringValue": "abc"}}]
                    },
                    "scopeSpans": [{"spans": [span]}],
                }
            ]
        },
        {},
    )
    (line,) = og.trace("b" * 32)
    assert "31.0 ms  POST /api/sessions  status=STATUS_CODE_ERROR" in line
    assert '"exception.type": "InjectedSaveFault"' in line
    assert '"service.version": "abc"' in line
    assert "enduser.id" not in line  # only the allowlisted attributes print
    with pytest.raises(og.GrafanaError, match="32 lowercase hex"):
        og.trace("../../api/admin")


def test_cli_never_prints_the_token(
    grafana: type[Recorder],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("GRAFANA_READONLY_TOKEN", TOKEN)
    grafana.routes["/api/prometheus/grafana/api/v1/rules"] = (500, {"message": "boom"}, {})
    assert og.main(["alerts", "dev"]) == 1
    assert og.main(["trace", "nothex"]) == 1
    assert og.main(["prom", "up"]) == 1
    out = capsys.readouterr()
    assert "error: GET /api/prometheus/grafana/api/v1/rules -> HTTP 500" in out.err
    assert TOKEN not in out.out + out.err
    assert all(s["method"] == "GET" for s in grafana.seen)
    with pytest.raises(SystemExit):
        og.main(["journey", "staging"])
