"""Structured JSON logs to stdout.

Privacy: never log emails, passwords, cookies, goals or YouTube links
(see _docs/observability.md). Extra fields passed via `extra=` are included.
"""

import json
import logging
import re
import sys
from datetime import UTC, datetime

_RESERVED = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


# Postgres errors quote the offending row in a DETAIL line ("Key (lower(email))=(a@b.c)
# already exists"), which would put emails and goals into logs. Drop those lines.
_PG_DETAIL = re.compile(r"^DETAIL:.*$", re.MULTILINE)


def scrub(text: str) -> str:
    return _PG_DETAIL.sub("DETAIL: [redacted]", text)


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


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    # Replace console (stream) handlers with the one JSON handler, but keep the others:
    # under `opentelemetry-instrument` the root logger also holds OpenTelemetry's OTLP
    # LoggingHandler, which ships these same records to Grafana.
    others = [h for h in root.handlers if not isinstance(h, logging.StreamHandler)]
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
