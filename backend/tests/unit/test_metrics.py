"""`observe`, the timing and outcome helper behind the journey metrics (#31)."""

from typing import Any

import pytest
from fastapi import HTTPException

from app.metrics import observe


class Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[float, dict[str, str]]] = []

    def add(self, amount: float, attributes: dict[str, str]) -> None:
        self.calls.append((amount, attributes))

    record = add


def _run(raises: BaseException | None, **kwargs: Any) -> tuple[Recorder, Recorder]:
    counter, histogram = Recorder(), Recorder()
    try:
        with observe(counter, histogram, {"kind": "sync"}, **kwargs):  # type: ignore[arg-type]
            if raises is not None:
                raise raises
    except Exception:
        pass
    return counter, histogram


def test_success_only_records_the_latency() -> None:
    counter, histogram = _run(None)
    assert counter.calls == []
    assert [a for _, a in histogram.calls] == [{"kind": "sync", "outcome": "ok"}]
    assert histogram.calls[0][0] >= 0


def test_unexpected_error_counts_the_whole_batch_as_error() -> None:
    counter, histogram = _run(RuntimeError("boom"), weight=7)
    assert counter.calls == [(7, {"kind": "sync", "outcome": "error"})]
    assert histogram.calls[0][1] == {"kind": "sync", "outcome": "error"}


def test_client_error_is_not_an_error() -> None:
    counter, histogram = _run(HTTPException(409), client_outcome="rejected")
    assert counter.calls == [(1, {"kind": "sync", "outcome": "rejected"})]
    assert histogram.calls[0][1] == {"kind": "sync", "outcome": "client_error"}


def test_exception_still_propagates() -> None:
    with pytest.raises(RuntimeError), observe(Recorder(), Recorder()):  # type: ignore[arg-type]
        raise RuntimeError("boom")


def test_zero_journey_series_creates_every_counter_series(monkeypatch: pytest.MonkeyPatch) -> None:
    """#33: every series exists from startup at 0, so the first errors are an increase."""
    import app.metrics as m

    saves, loads = Recorder(), Recorder()
    monkeypatch.setattr(m, "SESSION_SAVES", saves)
    monkeypatch.setattr(m, "HISTORY_LOADS", loads)
    m.zero_journey_series()
    assert {amount for amount, _ in saves.calls + loads.calls} == {0}
    assert sorted((a["kind"], a["outcome"]) for _, a in saves.calls) == sorted(
        (k, o) for k in ("single", "sync") for o in ("created", "existing", "rejected", "error")
    )
    assert sorted(a["outcome"] for _, a in loads.calls) == ["error", "invalid", "ok"]
