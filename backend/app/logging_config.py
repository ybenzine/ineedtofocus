"""Structured JSON logs to stdout.

Every line carries `trace_id` and `span_id` (null outside a request) so logs link to
traces in Grafana (#31).

Privacy: never log emails, passwords, cookies, goals or YouTube links
(see _docs/observability.md). Only the fields in `ALLOWED_EXTRA` are kept from `extra=`
(and from foreign records such as uvicorn's `color_message`); add a name there only when
its value can never hold customer data.
"""

import copy
import json
import logging
import re
import sys
import traceback
from datetime import UTC, datetime

from opentelemetry import trace

# Fields a log call may add through `extra=`. Anything else is dropped from stdout and from
# the OTLP copy, so a new `extra=` can't leak customer data by accident, and uvicorn's
# `color_message` (the message again, with ANSI colour codes) never ships.
ALLOWED_EXTRA = frozenset({"version", "error_type", "user_id", "outcome", "batch_size"})

_RESERVED = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


# Postgres errors quote the offending row in a DETAIL line ("Key (lower(email))=(a@b.c)
# already exists"), which would put emails and goals into logs. Drop those lines.
_PG_DETAIL = re.compile(r"^DETAIL:.*$", re.MULTILINE)


# SQLAlchemy appends the bound values of a failed statement to the error text
# ("[parameters: (UUID(...), 'https://youtube.com/...')]"), which would put YouTube links,
# goals and emails into logs. Drop the rest of that line.
_SQL_PARAMETERS = re.compile(r"\[parameters: .*$", re.MULTILINE)


# ANSI escape sequences (uvicorn colours its messages when attached to a terminal).
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def trace_fields() -> dict[str, str | None]:
    """`trace_id` and `span_id` of the active span as the usual hex strings, or nulls."""
    ctx = trace.get_current_span().get_span_context()
    if not ctx.is_valid:
        return {"trace_id": None, "span_id": None}
    return {"trace_id": format(ctx.trace_id, "032x"), "span_id": format(ctx.span_id, "016x")}


# asyncpg quotes a value it can't encode ("invalid input for query argument $1: 'a@b.c' (...)"),
# and the reason often repeats it. Drop the rest of that line.
_ASYNCPG_ARGUMENT = re.compile(r"(invalid input for query argument \$\d+:).*$", re.MULTILINE)


def scrub(text: str) -> str:
    text = _ANSI.sub("", text)
    text = _ASYNCPG_ARGUMENT.sub(r"\1 [redacted]", text)
    text = _PG_DETAIL.sub("DETAIL: [redacted]", text)
    return _SQL_PARAMETERS.sub("[parameters: [redacted]]", text)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": scrub(record.getMessage()),
            **trace_fields(),
        }
        # Allowlisted `extra=` values are written as-is, unscrubbed: never put database error
        # text (str(exc), exception messages) in an `extra=` field; log it via exc_info.
        for key, value in record.__dict__.items():
            if key in ALLOWED_EXTRA:
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
            if key in _RESERVED:
                continue
            if key not in ALLOWED_EXTRA:
                del clean.__dict__[key]  # not allowlisted (e.g. uvicorn's color_message)
            elif isinstance(value, str):
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
