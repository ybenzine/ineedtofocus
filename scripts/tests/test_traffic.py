"""scripts/traffic.py (#33): never prod, sessions the backend accepts, a realistic mix,
and nothing sent before the target is checked. No network: the HTTP client is faked."""

from __future__ import annotations

import random
import sys
from collections import Counter
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
import traffic

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))

from pydantic import ValidationError  # noqa: E402

from app.sessions import SessionIn  # noqa: E402


@pytest.mark.parametrize(
    "url",
    [
        "https://ineedtofoc.us",
        "https://ineedtofoc.us/",
        "https://INEEDTOFOC.US./api",
        "http://www.ineedtofoc.us",
        "ftp://dev.ineedtofoc.us",
        "dev.ineedtofoc.us",
    ],
)
def test_refuses_prod_and_non_http_targets(url: str) -> None:
    with pytest.raises(traffic.Refused):
        traffic.check_target(url)


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://dev.ineedtofoc.us/", "https://dev.ineedtofoc.us"),
        ("http://localhost:8004", "http://localhost:8004"),
    ],
)
def test_allows_dev_and_local(url: str, expected: str) -> None:
    assert traffic.check_target(url) == expected


def test_main_refuses_prod_before_sending_anything(monkeypatch: pytest.MonkeyPatch) -> None:
    def no_network(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("sent a request")

    monkeypatch.setattr(traffic.Client, "request", no_network)
    assert traffic.main(["--base-url", "https://ineedtofoc.us", "--minutes", "1"]) == 2


@pytest.mark.parametrize("args", [["--rate", "0"], ["--rate", "500"], ["--minutes", "0"]])
def test_rejects_unrealistic_settings(args: list[str]) -> None:
    with pytest.raises(SystemExit):
        traffic.parse_args(args)


def test_sessions_are_ones_the_backend_accepts() -> None:
    rng = random.Random(1)
    modes: Counter[str] = Counter()
    for _ in range(500):
        session = traffic.make_session(rng, datetime.now(UTC))
        parsed = SessionIn.model_validate(session)
        modes[parsed.mode.value] += 1
        assert parsed.goal is None
    assert set(modes) == {"countdown", "pomodoro", "unlimited"}


def test_invalid_sessions_are_rejected_by_the_backend() -> None:
    session = traffic.make_session(random.Random(2), datetime.now(UTC), valid=False)
    with pytest.raises(ValidationError):
        SessionIn.model_validate(session)


def test_history_queries_cover_every_view() -> None:
    rng = random.Random(3)
    views: Counter[str] = Counter()
    for _ in range(300):
        params = traffic.history_query(rng, date(2026, 10, 25))
        views[params["view"]] += 1
        assert params["tz"] in traffic.TIME_ZONES
        if params["view"] in ("day", "week", "month"):
            assert set(params) == {"view", "tz", "date"}
        elif params["view"] == "custom":
            assert params["start"] < params["end"]
        else:
            assert set(params) == {"view", "tz"}
    assert set(views) == set(traffic.VIEWS)


class FakeClient:
    def __init__(self, status: dict[str, int]) -> None:
        self.status = status
        self.sent: list[tuple[str, str, Any]] = []

    def request(self, method: str, path: str, body: Any = None) -> int:
        self.sent.append((method, path, body))
        return self.status[path.split("?")[0]]


def test_the_mix_of_saves_syncs_and_history_loads() -> None:
    client = FakeClient({"/api/sessions": 201, "/api/sessions/sync": 200, "/api/history": 200})
    t = traffic.Traffic(client, random.Random(4))  # type: ignore[arg-type]
    for _ in range(1000):
        t.step()
    paths = Counter(path.split("?")[0] for _, path, _ in client.sent)
    assert 380 < paths["/api/sessions"] < 520
    assert 100 < paths["/api/sessions/sync"] < 200
    assert 330 < paths["/api/history"] < 470
    batches = [body["sessions"] for _, path, body in client.sent if path == "/api/sessions/sync"]
    assert all(2 <= len(b) <= 5 for b in batches)
    # Some batches repeat a session already saved (an offline retry).
    saved_ids = {s["id"] for _, p, body in client.sent if p == "/api/sessions" for s in [body]}
    assert any(b[0]["id"] in saved_ids for b in batches)
    assert t.total["save ok"] == paths["/api/sessions"]
    assert t.total["sessions sent"] >= paths["/api/sessions"] + 2 * paths["/api/sessions/sync"]


def test_server_errors_are_counted_as_such() -> None:
    client = FakeClient({"/api/sessions": 500, "/api/sessions/sync": 500, "/api/history": 200})
    t = traffic.Traffic(client, random.Random(5))  # type: ignore[arg-type]
    for _ in range(200):
        t.step()
    assert t.total["save 5xx"] > 0 and t.total["sync 5xx"] > 0
    assert "save ok" not in t.total
    assert t.saved == []  # nothing the server refused is replayed as "already saved"


def test_result_buckets() -> None:
    assert [traffic.result(s) for s in (0, 200, 201, 409, 422, 500, 503)] == [
        "no response", "ok", "ok", "4xx", "4xx", "5xx", "5xx",
    ]  # fmt: skip


def test_the_invalid_session_is_never_replayed_as_a_retry() -> None:
    """The server rejects it, so it isn't saved; a later "retry" of it would be rejected
    again, not `existing`."""
    client = FakeClient({"/api/sessions": 201, "/api/sessions/sync": 200, "/api/history": 200})
    t = traffic.Traffic(client, random.Random(6))  # type: ignore[arg-type]
    for _ in range(2000):
        t.step()
    sent_invalid = [
        s
        for _, path, body in client.sent
        if path == "/api/sessions/sync"
        for s in body["sessions"]
        if s["focus_seconds"] < 60
    ]
    assert sent_invalid, "the mix should include invalid sessions"
    assert all(s["focus_seconds"] >= 60 for s in t.saved)
