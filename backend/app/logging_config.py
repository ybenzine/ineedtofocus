"""Structured JSON logs to stdout.

Privacy: never log emails, passwords, cookies, goals or YouTube links
(see _docs/observability.md). Extra fields passed via `extra=` are included.
"""

import copy
import json
import logging
import re
import sys
import traceback
from datetime import UTC, datetime

_RESERVED = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


# Postgres errors quote the offending row in a DETAIL line ("Key (lower(email))=(a@b.c)
# already exists"), which would put emails and goals into logs. Drop those lines.
_PG_DETAIL = re.compile(r"^DETAIL:.*$", re.MULTILINE)


# SQLAlchemy appends the statement's bound values to DBAPI errors ("[parameters: (...)]"),
# which carry goals, emails and password hashes.
_SQL_PARAMETERS = re.compile(
    r"\[parameters: .*?\](?=\n\(Background on this error|\n\n|\Z)", re.DOTALL
)


def scrub(text: str) -> str:
    text = _PG_DETAIL.sub("DETAIL: [redacted]", text)
    return _SQL_PARAMETERS.sub("[parameters: redacted]", text)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": scrub(record.getMessage()),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED:
                payload[key] = value
        if record.exc_info:
            payload["exception"] = scrub(self.formatException(record.exc_info))
        return json.dumps(payload, default=str)


class ScrubFilter(logging.Filter):
    """Hands handlers a scrubbed copy of each record; the original is left untouched.

    For handlers that don't format through `JsonFormatter`, such as OpenTelemetry's
    OTLP `LoggingHandler`, which exports the raw message and builds `exception.*`
    attributes from `exc_info`. The copy carries a scrubbed, pre-rendered message (no
    args), no `exc_info`, and the exception as already-scrubbed `exception.type`,
    `exception.message` and `exception.stacktrace` attributes. Needs Python >= 3.12
    (filters may return a record).
    """

    def filter(self, record: logging.LogRecord) -> logging.LogRecord:
        clean = copy.copy(record)
        clean.msg = scrub(record.getMessage())
        clean.args = None
        clean.exc_info = None
        clean.exc_text = None
        if record.stack_info:
            clean.stack_info = scrub(record.stack_info)
        if record.exc_info and record.exc_info[1] is not None:
            exc = record.exc_info[1]
            setattr(clean, "exception.type", type(exc).__name__)
            setattr(clean, "exception.message", scrub(str(exc)))
            setattr(
                clean,
                "exception.stacktrace",
                scrub("".join(traceback.format_exception(exc))),
            )
        for key, value in record.__dict__.items():
            if key not in _RESERVED and isinstance(value, str):
                setattr(clean, key, scrub(value))
        return clean


_SCRUB_FILTER = ScrubFilter()


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    # Replace console (stream) handlers with the one JSON handler, but keep the others:
    # under `opentelemetry-instrument` the root logger also holds OpenTelemetry's OTLP
    # LoggingHandler, which ships these same records to Grafana. Those get the scrub
    # filter, since they don't go through JsonFormatter.
    others = [h for h in root.handlers if not isinstance(h, logging.StreamHandler)]
    for other in others:
        other.addFilter(_SCRUB_FILTER)  # no-op if already added
    root.handlers[:] = [*others, handler]
    root.setLevel(level.upper())
    # Uvicorn's own handlers would emit plain text; route through the root handler.
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True
    access = logging.getLogger("uvicorn.access")
    access.handlers[:] = []
    access.propagate = False  # access lines carry query strings; keep them out
