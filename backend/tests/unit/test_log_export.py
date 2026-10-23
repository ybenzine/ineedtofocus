"""Logs shipped over OTLP are scrubbed like stdout (#4, review of PR #67, finding 1).

Uses OpenTelemetry's real `LoggingHandler`, the handler `opentelemetry-instrument`
puts on the root logger, with an in-memory exporter.
"""

import json
import logging
from collections.abc import Iterator

import pytest
from opentelemetry.instrumentation.logging.handler import LoggingHandler
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter, SimpleLogRecordProcessor

from app.logging_config import configure_logging, scrub

EMAIL = "leak-4f2a@example.com"
DETAIL = f"DETAIL:  Key (lower(email))=({EMAIL}) already exists."


class FakeIntegrityError(Exception):
    """Shaped like asyncpg's UniqueViolationError: the DETAIL line is in the message."""


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


def _log_unhandled_error() -> None:
    """The path errors.py's `unhandled` handler takes, with a chained DB error."""
    try:
        try:
            raise FakeIntegrityError(f"duplicate key value violates unique constraint\n{DETAIL}")
        except FakeIntegrityError as db_error:
            raise RuntimeError(f"insert failed\n{DETAIL}") from db_error
    except RuntimeError as exc:
        logging.getLogger("app.errors").error("unhandled exception", exc_info=exc)
    logging.getLogger("app.db").warning("constraint hit: %s", f"\n{DETAIL}")


def test_otlp_log_records_carry_no_email(
    capsys: pytest.CaptureFixture[str],
    exporter: InMemoryLogRecordExporter,
) -> None:
    configure_logging("INFO")  # bind the JSON handler to the captured stdout
    _log_unhandled_error()
    records = [r.log_record for r in exporter.get_finished_logs()]
    assert len(records) == 2
    for record in records:
        assert EMAIL not in str(record.body)
        assert EMAIL not in repr(dict(record.attributes or {}))

    error = dict(records[0].attributes or {})
    assert records[0].body == "unhandled exception"
    assert error["exception.type"] == "RuntimeError"
    assert "DETAIL: [redacted]" in str(error["exception.message"])
    stacktrace = str(error["exception.stacktrace"])
    assert "FakeIntegrityError" in stacktrace  # the chained cause is still there
    assert "DETAIL: [redacted]" in stacktrace
    assert "DETAIL: [redacted]" in str(records[1].body)

    # stdout is unchanged: the JSON handler still gets the original record.
    lines = [json.loads(line) for line in capsys.readouterr().out.strip().splitlines()]
    assert lines[0]["message"] == "unhandled exception"
    assert "FakeIntegrityError" in lines[0]["exception"]
    assert "exception.type" not in lines[0]
    assert EMAIL not in json.dumps(lines)


def test_scrub_filter_leaves_the_original_record_alone(
    exporter: InMemoryLogRecordExporter,
) -> None:
    seen: list[logging.LogRecord] = []

    class Spy(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            seen.append(record)

    spy = Spy()
    logging.getLogger().addHandler(spy)  # after configure_logging: no scrub filter
    try:
        _log_unhandled_error()
    finally:
        logging.getLogger().removeHandler(spy)
    assert seen[0].exc_info is not None
    assert EMAIL in seen[1].getMessage()  # other handlers see the record as logged
    assert len(exporter.get_finished_logs()) == 2


def test_configure_logging_adds_the_filter_once(exporter: InMemoryLogRecordExporter) -> None:
    configure_logging("INFO")
    otlp = [h for h in logging.getLogger().handlers if isinstance(h, LoggingHandler)]
    assert len(otlp) == 1
    assert len(otlp[0].filters) == 1


def test_scrub_removes_sql_parameters_from_database_errors() -> None:
    """SQLAlchemy errors end with the bound values, e.g. a YouTube link or a goal."""
    message = (
        "(asyncpg.exceptions.UniqueViolationError) duplicate key\n"
        "[SQL: INSERT INTO youtube_recent_links (user_id, url) VALUES ($1, $2)]\n"
        "[parameters: (UUID('1b2c'), 'https://www.youtube.com/watch?v=leak-9z')]\n"
        "(Background on this error at: https://sqlalche.me/e/20/gkpj)"
    )
    out = scrub(message)
    assert "leak-9z" not in out and "youtube.com" not in out
    assert "[SQL: INSERT INTO youtube_recent_links" in out  # the statement text is kept
    assert "Background on this error" in out
