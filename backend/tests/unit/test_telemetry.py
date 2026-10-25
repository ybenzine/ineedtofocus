"""Telemetry privacy for the request tracing wired in #4.

Runs FastAPI's built-in telemetry against an in-memory exporter and checks that
query strings and cookies never reach exported span attributes.
"""

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry import trace
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import NoOpTracerProvider, SpanKind, Status, StatusCode

from app.config import Settings
from app.main import app_factory, create_app
from app.telemetry import (
    ALLOWED_EVENT_ATTRIBUTES,
    ALLOWED_SPAN_ATTRIBUTES,
    AttributeAllowlist,
    QueryStringScrubber,
    install_privacy_filters,
    strip_query,
)

SECRETS = ("someone", "example.com", "goal=write", "s3cr3t-cookie", "?")


async def _up() -> bool:
    return True


def _traced_app(tmp_path: Path, scrub: bool) -> tuple[FastAPI, InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    if scrub:
        assert install_privacy_filters(provider) is True
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    app = create_app(
        Settings(frontend_dist=tmp_path / "none"), readiness_check=_up, tracer_provider=provider
    )
    return app, exporter


def _request_with_secrets(app: FastAPI) -> None:
    with TestClient(app) as c:
        r = c.get(
            "/readyz?email=someone%40example.com&goal=write",
            headers={"Cookie": "session=s3cr3t-cookie"},
        )
        assert r.status_code == 200


def _server_span(spans: tuple[ReadableSpan, ...]) -> ReadableSpan:
    server = [s for s in spans if (s.attributes or {}).get("http.route") == "/readyz"]
    assert len(server) == 1, "expected one server span for /readyz"
    return server[0]


def test_strip_query() -> None:
    assert strip_query("http://h:1/p/q?email=a@b.c&x=1#frag") == "http://h:1/p/q"
    assert strip_query("/p?a=b") == "/p"
    assert strip_query("http://h/p") == "http://h/p"


def test_request_spans_carry_no_query_string_or_cookie(tmp_path: Path) -> None:
    app, exporter = _traced_app(tmp_path, scrub=True)
    _request_with_secrets(app)
    spans = exporter.get_finished_spans()
    dumped = repr([dict(s.attributes or {}) for s in spans])
    for secret in SECRETS:
        assert secret not in dumped
    attributes = _server_span(spans).attributes or {}
    assert attributes["url.path"] == "/readyz"
    assert attributes["url.query"] == "REDACTED"


def test_without_the_scrubber_the_query_would_leak(tmp_path: Path) -> None:
    """Guards the test above: FastAPI's telemetry does record the query string."""
    app, exporter = _traced_app(tmp_path, scrub=False)
    _request_with_secrets(app)
    assert "someone" in repr(dict(_server_span(exporter.get_finished_spans()).attributes or {}))


def test_scrubber_strips_full_urls() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(QueryStringScrubber())
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    attributes = {
        "url.full": "http://h/p/someone@example.com?email=x",
        "http.url": "http://h/p/1?e=x",
        "http.target": "/nope/someone@example.com?e=x",
        "url.path": "/nope/someone@example.com",
    }
    provider.get_tracer("t").start_span("s", attributes=attributes).end()
    exported = dict(exporter.get_finished_spans()[0].attributes or {})
    assert exported == {
        "url.full": "http://h/UNMATCHED",
        "http.url": "http://h/UNMATCHED",
        "http.target": "UNMATCHED",
        "url.path": "UNMATCHED",
    }


def test_unmatched_paths_are_never_exported(tmp_path: Path) -> None:
    """Review of PR #67, finding 4: `url.path` held whatever a client typed."""
    app, exporter = _traced_app(tmp_path, scrub=True)
    with TestClient(app) as c:
        assert c.get("/api/nope/someone%40example.com").status_code == 404
        assert c.get("/api/nope/https%3A%2F%2Fyoutu.be%2FSECRETVIDEO").status_code == 404
        assert (
            c.get("/api/sessions/3f2a1c52-0000-4000-8000-000000000000/archive").status_code == 405
        )
    spans = exporter.get_finished_spans()
    dumped = repr([(s.name, dict(s.attributes or {})) for s in spans])
    for secret in ("someone", "example.com", "SECRETVIDEO", "youtu", "3f2a1c52"):
        assert secret not in dumped
    paths = [(s.attributes or {}).get("url.path") for s in spans if s.kind == SpanKind.SERVER]
    assert paths == ["UNMATCHED", "UNMATCHED", "/api/sessions/{session_id}/archive"]


def test_allowlist_drops_everything_else() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    assert install_privacy_filters(provider) is True
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    span = provider.get_tracer("t").start_span(
        "s",
        attributes={
            "http.route": "/r",
            "http.request.header.cookie": "focus_session=s3cr3t",
            "user_agent.original": "Mozilla",
            "client.address": "203.0.113.9",
            "goal": "Write the report",
            "db.statement": "SELECT 1",
        },
    )
    span.record_exception(
        RuntimeError("DETAIL:  Key (lower(email))=(a@b.c) already exists."),
        attributes={"extra": "a@b.c"},
    )
    span.end()
    (done,) = exporter.get_finished_spans()
    assert dict(done.attributes or {}) == {"http.route": "/r", "db.statement": "SELECT 1"}
    (event,) = done.events
    assert dict(event.attributes or {}) == {
        "exception.type": "RuntimeError",
        "exception.escaped": "False",
    }
    assert ALLOWED_SPAN_ATTRIBUTES.isdisjoint({"user_agent.original", "db.user", "client.address"})
    assert {"exception.type", "exception.escaped"} == ALLOWED_EVENT_ATTRIBUTES


def test_health_probe_is_not_traced(tmp_path: Path) -> None:
    app, exporter = _traced_app(tmp_path, scrub=True)
    with TestClient(app) as c:
        assert c.get("/healthz").status_code == 200
        assert c.get("/readyz").status_code == 200
    routes = {(s.attributes or {}).get("http.route") for s in exporter.get_finished_spans()}
    assert "/healthz" not in routes
    assert "/readyz" in routes


def test_install_is_noop_without_sdk_provider() -> None:
    assert install_privacy_filters(NoOpTracerProvider()) is False
    # Tests never set a global SDK provider, so the default (the API proxy) is a no-op too.
    assert install_privacy_filters() is False


def test_install_registers_scrubber_once() -> None:
    provider = TracerProvider()
    assert install_privacy_filters(provider) is True
    assert install_privacy_filters(provider) is True
    processors = provider._active_span_processor._span_processors
    assert [type(p) for p in processors] == [QueryStringScrubber, AttributeAllowlist]


def test_app_factory_installs_the_scrubber(monkeypatch: pytest.MonkeyPatch) -> None:
    """The container entry point, as run under `opentelemetry-instrument` (global provider)."""
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(trace, "get_tracer_provider", lambda: provider)

    app = app_factory()
    with TestClient(app) as c:
        assert c.get("/api/nope?email=someone%40example.com").status_code == 404
    spans = exporter.get_finished_spans()
    server = [s for s in spans if s.kind == SpanKind.SERVER]
    assert len(server) == 1
    assert (server[0].attributes or {})["url.query"] == "REDACTED"
    assert "someone" not in repr([dict(s.attributes or {}) for s in spans])


def test_allowlist_runs_before_an_exporter_registered_first() -> None:
    """Production order: the distro registers the exporter, then the app installs the filters."""
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    assert install_privacy_filters(provider) is True
    span = provider.get_tracer("t").start_span(
        "s", attributes={"http.route": "/r", "goal": "Write the report"}
    )
    span.set_status(Status(StatusCode.ERROR, "invalid input for query argument $1: 'a@b.c'"))
    span.end()
    (done,) = exporter.get_finished_spans()
    assert dict(done.attributes or {}) == {"http.route": "/r"}
    assert done.status.status_code == StatusCode.ERROR
    assert done.status.description is None


def test_instrument_engine_traces_the_engine_once(monkeypatch: pytest.MonkeyPatch) -> None:
    from sqlalchemy.ext.asyncio import create_async_engine

    from app import telemetry

    calls: list[object] = []
    monkeypatch.setattr(telemetry, "EngineTracer", lambda *a, **k: calls.append(a))
    engine = create_async_engine("postgresql+asyncpg://u:p@localhost/db")
    provider = TracerProvider()
    assert telemetry.instrument_engine(engine, provider) is True
    assert len(calls) == 1
    # The stock instrumentor active (it patches create_engine itself): no second set of spans.
    monkeypatch.setattr(
        SQLAlchemyInstrumentor,
        "is_instrumented_by_opentelemetry",
        property(lambda _: True),
    )
    assert telemetry.instrument_engine(engine, provider) is False
    assert len(calls) == 1


def test_the_image_disables_the_stock_sqlalchemy_instrumentation() -> None:
    dockerfile = Path(__file__).resolve().parents[3] / "Dockerfile"
    if not dockerfile.is_file():
        pytest.skip("Dockerfile not available")
    assert "OTEL_PYTHON_DISABLED_INSTRUMENTATIONS=sqlalchemy" in dockerfile.read_text()
