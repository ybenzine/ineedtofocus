"""Metrics for the key user journey: saving finished sessions and loading history (#31).

Instruments come from the global meter provider, which `opentelemetry-instrument` sets up
in the container; without it (tests, plain `uvicorn`) they are no-ops.

Labels are fixed, low-cardinality words (`kind`, `outcome`): never a user, a goal, a tag,
a time zone or anything else a client sends (_docs/observability.md).

- `focus.session.saves`: counter, one per session. `kind` is single or sync; `outcome` is
  created, existing, rejected (a conflict or an invalid session) or error (the request
  failed unexpectedly).
- `focus.session.save.duration`: histogram in seconds, one per request. `kind`; `outcome`
  is ok, client_error or error.
- `focus.sync.batch.size`: histogram, sessions per sync request. No labels.
- `focus.history.loads`: counter, one per request. `outcome` is ok, invalid or error.
- `focus.history.load.duration`: histogram in seconds. `outcome` is ok, client_error or error.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from time import perf_counter

from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from opentelemetry import metrics
from opentelemetry.metrics import Counter, Histogram

_meter = metrics.get_meter("app.journey")

SESSION_SAVES = _meter.create_counter(
    "focus.session.saves", unit="{session}", description="Sessions saved, by outcome"
)
SESSION_SAVE_DURATION = _meter.create_histogram(
    "focus.session.save.duration", unit="s", description="Time to handle a session save request"
)
SYNC_BATCH_SIZE = _meter.create_histogram(
    "focus.sync.batch.size", unit="{session}", description="Sessions per sync request"
)
HISTORY_LOADS = _meter.create_counter(
    "focus.history.loads", unit="{load}", description="History loads, by outcome"
)
HISTORY_LOAD_DURATION = _meter.create_histogram(
    "focus.history.load.duration", unit="s", description="Time to handle a history request"
)


@contextmanager
def observe(
    counter: Counter,
    histogram: Histogram,
    attributes: dict[str, str] | None = None,
    *,
    weight: int = 1,
    client_outcome: str = "rejected",
) -> Iterator[None]:
    """Time the block. An unexpected exception counts `weight` as outcome `error`; an
    `HTTPException` or request validation error (the client's mistake) counts `weight` as
    `client_outcome`. A block that returns normally counts nothing here: its handler records
    the success outcomes itself, because one request can have several (a sync batch)."""
    base = attributes or {}
    outcome = "ok"
    start = perf_counter()
    try:
        yield
    except (HTTPException, RequestValidationError):
        outcome = "client_error"
        counter.add(weight, {**base, "outcome": client_outcome})
        raise
    except Exception:
        outcome = "error"
        counter.add(weight, {**base, "outcome": "error"})
        raise
    finally:
        histogram.record(perf_counter() - start, {**base, "outcome": outcome})
