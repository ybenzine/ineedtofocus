"""Telemetry of the key journey (#31): saves and history loads against a real Postgres.

Traces: every request and its database calls are spans in one trace; the browser's
`traceparent` is continued; no customer data reaches an exported attribute.
Metrics: saves and history loads by outcome, the sync batch size.
Logs: every line carries the request's trace and span ids.
"""

import json
import logging
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from sqlalchemy import text

from app.config import Settings
from app.deps import DbSession
from app.logging_config import configure_logging
from app.main import create_app
from app.telemetry import install_privacy_filters
from tests.integration.conftest import PASSWORD
from tests.integration.test_sessions import make_session

pytestmark = pytest.mark.integration

EMAIL = "leaky-person@example.com"
GOAL = "Secret goal about the merger"
YOUTUBE = "https://www.youtube.com/watch?v=SECRETVIDEO"
SECRETS = (EMAIL, "leaky-person", GOAL, "merger", "SECRETVIDEO", PASSWORD)

_reader = InMemoryMetricReader()


@pytest.fixture(scope="session", autouse=True)
def meter_provider() -> None:
    """The global meter provider can be set once; the journey instruments bind to it."""
    metrics.set_meter_provider(MeterProvider(metric_readers=[_reader]))


def _points(name: str) -> dict[tuple[tuple[str, Any], ...], Any]:
    """Current data points of one metric, keyed by their sorted attributes."""
    data = _reader.get_metrics_data()
    found: dict[tuple[tuple[str, Any], ...], Any] = {}
    for resource in data.resource_metrics if data else []:
        for scope in resource.scope_metrics:
            for metric in scope.metrics:
                if metric.name == name:
                    for p in metric.data.data_points:
                        found[tuple(sorted((p.attributes or {}).items()))] = p
    return found


def _value(name: str, **attributes: str) -> int:
    point = _points(name).get(tuple(sorted(attributes.items())))
    return int(point.value) if point is not None else 0


def _count(name: str, **attributes: str) -> int:
    point = _points(name).get(tuple(sorted(attributes.items())))
    return int(point.count) if point is not None else 0


@pytest.fixture
def traced(app_url: str) -> Iterator[tuple[TestClient, InMemorySpanExporter]]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    assert install_privacy_filters(provider) is True
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    app = create_app(Settings(database_url=app_url, cookie_secure=False), tracer_provider=provider)
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c, exporter


def _signed_in(c: TestClient) -> str:
    r = c.post("/api/auth/signup", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 201
    user_id = r.json()["id"]
    assert isinstance(user_id, str)
    return user_id


def _server_spans(exporter: InMemorySpanExporter, route: str) -> list[ReadableSpan]:
    return [
        s for s in exporter.get_finished_spans() if (s.attributes or {}).get("http.route") == route
    ]


def test_save_is_one_trace_with_database_spans(
    traced: tuple[TestClient, InMemorySpanExporter],
) -> None:
    c, exporter = traced
    _signed_in(c)
    exporter.clear()
    r = c.post("/api/sessions", json=make_session(goal=GOAL))
    assert r.status_code == 201
    (server,) = _server_spans(exporter, "/api/sessions")
    same_trace = [
        s for s in exporter.get_finished_spans() if s.context.trace_id == server.context.trace_id
    ]
    db = [s for s in same_trace if (s.attributes or {}).get("db.system") == "postgresql"]
    assert db, "expected SQLAlchemy spans in the request's trace"
    statements = " ".join(str((s.attributes or {}).get("db.statement")) for s in db)
    assert "INSERT INTO focus_sessions" in statements  # parameterised SQL...
    assert GOAL not in statements  # ...with no bound values


def test_traceparent_from_the_browser_is_continued(
    traced: tuple[TestClient, InMemorySpanExporter],
) -> None:
    c, exporter = traced
    _signed_in(c)
    exporter.clear()
    trace_id = uuid.uuid4().hex
    parent = f"00-{trace_id}-{uuid.uuid4().hex[:16]}-01"
    assert (
        c.post("/api/sessions", json=make_session(), headers={"traceparent": parent}).status_code
        == 201
    )
    (server,) = _server_spans(exporter, "/api/sessions")
    assert format(server.context.trace_id, "032x") == trace_id


def test_no_customer_data_in_any_exported_attribute_event_or_name(
    traced: tuple[TestClient, InMemorySpanExporter],
) -> None:
    c, exporter = traced
    user_id = _signed_in(c)
    assert c.post("/api/sessions", json=make_session(goal=GOAL)).status_code == 201
    sent = [make_session(goal=GOAL), make_session(goal=GOAL, focus_seconds=-5)]
    assert c.post("/api/sessions/sync", json={"sessions": sent}).status_code == 200
    assert c.get(f"/api/history?view=all&tz=UTC&tag=work&email={EMAIL}").status_code == 200
    # Unmatched paths, and a statement that fails on a bound customer value: asyncpg's error
    # text quotes the value, and the SQLAlchemy instrumentation puts it in the span status.
    failing = APIRouter()

    @failing.get("/api/_boom")
    async def boom(db: DbSession) -> dict[str, str]:
        await db.execute(text("SELECT CAST(:v AS uuid)"), {"v": EMAIL})
        return {}

    c.app.include_router(failing)  # type: ignore[attr-defined]
    assert c.get("/api/_boom").status_code == 500
    assert c.get(f"/api/nope/{EMAIL}").status_code == 404
    assert c.get(f"/api/nope/{YOUTUBE.replace('/', '%2F')}").status_code == 404
    assert c.get(f"/api/sessions/{uuid.uuid4()}?goal={GOAL}").status_code in (404, 405)
    assert (
        c.post("/api/auth/signup", json={"email": EMAIL, "password": PASSWORD}).status_code == 409
    )

    spans = exporter.get_finished_spans()
    dumped = repr(
        [
            (
                s.name,
                dict(s.attributes or {}),
                [(e.name, dict(e.attributes or {})) for e in s.events],
                (s.status.status_code.name, s.status.description),
            )
            for s in spans
        ]
    )
    cookies = [v for v in c.cookies.values() if v]
    assert cookies, "expected a session cookie to look for"
    for secret in (*SECRETS, *cookies):
        assert secret not in dumped, secret
    paths = {(s.attributes or {}).get("url.path") for s in spans if s.kind.name == "SERVER"}
    assert "UNMATCHED" in paths
    assert "/api/sessions/{session_id}" in paths
    assert not any("nope" in str(p) for p in paths)
    errors = [s for s in spans if s.status.status_code.name == "ERROR"]
    assert errors, "expected the failing statement to leave an error span"
    assert all(s.status.description is None for s in spans)
    # The only user reference is the opaque id, on the server span (not a child).
    assert user_id in dumped
    users = [s for s in spans if (s.attributes or {}).get("enduser.id") == user_id]
    assert users
    assert all(s.kind.name == "SERVER" for s in users)
    allowed_keys = {k for s in spans for k in (s.attributes or {})}
    assert not allowed_keys & {
        "http.user_agent",
        "user_agent.original",
        "client.address",
        "net.peer.ip",
    }


def test_logs_carry_trace_and_span_ids_of_the_request(
    capsys: pytest.CaptureFixture[str], traced: tuple[TestClient, InMemorySpanExporter]
) -> None:
    c, exporter = traced
    _signed_in(c)
    configure_logging("INFO")  # bind the JSON handler to the captured stdout
    capsys.readouterr()
    exporter.clear()
    logging.getLogger("app.test").info("outside any request")

    router = APIRouter()

    @router.get("/api/_log")
    async def log_something() -> dict[str, str]:
        logging.getLogger("app.test").info("inside a request", extra={"goal": GOAL})
        return {}

    c.app.include_router(router)  # type: ignore[attr-defined]
    assert c.get("/api/_log").status_code == 200
    raw = capsys.readouterr().out
    lines = [json.loads(line) for line in raw.splitlines() if line.startswith("{")]
    inside = next(line for line in lines if line["message"] == "inside a request")
    outside = next(line for line in lines if line["message"] == "outside any request")
    assert outside["trace_id"] is None and outside["span_id"] is None
    assert "goal" not in inside  # `extra` is allowlisted
    spans = exporter.get_finished_spans()
    assert any(format(s.context.trace_id, "032x") == inside["trace_id"] for s in spans)
    assert any(format(s.context.span_id, "016x") == inside["span_id"] for s in spans)


def test_session_save_and_sync_metrics(
    traced: tuple[TestClient, InMemorySpanExporter],
) -> None:
    c, _ = traced
    _signed_in(c)
    created = _value("focus.session.saves", kind="single", outcome="created")
    existing = _value("focus.session.saves", kind="single", outcome="existing")
    rejected = _value("focus.session.saves", kind="single", outcome="rejected")
    sync_created = _value("focus.session.saves", kind="sync", outcome="created")
    sync_rejected = _value("focus.session.saves", kind="sync", outcome="rejected")
    batches = _count("focus.sync.batch.size")
    durations = _count("focus.session.save.duration", kind="single", outcome="ok")

    body = make_session()
    assert c.post("/api/sessions", json=body).status_code == 201
    assert c.post("/api/sessions", json=body).status_code == 200
    other = make_session()
    assert c.post("/api/auth/signout").status_code in (200, 204)
    assert (
        c.post(
            "/api/auth/signup", json={"email": "other@example.com", "password": PASSWORD}
        ).status_code
        == 201
    )
    assert c.post("/api/sessions", json=body).status_code == 409  # someone else's id
    batch = [other, make_session(focus_seconds=-5), make_session()]
    assert c.post("/api/sessions/sync", json={"sessions": batch}).status_code == 200

    assert _value("focus.session.saves", kind="single", outcome="created") == created + 1
    assert _value("focus.session.saves", kind="single", outcome="existing") == existing + 1
    assert _value("focus.session.saves", kind="single", outcome="rejected") == rejected + 1
    assert _value("focus.session.saves", kind="sync", outcome="created") == sync_created + 2
    assert _value("focus.session.saves", kind="sync", outcome="rejected") == sync_rejected + 1
    assert _count("focus.sync.batch.size") == batches + 1
    assert _count("focus.session.save.duration", kind="single", outcome="ok") == durations + 2
    # No label can carry customer data: only the fixed vocabulary appears.
    for name in ("focus.session.saves", "focus.session.save.duration", "focus.history.loads"):
        for key in _points(name):
            assert {k for k, _ in key} <= {"kind", "outcome"}


def test_history_load_metrics(traced: tuple[TestClient, InMemorySpanExporter]) -> None:
    c, _ = traced
    _signed_in(c)
    ok = _value("focus.history.loads", outcome="ok")
    invalid = _value("focus.history.loads", outcome="invalid")
    latency = _count("focus.history.load.duration", outcome="ok")
    assert c.get("/api/history?view=all&tz=UTC").status_code == 200
    assert c.get("/api/history?view=all&tz=Not/AZone").status_code == 422
    assert _value("focus.history.loads", outcome="ok") == ok + 1
    assert _value("focus.history.loads", outcome="invalid") == invalid + 1
    assert _count("focus.history.load.duration", outcome="ok") == latency + 1
    assert _count("focus.history.load.duration", outcome="client_error") >= 1


def test_failures_before_the_handler_are_counted(
    traced: tuple[TestClient, InMemorySpanExporter],
) -> None:
    """FastAPI's 422s happen before the handler; they are counted by the error handlers."""
    c, _ = traced
    _signed_in(c)
    rejected = _value("focus.session.saves", kind="single", outcome="rejected")
    sync_rejected = _value("focus.session.saves", kind="sync", outcome="rejected")
    invalid = _value("focus.history.loads", outcome="invalid")
    assert c.post("/api/sessions", json={"nonsense": True}).status_code == 422
    assert c.post("/api/sessions/sync", json={"sessions": []}).status_code == 422
    assert c.get("/api/history?view=all").status_code == 422  # tz is required
    assert _value("focus.session.saves", kind="single", outcome="rejected") == rejected + 1
    assert _value("focus.session.saves", kind="sync", outcome="rejected") == sync_rejected + 1
    assert _value("focus.history.loads", outcome="invalid") == invalid + 1


def test_a_failure_inside_the_handler_is_counted_once(
    traced: tuple[TestClient, InMemorySpanExporter],
) -> None:
    c, _ = traced
    _signed_in(c)
    invalid = _value("focus.history.loads", outcome="invalid")
    assert c.get("/api/history?view=all&tz=Not/AZone").status_code == 422
    assert _value("focus.history.loads", outcome="invalid") == invalid + 1


def test_duration_histograms_use_second_buckets() -> None:
    from app.metrics import BATCH_SIZE_BUCKETS, LATENCY_BUCKETS_S

    assert 2 in LATENCY_BUCKETS_S  # the history alert threshold is a bucket edge
    assert max(LATENCY_BUCKETS_S) <= 10 and min(LATENCY_BUCKETS_S) < 0.01
    for name, bounds in (
        ("focus.session.save.duration", LATENCY_BUCKETS_S),
        ("focus.history.load.duration", LATENCY_BUCKETS_S),
        ("focus.sync.batch.size", BATCH_SIZE_BUCKETS),
    ):
        points = _points(name)
        assert points, f"no data points for {name}"
        assert all(list(p.explicit_bounds) == bounds for p in points.values())
