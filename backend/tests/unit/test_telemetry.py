"""Telemetry privacy for the request tracing wired in #4.

Runs FastAPI's built-in telemetry against an in-memory exporter and checks that
query strings and cookies never reach exported span attributes.
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import NoOpTracerProvider

from app.config import Settings
from app.main import create_app
from app.telemetry import QueryStringScrubber, install_privacy_filters, strip_query

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
        "url.full": "http://h/p?email=x",
        "http.url": "http://h/p?e=x",
        "http.target": "/p?e=x",
    }
    provider.get_tracer("t").start_span("s", attributes=attributes).end()
    exported = dict(exporter.get_finished_spans()[0].attributes or {})
    assert exported == {"url.full": "http://h/p", "http.url": "http://h/p", "http.target": "/p"}


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
    assert [type(p) for p in processors] == [QueryStringScrubber]
