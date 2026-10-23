"""History API (#11) against a real, migrated, throwaway Postgres."""

import datetime as dt
import logging
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.integration.test_sessions import ada as ada
from tests.integration.test_sessions import app_url as app_url
from tests.integration.test_sessions import bob as bob
from tests.integration.test_sessions import make_session

pytestmark = pytest.mark.integration

PARIS = "Europe/Paris"


@pytest.fixture(autouse=True)
def _fixed_now(monkeypatch: pytest.MonkeyPatch) -> None:
    """These tests save sessions at fixed dates, some later than today; the sessions API only
    accepts times up to now + 24 h (#98), so pin the server clock after all of them."""
    monkeypatch.setattr("app.sessions._now", lambda: dt.datetime(2030, 1, 1, tzinfo=dt.UTC))


def save(c: TestClient, started_at: str, minutes: int, tag: str = "work", **over: Any) -> str:
    """Save a countdown session that starts at `started_at` (UTC, ISO) and lasts `minutes`."""
    start = dt.datetime.fromisoformat(started_at).replace(tzinfo=dt.UTC)
    end = start + dt.timedelta(minutes=minutes)
    body = make_session(
        tag=tag,
        started_at=start.isoformat(),
        ended_at=end.isoformat(),
        focus_seconds=minutes * 60,
        paused_seconds=0,
        mode_config={"mode": "countdown", "minutes": minutes},
        **over,
    )
    r = c.post("/api/sessions", json=body)
    assert r.status_code == 201, r.text
    session_id: str = body["id"]
    return session_id


def history(c: TestClient, **params: Any) -> dict[str, Any]:
    params.setdefault("tz", PARIS)
    r = c.get("/api/history", params=params)
    assert r.status_code == 200, r.text
    out: dict[str, Any] = r.json()
    return out


def bars(out: dict[str, Any]) -> dict[str, int]:
    return {b["date"]: b["focus_seconds"] for b in out["buckets"]}


def errors(c: TestClient, **params: Any) -> list[str]:
    r = c.get("/api/history", params=params)
    assert r.status_code == 422, r.text
    body: dict[str, Any] = r.json()
    assert body["error"]["code"] == "validation_error"
    return [e["field"] for e in body["error"]["details"]]


# --- AC: parameters and response ------------------------------------------------------------


def test_day_view_returns_totals_tags_buckets_and_sessions_newest_first(ada: TestClient) -> None:
    first = save(ada, "2026-10-23T07:00:00", 25, "work", goal="Draft the plan")
    second = save(ada, "2026-10-23T12:00:00", 30, "study")
    third = save(ada, "2026-10-23T15:00:00", 10, "work")
    save(ada, "2026-10-22T12:00:00", 45, "work")  # another day
    out = history(ada, view="day", date="2026-10-23")
    assert out["view"] == "day"
    assert out["time_zone"] == PARIS
    assert (out["start"], out["end"], out["bucket"]) == ("2026-10-23", "2026-10-23", "day")
    assert out["total_focus_seconds"] == 65 * 60
    assert out["session_count"] == 3
    assert out["tags"] == [
        {"tag": "work", "focus_seconds": 35 * 60, "sessions": 2},
        {"tag": "study", "focus_seconds": 30 * 60, "sessions": 1},
    ]
    assert out["buckets"] == [{"date": "2026-10-23", "focus_seconds": 65 * 60, "sessions": 3}]
    assert [s["id"] for s in out["sessions"]] == [third, second, first]
    # AC10.4: each item carries what the list shows, the goal included.
    item = out["sessions"][2]
    assert item["goal"] == "Draft the plan"
    assert {"started_at", "mode", "tag", "focus_seconds", "status"} <= item.keys()


def test_tag_filter_matches_any_of_the_selected_tags(ada: TestClient) -> None:
    save(ada, "2026-10-20T08:00:00", 20, "work")
    save(ada, "2026-10-21T08:00:00", 30, "study")
    save(ada, "2026-10-22T08:00:00", 40, "read")
    out = history(ada, view="week", date="2026-10-23", tag=["work", "read"])
    assert out["total_focus_seconds"] == 60 * 60
    assert [t["tag"] for t in out["tags"]] == ["read", "work"]
    assert {s["tag"] for s in out["sessions"]} == {"work", "read"}
    assert sum(bars(out).values()) == 60 * 60
    assert history(ada, view="week", date="2026-10-23")["session_count"] == 3


def test_month_view_has_a_bar_per_day(ada: TestClient) -> None:
    save(ada, "2026-02-01T08:00:00", 20)
    save(ada, "2026-02-28T08:00:00", 30)
    save(ada, "2026-03-01T08:00:00", 40)  # next month
    out = history(ada, view="month", date="2026-02-14")
    assert (out["start"], out["end"], out["bucket"]) == ("2026-02-01", "2026-02-28", "day")
    assert len(out["buckets"]) == 28
    assert bars(out)["2026-02-01"] == 20 * 60
    assert bars(out)["2026-02-28"] == 30 * 60
    assert out["session_count"] == 2


def test_custom_range_is_inclusive_with_day_bars_up_to_62_days(ada: TestClient) -> None:
    save(ada, "2026-09-01T08:00:00", 20)
    save(ada, "2026-11-01T08:00:00", 30)  # day 62
    save(ada, "2026-11-02T08:00:00", 40)  # outside
    out = history(ada, view="custom", start="2026-09-01", end="2026-11-01")
    assert out["bucket"] == "day"
    assert len(out["buckets"]) == 62
    assert out["total_focus_seconds"] == 50 * 60


def test_custom_range_over_62_days_has_month_bars(ada: TestClient) -> None:
    save(ada, "2026-09-01T08:00:00", 20)
    save(ada, "2026-11-02T08:00:00", 30)
    out = history(ada, view="custom", start="2026-09-01", end="2026-11-02")
    assert out["bucket"] == "month"
    assert out["buckets"] == [
        {"date": "2026-09-01", "focus_seconds": 20 * 60, "sessions": 1},
        {"date": "2026-10-01", "focus_seconds": 0, "sessions": 0},
        {"date": "2026-11-01", "focus_seconds": 30 * 60, "sessions": 1},
    ]


def test_all_time_has_month_bars_from_the_first_to_the_last_session(ada: TestClient) -> None:
    save(ada, "2025-12-15T08:00:00", 20, "nap")
    save(ada, "2026-02-10T08:00:00", 30, "work")
    out = history(ada, view="all")
    assert (out["start"], out["end"], out["bucket"]) == ("2025-12-15", "2026-02-10", "month")
    assert bars(out) == {"2025-12-01": 20 * 60, "2026-01-01": 0, "2026-02-01": 30 * 60}
    assert out["session_count"] == 2


def test_ac10_8_empty_views(ada: TestClient) -> None:
    out = history(ada, view="all")
    assert (out["start"], out["end"], out["buckets"], out["sessions"]) == (None, None, [], [])
    assert (out["total_focus_seconds"], out["session_count"], out["tags"]) == (0, 0, [])
    week = history(ada, view="week", date="2026-10-23")
    assert week["session_count"] == 0
    assert len(week["buckets"]) == 7
    assert all(b["focus_seconds"] == 0 for b in week["buckets"])


# --- AC10.5: local days, midnight and DST -------------------------------------------------


def test_ac10_5_days_follow_the_requested_time_zone(ada: TestClient) -> None:
    save(ada, "2026-10-23T23:30:00", 20)  # 24 Oct in Paris, 23 Oct in New York
    assert history(ada, view="day", date="2026-10-24")["session_count"] == 1
    assert history(ada, view="day", date="2026-10-23")["session_count"] == 0
    new_york = history(ada, view="day", date="2026-10-23", tz="America/New_York")
    assert new_york["session_count"] == 1
    assert new_york["time_zone"] == "America/New_York"


def test_ac10_5_session_crossing_midnight_counts_on_its_start_day(ada: TestClient) -> None:
    # 23:00 to 01:00 Paris time (UTC+2), 23-24 October.
    save(ada, "2026-10-23T21:00:00", 120)
    week = history(ada, view="week", date="2026-10-23")
    assert bars(week)["2026-10-23"] == 120 * 60
    assert bars(week)["2026-10-24"] == 0
    assert history(ada, view="day", date="2026-10-24")["session_count"] == 0
    # Crossing midnight at the end of a month counts toward the month it started in.
    save(ada, "2026-09-30T21:30:00", 60)  # 23:30 Paris on 30 September
    assert history(ada, view="month", date="2026-09-01")["session_count"] == 1
    assert history(ada, view="month", date="2026-10-01")["session_count"] == 1


def test_dst_spring_forward_23_hour_day(ada: TestClient) -> None:
    # 29 March 2026 in Paris has 23 hours: midnight is 23:00Z on the 28th, the next is 22:00Z.
    save(ada, "2026-03-28T22:59:00", 10)  # 23:59 on the 28th
    save(ada, "2026-03-28T23:00:00", 20)  # 00:00 on the 29th
    save(ada, "2026-03-29T21:30:00", 30)  # 23:30 on the 29th
    save(ada, "2026-03-29T22:00:00", 40)  # 00:00 on the 30th
    day = history(ada, view="day", date="2026-03-29")
    assert (day["total_focus_seconds"], day["session_count"]) == (50 * 60, 2)
    around = history(ada, view="custom", start="2026-03-28", end="2026-03-30")
    assert bars(around) == {"2026-03-28": 10 * 60, "2026-03-29": 50 * 60, "2026-03-30": 40 * 60}


def test_dst_fall_back_25_hour_day(ada: TestClient) -> None:
    # 25 October 2026 in Paris has 25 hours: midnight is 22:00Z on the 24th, the next 23:00Z.
    save(ada, "2026-10-24T21:59:00", 10)  # 23:59 on the 24th (UTC+2)
    save(ada, "2026-10-24T22:00:00", 20)  # 00:00 on the 25th
    save(ada, "2026-10-25T00:30:00", 25)  # 02:30, first pass (UTC+2)
    save(ada, "2026-10-25T01:30:00", 35)  # 02:30, second pass (UTC+1)
    save(ada, "2026-10-25T22:30:00", 30)  # 23:30 on the 25th (UTC+1)
    save(ada, "2026-10-25T23:00:00", 40)  # 00:00 on the 26th
    day = history(ada, view="day", date="2026-10-25")
    assert (day["total_focus_seconds"], day["session_count"]) == (110 * 60, 4)
    week = history(ada, view="week", date="2026-10-25")
    assert bars(week)["2026-10-25"] == 110 * 60
    assert bars(week)["2026-10-26"] == 40 * 60
    assert history(ada, view="week", date="2026-10-24")["total_focus_seconds"] == 10 * 60


# --- AC10.6: week start -------------------------------------------------------------------


def test_ac10_6_week_starts_on_sunday_by_default(ada: TestClient) -> None:
    save(ada, "2026-10-18T10:00:00", 20)  # Sunday
    save(ada, "2026-10-24T10:00:00", 30)  # Saturday
    save(ada, "2026-10-25T10:00:00", 40)  # next Sunday
    out = history(ada, view="week", date="2026-10-21")
    assert out["week_start_day"] == 0
    assert (out["start"], out["end"]) == ("2026-10-18", "2026-10-24")
    assert [b["date"] for b in out["buckets"]] == [f"2026-10-{n}" for n in range(18, 25)]
    assert out["total_focus_seconds"] == 50 * 60


def test_ac10_6_week_follows_a_monday_week_start(ada: TestClient) -> None:
    assert ada.patch("/api/settings", json={"week_start_day": 1}).status_code == 200
    save(ada, "2026-10-18T10:00:00", 20)  # Sunday: end of the previous week
    save(ada, "2026-10-19T10:00:00", 30)  # Monday
    save(ada, "2026-10-25T10:00:00", 40)  # Sunday: last day of this week
    out = history(ada, view="week", date="2026-10-21")
    assert out["week_start_day"] == 1
    assert (out["start"], out["end"]) == ("2026-10-19", "2026-10-25")
    assert out["total_focus_seconds"] == 70 * 60
    previous = history(ada, view="week", date="2026-10-18")
    assert (previous["start"], previous["total_focus_seconds"]) == ("2026-10-12", 20 * 60)


def test_ac10_6_week_boundary_uses_the_local_day(ada: TestClient) -> None:
    # 22:30Z on Saturday 24 October is 00:30 on Sunday the 25th in Paris: next Sunday week.
    save(ada, "2026-10-24T22:30:00", 20)
    assert history(ada, view="week", date="2026-10-24")["session_count"] == 0
    assert history(ada, view="week", date="2026-10-25")["session_count"] == 1


# --- AC10.7: archived ---------------------------------------------------------------------


def test_ac10_7_archived_sessions_are_excluded(ada: TestClient) -> None:
    kept = save(ada, "2026-10-23T08:00:00", 20)
    archived = save(ada, "2026-10-23T09:00:00", 30, "study")
    assert ada.post(f"/api/sessions/{archived}/archive").status_code == 200
    for out in (
        history(ada, view="day", date="2026-10-23"),
        history(ada, view="all"),
        history(ada, view="week", date="2026-10-23", tag=["study"]),
    ):
        assert archived not in [s["id"] for s in out["sessions"]]
        assert "study" not in [t["tag"] for t in out["tags"]]
    day = history(ada, view="day", date="2026-10-23")
    assert ([s["id"] for s in day["sessions"]], day["total_focus_seconds"]) == ([kept], 20 * 60)
    # Restoring brings it back (AC11.5).
    assert ada.post(f"/api/sessions/{archived}/restore").status_code == 200
    assert history(ada, view="day", date="2026-10-23")["session_count"] == 2


# --- AC1.3: isolation ---------------------------------------------------------------------


def test_ac1_3_history_only_shows_the_users_own_sessions(ada: TestClient, bob: TestClient) -> None:
    mine = save(ada, "2026-10-23T08:00:00", 20)
    save(bob, "2026-10-23T09:00:00", 30)
    assert bob.patch("/api/settings", json={"week_start_day": 1}).status_code == 200
    out = history(ada, view="all")
    assert [s["id"] for s in out["sessions"]] == [mine]
    assert out["total_focus_seconds"] == 20 * 60
    # Bob's week start doesn't leak into Ada's weeks.
    assert history(ada, view="week", date="2026-10-23")["start"] == "2026-10-18"
    assert history(bob, view="week", date="2026-10-23")["start"] == "2026-10-19"
    assert history(bob, view="day", date="2026-10-23")["total_focus_seconds"] == 30 * 60


def test_ac1_2_history_needs_sign_in(ada: TestClient) -> None:
    assert ada.post("/api/auth/signout").status_code == 204
    r = ada.get("/api/history", params={"view": "all", "tz": PARIS})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"


# --- errors -------------------------------------------------------------------------------


@pytest.mark.parametrize("tz", ["UTC", "Asia/Calcutta", "US/Eastern", "Asia/Kathmandu"])
def test_tz_database_names_including_links_are_accepted(ada: TestClient, tz: str) -> None:
    save(ada, "2026-10-23T08:00:00", 20)
    out = history(ada, view="all", tz=tz)
    assert (out["time_zone"], out["session_count"]) == (tz, 1)


def test_custom_range_edge_month_bars_cover_only_days_in_the_range(ada: TestClient) -> None:
    save(ada, "2026-09-10T08:00:00", 20)  # before the range, same month as the first bar
    save(ada, "2026-09-20T08:00:00", 30)
    save(ada, "2026-12-05T08:00:00", 40)
    save(ada, "2026-12-20T08:00:00", 50)  # after the range, same month as the last bar
    out = history(ada, view="custom", start="2026-09-15", end="2026-12-10", tag=["work"])
    assert out["bucket"] == "month"
    assert bars(out) == {
        "2026-09-01": 30 * 60,
        "2026-10-01": 0,
        "2026-11-01": 0,
        "2026-12-01": 40 * 60,
    }


@pytest.mark.parametrize("tz", ["Mars/Olympus", "europe/paris", "../../etc/passwd", "", "x" * 65])
def test_unknown_time_zone_is_422(ada: TestClient, tz: str) -> None:
    assert errors(ada, view="all", tz=tz) == ["tz"]


@pytest.mark.parametrize(
    ("params", "field"),
    [
        ({"view": "all"}, "tz"),  # tz is required
        ({"view": "year", "tz": PARIS}, "view"),
        ({"view": "day", "tz": PARIS}, "date"),
        ({"view": "week", "tz": PARIS, "date": "2026-02-30"}, "date"),
        ({"view": "month", "tz": PARIS, "date": "2026-10-01", "start": "2026-10-01"}, "start"),
        ({"view": "custom", "tz": PARIS, "start": "2026-10-01"}, "end"),
        ({"view": "custom", "tz": PARIS, "end": "2026-10-01"}, "start"),
        ({"view": "custom", "tz": PARIS, "start": "2026-10-02", "end": "2026-10-01"}, "end"),
        (
            {
                "view": "custom",
                "tz": PARIS,
                "start": "2026-10-01",
                "end": "2026-10-02",
                "date": "2026-10-01",
            },
            "date",
        ),
        ({"view": "custom", "tz": PARIS, "start": "1926-10-24", "end": "2026-10-24"}, "end"),
        ({"view": "all", "tz": PARIS, "date": "2026-10-01"}, "date"),
        ({"view": "all", "tz": PARIS, "tag": "Work"}, "tag.0"),
        ({"view": "all", "tz": PARIS, "tag": "games"}, "tag.0"),
    ],
)
def test_invalid_parameters_are_422(ada: TestClient, params: dict[str, Any], field: str) -> None:
    assert errors(ada, **params) == [field]


def test_custom_range_of_100_years_is_accepted(ada: TestClient) -> None:
    out = history(ada, view="custom", start="1926-10-24", end="2026-10-23")
    assert out["bucket"] == "month"
    assert len(out["buckets"]) == 1201


def test_calendar_edges_do_not_crash(ada: TestClient) -> None:
    week = history(ada, view="week", date="0001-01-01", tz="Pacific/Kiritimati")
    assert (week["start"], week["end"]) == ("0001-01-01", "0001-01-06")
    assert history(ada, view="month", date="9999-12-31", tz="Etc/GMT+12")["end"] == "9999-12-31"


def test_goals_are_not_logged(ada: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    save(ada, "2026-10-23T08:00:00", 20, goal="Very private goal")
    with caplog.at_level(logging.DEBUG):
        assert history(ada, view="all")["sessions"][0]["goal"] == "Very private goal"
        errors(ada, view="custom", tz=PARIS, start="2026-10-02", end="2026-10-01")
    assert "Very private goal" not in caplog.text
