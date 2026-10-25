"""Log fields (#31): trace ids on every line, allowlisted `extra`, no uvicorn colour copy."""

import json
import logging
from collections.abc import Iterator

import pytest
from opentelemetry.instrumentation.logging.handler import LoggingHandler
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter, SimpleLogRecordProcessor
from opentelemetry.sdk.trace import TracerProvider

from app.logging_config import ALLOWED_EXTRA, JsonFormatter, configure_logging, scrub


@pytest.fixture
def exporter() -> Iterator[InMemoryLogRecordExporter]:
    exporter = InMemoryLogRecordExporter()  # type: ignore[no-untyped-call]
    provider = LoggerProvider()
    provider.add_log_record_processor(SimpleLogRecordProcessor(exporter))
    root = logging.getLogger()
    saved = root.handlers[:]
    try:
        root.handlers[:] = [LoggingHandler(logger_provider=provider)]
        configure_logging("INFO")
        yield exporter
    finally:
        root.handlers[:] = saved


def _record(**extra: object) -> logging.LogRecord:
    record = logging.LogRecord("t", logging.INFO, __file__, 1, "hello %s", ("world",), None)
    record.__dict__.update(extra)
    return record


def test_every_line_has_trace_and_span_id() -> None:
    outside = json.loads(JsonFormatter().format(_record()))
    assert outside["trace_id"] is None and outside["span_id"] is None

    with TracerProvider().get_tracer("t").start_as_current_span("s") as span:
        ctx = span.get_span_context()
        inside = json.loads(JsonFormatter().format(_record()))
    assert inside["trace_id"] == format(ctx.trace_id, "032x")
    assert inside["span_id"] == format(ctx.span_id, "016x")
    assert len(inside["trace_id"]) == 32 and len(inside["span_id"]) == 16


def test_only_allowlisted_extra_fields_are_logged() -> None:
    line = json.loads(
        JsonFormatter().format(
            _record(
                version="1.0",
                goal="Secret goal",
                email="a@b.c",
                color_message="\x1b[32mINFO\x1b[0m: started",
            )
        )
    )
    assert line["version"] == "1.0"
    assert not {"goal", "email", "color_message"} & set(line)
    assert "Secret" not in json.dumps(line)
    assert {"goal", "email", "password", "youtube_link"}.isdisjoint(ALLOWED_EXTRA)


def test_ansi_codes_are_stripped() -> None:
    assert scrub("\x1b[32mINFO\x1b[0m:     Started") == "INFO:     Started"
    line = json.loads(JsonFormatter().format(_record()))
    assert "\x1b" not in line["message"]


def test_otlp_copy_drops_extra_and_color_message(
    exporter: InMemoryLogRecordExporter,
) -> None:
    logging.getLogger("uvicorn.error").info(
        "Started server process [%d]",
        1,
        extra={"color_message": "Started server process [\x1b[36m%d\x1b[0m]"},
    )
    logging.getLogger("app.x").info("hi", extra={"version": "1", "goal": "Secret goal"})
    first, second = [r.log_record for r in exporter.get_finished_logs()]
    assert first.body == "Started server process [1]"
    assert "color_message" not in dict(first.attributes or {})
    assert "\x1b" not in repr(dict(first.attributes or {}))
    attrs = dict(second.attributes or {})
    assert attrs.get("version") == "1"
    assert "goal" not in attrs
    assert "Secret" not in repr(attrs)
