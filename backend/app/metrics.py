"""Metrics for the key user journey: saving finished sessions and loading history (#31).

Instruments come from the global meter provider, which `opentelemetry-instrument` sets up
in the container; without it (tests, plain `uvicorn`) they are no-ops.

Labels are fixed, low-cardinality words (`kind`, `outcome`): never a user, a goal, a tag,
a time zone or anything else a client sends (_docs/observability.md).

- `focus.session.saves`: counter, one per session. `kind` is single or sync; `outcome` is
  created, existing, rejected (a conflict, an invalid session, or a request FastAPI refused
  with 422) or error (the request failed unexpectedly, wherever it failed). A sync request
  that fails as a whole counts once per session in the batch when it fails inside the handler
  and once when it fails earlier (its body may not have been parsed).
- `focus.session.save.duration`: histogram in seconds, one per request that reached the
  handler; the time is spent in the handler, after authentication. `outcome` is ok,
  client_error or error.
- `focus.sync.batch.size`: histogram, sessions per sync request that reached the handler.
- `focus.history.loads`: counter, one per request. `outcome` is ok, invalid (bad parameters,
  including FastAPI's own 422) or error.
- `focus.history.load.duration`: histogram in seconds, like the save duration.

Not counted: requests answered 401 (not signed in) or 429, which never reach a save or a
load. A failure before the handler (the sign-in lookup failing, a 422) is counted by
`count_early_failure`, called from the error handlers in `errors.py`.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from time import perf_counter

from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from opentelemetry import metrics
from opentelemetry.metrics import Counter, Histogram

_meter = metrics.get_meter("app.journey")

# Seconds, with the 2 s history alert threshold on a bucket edge. The SDK's default
# boundaries (0 to 10000) are meant for milliseconds and would put every request in one bucket.
LATENCY_BUCKETS_S = [
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 5, 7.5, 10,
]  # fmt: skip
BATCH_SIZE_BUCKETS = [1, 2, 5, 10, 20, 50, 100]

SESSION_SAVES = _meter.create_counter(
    "focus.session.saves", unit="{session}", description="Sessions saved, by outcome"
)
SESSION_SAVE_DURATION = _meter.create_histogram(
    "focus.session.save.duration",
    unit="s",
    description="Time to handle a session save request",
    explicit_bucket_boundaries_advisory=LATENCY_BUCKETS_S,
)
SYNC_BATCH_SIZE = _meter.create_histogram(
    "focus.sync.batch.size",
    unit="{session}",
    description="Sessions per sync request",
    explicit_bucket_boundaries_advisory=BATCH_SIZE_BUCKETS,
)
HISTORY_LOADS = _meter.create_counter(
    "focus.history.loads", unit="{load}", description="History loads, by outcome"
)
HISTORY_LOAD_DURATION = _meter.create_histogram(
    "focus.history.load.duration",
    unit="s",
    description="Time to handle a history request",
    explicit_bucket_boundaries_advisory=LATENCY_BUCKETS_S,
)


# Set once `observe` has counted a failure, so the error handlers don't count it again.
_counted: ContextVar[bool] = ContextVar("journey_failure_counted", default=False)

# The journey routes have fixed paths, so the error handlers can tell them from other requests.
_SAVE_PATHS = {"/api/sessions": "single", "/api/sessions/sync": "sync"}
HISTORY_PATH = "/api/history"


def count_early_failure(method: str, path: str, status: int) -> None:
    """Count a save or history request that failed before (or outside) its handler's
    `observe` block: FastAPI's 422 validation, or an unexpected error such as the sign-in
    lookup failing. Called by the error handlers."""
    if _counted.get():
        return
    if method == "POST" and path in _SAVE_PATHS:
        outcome = "rejected" if status < 500 else "error"
        SESSION_SAVES.add(1, {"kind": _SAVE_PATHS[path], "outcome": outcome})
    elif method == "GET" and path == HISTORY_PATH:
        HISTORY_LOADS.add(1, {"outcome": "invalid" if status < 500 else "error"})


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
        _counted.set(True)
        counter.add(weight, {**base, "outcome": client_outcome})
        raise
    except Exception:
        outcome = "error"
        _counted.set(True)
        counter.add(weight, {**base, "outcome": "error"})
        raise
    finally:
        histogram.record(perf_counter() - start, {**base, "outcome": outcome})
