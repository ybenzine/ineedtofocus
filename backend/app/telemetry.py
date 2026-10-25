"""OpenTelemetry settings and privacy guard for request tracing.

The container runs the app under `opentelemetry-instrument` (see Dockerfile), which sets
up the global tracer, meter and logger providers and the OTLP exporters from the OTEL_*
env vars, and ships Python logs. FastAPI's built-in telemetry then traces and meters
every request through those providers; without them (tests, plain `uvicorn`) it stays off.
Database calls are traced by the SQLAlchemy instrumentation (`instrument_engine`).

Privacy (_docs/observability.md): the server span records the query string
(`url.query`) and the raw request path (`url.path`, which for an unmatched route can hold
anything a client typed, such as an email). `QueryStringScrubber` redacts the query and
replaces the path with `UNMATCHED` when the span starts. `AttributeAllowlist`, when it ends,
puts the route template (from `http.route`) back for matched requests and drops everything
not on `ALLOWED_SPAN_ATTRIBUTES`, all before anything is exported. FastAPI sets these
attributes only at span start, which is what makes `on_start` enough (#31).
"""

from collections.abc import MutableMapping
from contextvars import ContextVar
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from fastapi.telemetry import TelemetryConfig
from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
from opentelemetry.instrumentation.sqlalchemy.engine import EngineTracer
from opentelemetry.metrics import NoOpMeter
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor, TracerProvider
from opentelemetry.trace import SpanKind, Status
from sqlalchemy.ext.asyncio import AsyncEngine

# Attributes that may carry a full URL (stable and old HTTP semantic conventions).
URL_KEYS = ("url.full", "http.url", "http.target")
# Attributes that are the path itself.
PATH_KEYS = ("url.path",)
# Attributes that are the query string itself.
QUERY_KEYS = ("url.query",)
REDACTED = "REDACTED"
# What a path that matches no route is recorded as: it may hold anything a client typed
# (`/api/nope/someone@example.com`), so it is never exported.
UNMATCHED = "UNMATCHED"
# Paths polled by container health checks: not worth a trace every few seconds.
UNTRACED_PATHS = frozenset({"/healthz"})

# The only span attributes that leave the process. Everything else, including whatever a
# future instrumentation adds, is dropped before export. Deliberately absent: client
# addresses, user agents, cookies and headers, and `db.user`.
ALLOWED_SPAN_ATTRIBUTES = frozenset(
    {
        "http.method",
        "http.request.method",
        "http.route",
        "http.status_code",
        "http.response.status_code",
        "http.scheme",
        "http.flavor",
        "url.scheme",
        "url.path",
        "url.query",
        "url.full",
        "http.url",
        "http.target",
        "server.address",
        "server.port",
        "network.protocol.version",
        "net.host.name",
        "net.host.port",
        "net.peer.name",
        "net.peer.port",
        "error.type",
        "db.system",
        "db.system.name",
        "db.name",
        "db.namespace",
        "db.operation",
        "db.operation.name",
        "db.statement",
        "db.query.text",
        "db.sql.table",
        "db.collection.name",
        "enduser.id",  # the opaque internal user id, never an email
    }
)
# Event attributes: an exception event's message can quote a database row, so only the type.
ALLOWED_EVENT_ATTRIBUTES = frozenset({"exception.type", "exception.escaped"})


# The request's server span, so code deep in a dependency can tag it (the current span there
# is a `fastapi.dependencies` child).
# Set when the server span starts and never reset, which is safe: each request runs in its own
# task with a fresh copy of the context, so the value cannot leak into another request. It
# would break if middleware ran the endpoint or its dependencies in a shared or copied context
# (e.g. a thread or task started before the span): `tag_user` would then tag nothing, or the
# wrong request's span.
_server_span: ContextVar[Span | None] = ContextVar("server_span", default=None)


def tag_user(user_id: str) -> None:
    """Record the opaque user id on the request's server span."""
    span = _server_span.get()
    if span is not None and span.is_recording():
        span.set_attribute("enduser.id", user_id)


def strip_query(url: str) -> str:
    """`https://h/p?a=b#f` -> `https://h/p` (also works for a bare `/p?a=b`)."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _with_path(url: str, path: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, path if parts.path else "", "", ""))


class QueryStringScrubber(SpanProcessor):
    """Removes query strings and raw paths from URL attributes as spans start.

    The path is replaced by `UNMATCHED`; `AttributeAllowlist` swaps in the route template
    when the span ends and FastAPI has set `http.route` (a match).
    """

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        if span.kind == SpanKind.SERVER:
            _server_span.set(span)
        attributes = span.attributes or {}
        for key in URL_KEYS:
            value = attributes.get(key)
            if isinstance(value, str):
                span.set_attribute(key, _with_path(value, UNMATCHED))
        for key in PATH_KEYS:
            if isinstance(attributes.get(key), str):
                span.set_attribute(key, UNMATCHED)
        for key in QUERY_KEYS:
            if attributes.get(key):
                span.set_attribute(key, REDACTED)

    def on_end(self, span: ReadableSpan) -> None:
        return None


class AttributeAllowlist(SpanProcessor):
    """Drops every attribute (and event attribute) that is not allowlisted, as a span ends,
    and shows the route template (`/api/sessions/{session_id}`) instead of `UNMATCHED` as
    the path when the request matched a route.

    Must run before the exporting processor so the span is clean when it is queued:
    `install_privacy_filters` puts it first.
    """

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        return None

    def on_end(self, span: ReadableSpan) -> None:
        # The span's own attribute container is frozen once it ends, so the shared
        # `ReadableSpan` (every later processor gets this same object) is given a clean copy.
        clean = {k: v for k, v in (span.attributes or {}).items() if k in ALLOWED_SPAN_ATTRIBUTES}
        route = clean.get("http.route")
        if isinstance(route, str):
            for key in PATH_KEYS:
                if key in clean:
                    clean[key] = route
            for key in URL_KEYS:
                value = clean.get(key)
                if isinstance(value, str):
                    clean[key] = _with_path(value, route)
        span._attributes = clean
        # A status description is free text (the SQLAlchemy instrumentation puts `str(exc)`
        # there, which can quote a bound value): keep the code, drop the words.
        span._status = Status(span.status.status_code)
        for event in span._events:
            event._attributes = {
                k: v for k, v in (event.attributes or {}).items() if k in ALLOWED_EVENT_ATTRIBUTES
            }


def install_privacy_filters(provider: object | None = None) -> bool:
    """Register the scrubber and the allowlist on the SDK tracer provider (default: the
    global one), once.

    Returns False when tracing isn't set up by the SDK (tests, plain `uvicorn`): then
    nothing is traced and there is nothing to scrub.
    """
    provider = provider if provider is not None else trace.get_tracer_provider()
    if not isinstance(provider, TracerProvider):
        return False
    if not getattr(provider, "_focus_privacy_filters", False):
        multi = provider._active_span_processor
        # First in line: the allowlist has to clean a span before the exporting processor
        # (added earlier, by the distro) queues it.
        multi._span_processors = (
            QueryStringScrubber(),
            AttributeAllowlist(),
            *multi._span_processors,
        )
        provider._focus_privacy_filters = True  # type: ignore[attr-defined]
    return True


# The connection-pool gauge `EngineTracer` wants; pool sizes aren't part of the journey metrics.
_NO_CONNECTION_USAGE = NoOpMeter("app.db").create_up_down_counter("db.client.connections.usage")


def instrument_engine(engine: AsyncEngine, tracer_provider: TracerProvider | None = None) -> bool:
    """Trace the engine's queries (`db.statement` is the parameterised SQL: the engine is
    built with `hide_parameters`, and bound values are never span attributes).

    The SQLAlchemy instrumentation's own version check refuses SQLAlchemy 2.1, although the
    engine events it uses exist there (tests cover it, so an upgrade that breaks it fails
    loudly). Returns False without an SDK tracer provider.
    """
    provider = tracer_provider if tracer_provider is not None else trace.get_tracer_provider()
    if not isinstance(provider, TracerProvider):
        return False
    if SQLAlchemyInstrumentor().is_instrumented_by_opentelemetry:
        return False  # the stock instrumentor already traces new engines: no second set of spans
    # `EngineTracer` is what `SQLAlchemyInstrumentor` attaches to an engine. Using it directly
    # instruments only this engine (the instrumentor is a process-wide singleton that also
    # patches `create_engine`) and skips its version check, which refuses SQLAlchemy 2.1.
    EngineTracer(  # type: ignore[no-untyped-call]
        provider.get_tracer("app.db"), engine.sync_engine, _NO_CONNECTION_USAGE
    )
    return True


def is_untraced(scope: MutableMapping[str, Any]) -> bool:
    return scope.get("path") in UNTRACED_PATHS


def telemetry_config(tracer_provider: TracerProvider | None = None) -> TelemetryConfig:
    """FastAPI's built-in telemetry settings.

    `logs` is off: app logs (including unhandled errors) already reach the backend
    through the JSON logger and the OpenTelemetry logging handler.
    """
    return {"exclude": is_untraced, "logs": False, "tracer_provider": tracer_provider}
