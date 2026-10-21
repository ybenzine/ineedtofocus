"""OpenTelemetry settings and privacy guard for request tracing.

The container runs the app under `opentelemetry-instrument` (see Dockerfile), which sets
up the global tracer, meter and logger providers and the OTLP exporters from the OTEL_*
env vars, and ships Python logs. FastAPI's built-in telemetry then traces and meters
every request through those providers; without them (tests, plain `uvicorn`) it stays off.

Privacy (_docs/observability.md): the server span records the query string
(`url.query`), so a value such as `?email=...` would reach the trace backend.
`QueryStringScrubber` redacts it when the span starts, before anything is exported.
FastAPI sets these attributes only at span start, which is what makes `on_start` enough.
The full attribute allowlist is #31's job.
"""

from collections.abc import MutableMapping
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from fastapi.telemetry import TelemetryConfig
from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor, TracerProvider

# Attributes that may carry a full URL (stable and old HTTP semantic conventions).
URL_KEYS = ("url.full", "http.url", "http.target")
# Attributes that are the query string itself.
QUERY_KEYS = ("url.query",)
REDACTED = "REDACTED"
# Paths polled by container health checks: not worth a trace every few seconds.
UNTRACED_PATHS = frozenset({"/healthz"})


def strip_query(url: str) -> str:
    """`https://h/p?a=b#f` -> `https://h/p` (also works for a bare `/p?a=b`)."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


class QueryStringScrubber(SpanProcessor):
    """Redacts query strings in URL attributes as spans start."""

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        attributes = span.attributes or {}
        for key in URL_KEYS:
            value = attributes.get(key)
            if isinstance(value, str) and ("?" in value or "#" in value):
                span.set_attribute(key, strip_query(value))
        for key in QUERY_KEYS:
            if attributes.get(key):
                span.set_attribute(key, REDACTED)

    def on_end(self, span: ReadableSpan) -> None:
        return None


def install_privacy_filters(provider: object | None = None) -> bool:
    """Register the scrubber on the SDK tracer provider (default: the global one), once.

    Returns False when tracing isn't set up by the SDK (tests, plain `uvicorn`): then
    nothing is traced and there is nothing to scrub.
    """
    provider = provider if provider is not None else trace.get_tracer_provider()
    if not isinstance(provider, TracerProvider):
        return False
    if not getattr(provider, "_focus_privacy_filters", False):
        provider.add_span_processor(QueryStringScrubber())
        provider._focus_privacy_filters = True  # type: ignore[attr-defined]
    return True


def is_untraced(scope: MutableMapping[str, Any]) -> bool:
    return scope.get("path") in UNTRACED_PATHS


def telemetry_config(tracer_provider: TracerProvider | None = None) -> TelemetryConfig:
    """FastAPI's built-in telemetry settings.

    `logs` is off: app logs (including unhandled errors) already reach the backend
    through the JSON logger and the OpenTelemetry logging handler.
    """
    return {"exclude": is_untraced, "logs": False, "tracer_provider": tracer_provider}
