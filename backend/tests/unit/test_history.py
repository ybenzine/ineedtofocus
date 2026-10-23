"""History grouping (F10, #11): ranges, time zones, week starts and buckets."""

import datetime as dt
from dataclasses import dataclass
from zoneinfo import ZoneInfo

import pytest

from app.history import (
    DateRange,
    View,
    bucket_starts,
    bucket_unit,
    local_date,
    month_of,
    resolve_range,
    summarize,
    time_zone,
    utc_window,
    week_of,
    within_custom_limit,
)

PARIS = ZoneInfo("Europe/Paris")
NEW_YORK = ZoneInfo("America/New_York")
SUNDAY, MONDAY, SATURDAY = 0, 1, 6


@dataclass(frozen=True)
class S:
    started_at: dt.datetime
    focus_seconds: int
    tag: str = "work"


def utc(text: str) -> dt.datetime:
    return dt.datetime.fromisoformat(text).replace(tzinfo=dt.UTC)


def d(text: str) -> dt.date:
    return dt.date.fromisoformat(text)


# --- time zones ---------------------------------------------------------------------------


def test_time_zone_accepts_iana_names() -> None:
    assert time_zone("Europe/Paris") == PARIS
    assert time_zone("UTC") == ZoneInfo("UTC")


@pytest.mark.parametrize(
    "name", ["Mars/Olympus", "", "europe/paris", "../../etc/passwd", "/etc/localtime", "+02:00"]
)
def test_time_zone_rejects_unknown_names(name: str) -> None:
    with pytest.raises(ValueError):
        time_zone(name)


# --- AC10.5: local days ---------------------------------------------------------------------


def test_ac10_5_local_date_follows_the_time_zone() -> None:
    instant = utc("2026-10-23T23:30:00")
    assert local_date(instant, PARIS) == d("2026-10-24")
    assert local_date(instant, NEW_YORK) == d("2026-10-23")


def test_ac10_5_session_crossing_midnight_counts_on_its_start_day() -> None:
    # 23:00-01:00 Paris time on 23-24 October (summer time, UTC+2).
    late = S(utc("2026-10-23T21:00:00"), 7200)
    summary = summarize([late], PARIS, View.WEEK, DateRange(d("2026-10-18"), d("2026-10-24")))
    by_day = {day: t.focus_seconds for day, t in summary.buckets}
    assert by_day[d("2026-10-23")] == 7200
    assert by_day[d("2026-10-24")] == 0


def test_ac10_5_session_started_before_the_range_is_not_counted_even_if_it_ends_in_it() -> None:
    # Starts 23:30 Paris on the 22nd, ends after midnight: belongs to the 22nd, not the 23rd.
    s = S(utc("2026-10-22T21:30:00"), 3600)
    summary = summarize([s], PARIS, View.DAY, DateRange(d("2026-10-23"), d("2026-10-23")))
    assert summary.total.sessions == 0
    assert summary.sessions == []


def test_utc_window_covers_every_zone() -> None:
    lo, hi = utc_window(DateRange(d("2026-10-23"), d("2026-10-23")))
    for zone in ("Pacific/Kiritimati", "Etc/GMT+12", "Europe/Paris"):
        z = ZoneInfo(zone)
        first = dt.datetime.combine(d("2026-10-23"), dt.time.min, z)
        last = dt.datetime.combine(d("2026-10-23"), dt.time.max, z)
        assert lo <= first and last < hi


def test_utc_window_clamps_at_the_ends_of_the_calendar() -> None:
    lo, hi = utc_window(DateRange(dt.date.min, dt.date.max))
    assert lo == dt.datetime.min.replace(tzinfo=dt.UTC)
    assert hi == dt.datetime.max.replace(tzinfo=dt.UTC)


def test_local_date_clamps_at_the_ends_of_the_calendar() -> None:
    kiritimati = ZoneInfo("Pacific/Kiritimati")
    assert local_date(dt.datetime.max.replace(tzinfo=dt.UTC), kiritimati) == dt.date.max
    assert local_date(dt.datetime.min.replace(tzinfo=dt.UTC), ZoneInfo("Etc/GMT+12")) == (
        dt.date.min
    )


# --- DST --------------------------------------------------------------------------------------


def test_dst_spring_forward_day_has_23_hours_and_keeps_its_sessions() -> None:
    # 2026-03-29 in Paris: 02:00 -> 03:00. Local midnight is 23:00Z the day before; the next
    # midnight is 22:00Z.
    first = S(utc("2026-03-28T23:00:00"), 600)  # 00:00 local on the 29th
    last = S(utc("2026-03-29T21:59:00"), 60)  # 23:59 local on the 29th
    after = S(utc("2026-03-29T22:00:00"), 120)  # 00:00 local on the 30th
    before = S(utc("2026-03-28T22:59:00"), 180)  # 23:59 local on the 28th
    summary = summarize(
        [after, last, first, before], PARIS, View.DAY, DateRange(d("2026-03-29"), d("2026-03-29"))
    )
    assert summary.total.focus_seconds == 660
    assert summary.total.sessions == 2


def test_dst_fall_back_day_has_25_hours_and_keeps_its_sessions() -> None:
    # 2026-10-25 in Paris: 03:00 -> 02:00. Local midnight is 22:00Z the day before; the next
    # midnight is 23:00Z.
    first = S(utc("2026-10-24T22:00:00"), 600)  # 00:00 local on the 25th
    last = S(utc("2026-10-25T22:59:00"), 60)  # 23:59 local on the 25th (UTC+1)
    after = S(utc("2026-10-25T23:00:00"), 120)  # 00:00 local on the 26th
    before = S(utc("2026-10-24T21:59:00"), 180)  # 23:59 local on the 24th (UTC+2)
    summary = summarize(
        [after, last, first, before], PARIS, View.DAY, DateRange(d("2026-10-25"), d("2026-10-25"))
    )
    assert summary.total.focus_seconds == 660
    assert summary.total.sessions == 2


def test_dst_week_spanning_a_change_has_seven_day_buckets() -> None:
    summary = summarize(list[S](), PARIS, View.WEEK, week_of(d("2026-10-25"), SUNDAY))
    assert [day for day, _ in summary.buckets] == [
        d("2026-10-25") + dt.timedelta(days=i) for i in range(7)
    ]


# --- AC10.6: weeks ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("day", "week_start", "expected"),
    [
        # 2026-10-23 is a Friday.
        ("2026-10-23", SUNDAY, ("2026-10-18", "2026-10-24")),
        ("2026-10-23", MONDAY, ("2026-10-19", "2026-10-25")),
        ("2026-10-23", SATURDAY, ("2026-10-17", "2026-10-23")),
        # The start day itself, and the day before it.
        ("2026-10-18", SUNDAY, ("2026-10-18", "2026-10-24")),
        ("2026-10-18", MONDAY, ("2026-10-12", "2026-10-18")),
        ("2026-10-19", MONDAY, ("2026-10-19", "2026-10-25")),
        ("2026-10-24", SUNDAY, ("2026-10-18", "2026-10-24")),
        # Across a year end.
        ("2027-01-01", SUNDAY, ("2026-12-27", "2027-01-02")),
        ("2027-01-01", MONDAY, ("2026-12-28", "2027-01-03")),
    ],
)
def test_ac10_6_week_follows_the_week_start(
    day: str, week_start: int, expected: tuple[str, str]
) -> None:
    assert week_of(d(day), week_start) == DateRange(d(expected[0]), d(expected[1]))


def test_ac10_6_sunday_session_is_in_different_weeks_for_each_week_start() -> None:
    sunday = S(utc("2026-10-25T10:00:00"), 900)
    sunday_week = week_of(d("2026-10-25"), SUNDAY)
    monday_week = week_of(d("2026-10-25"), MONDAY)
    assert summarize([sunday], PARIS, View.WEEK, sunday_week).buckets[0][1].focus_seconds == 900
    assert summarize([sunday], PARIS, View.WEEK, monday_week).buckets[-1][1].focus_seconds == 900


def test_week_clamps_at_the_start_of_the_calendar() -> None:
    # 0001-01-01 is a Monday; its Sunday-start week would begin in year 0.
    assert week_of(dt.date.min, SUNDAY) == DateRange(dt.date.min, d("0001-01-06"))
    assert week_of(dt.date.max, SUNDAY).end == dt.date.max


# --- AC10.1: views ------------------------------------------------------------------------


def test_month_covers_the_calendar_month() -> None:
    assert month_of(d("2026-02-14")) == DateRange(d("2026-02-01"), d("2026-02-28"))
    assert month_of(d("2028-02-14")) == DateRange(d("2028-02-01"), d("2028-02-29"))
    assert month_of(d("2026-12-31")) == DateRange(d("2026-12-01"), d("2026-12-31"))


def test_resolve_range_for_each_view() -> None:
    anchor = d("2026-10-23")
    assert resolve_range(View.DAY, anchor, None, None, SUNDAY) == DateRange(anchor, anchor)
    assert resolve_range(View.WEEK, anchor, None, None, MONDAY) == week_of(anchor, MONDAY)
    assert resolve_range(View.MONTH, anchor, None, None, SUNDAY) == month_of(anchor)
    assert resolve_range(View.ALL, None, None, None, SUNDAY) is None
    assert resolve_range(View.CUSTOM, None, anchor, d("2026-11-02"), SUNDAY) == DateRange(
        anchor, d("2026-11-02")
    )
    with pytest.raises(ValueError):
        resolve_range(View.DAY, None, None, None, SUNDAY)
    with pytest.raises(ValueError):
        resolve_range(View.CUSTOM, None, anchor, None, SUNDAY)


# --- AC10.3: buckets ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("view", "days", "unit"),
    [
        (View.DAY, 1, "day"),
        (View.WEEK, 7, "day"),
        (View.MONTH, 31, "day"),
        (View.CUSTOM, 1, "day"),
        (View.CUSTOM, 62, "day"),
        (View.CUSTOM, 63, "month"),
        (View.ALL, 1, "month"),
    ],
)
def test_ac10_3_bucket_unit(view: View, days: int, unit: str) -> None:
    start = d("2026-01-01")
    assert bucket_unit(view, DateRange(start, start + dt.timedelta(days=days - 1))) == unit


def test_ac10_3_all_time_without_sessions_has_no_buckets() -> None:
    summary = summarize(list[S](), PARIS, View.ALL, None)
    assert summary.date_range is None
    assert summary.buckets == []
    assert summary.total.sessions == 0


def test_month_buckets_cross_the_year() -> None:
    starts = bucket_starts(DateRange(d("2026-11-15"), d("2027-02-03")), "month")
    assert starts == [d("2026-11-01"), d("2026-12-01"), d("2027-01-01"), d("2027-02-01")]


def test_ac10_3_all_time_runs_from_the_first_to_the_last_session_month() -> None:
    sessions = [
        S(utc("2026-10-02T08:00:00"), 600, "study"),
        S(utc("2026-08-31T22:30:00"), 300, "work"),  # 1 September in Paris
        S(utc("2026-07-10T08:00:00"), 900, "work"),
    ]
    summary = summarize(sessions, PARIS, View.ALL, None)
    assert summary.date_range == DateRange(d("2026-07-10"), d("2026-10-02"))
    assert summary.unit == "month"
    assert [(day, t.focus_seconds, t.sessions) for day, t in summary.buckets] == [
        (d("2026-07-01"), 900, 1),
        (d("2026-08-01"), 0, 0),
        (d("2026-09-01"), 300, 1),
        (d("2026-10-01"), 600, 1),
    ]


def test_ac10_3_totals_and_tag_breakdown() -> None:
    sessions = [
        S(utc("2026-10-23T08:00:00"), 600, "study"),
        S(utc("2026-10-22T08:00:00"), 1500, "work"),
        S(utc("2026-10-21T08:00:00"), 300, "read"),
        S(utc("2026-10-20T08:00:00"), 600, "nap"),
        S(utc("2026-10-19T08:00:00"), 120, "study"),
    ]
    summary = summarize(sessions, PARIS, View.WEEK, week_of(d("2026-10-23"), SUNDAY))
    assert (summary.total.focus_seconds, summary.total.sessions) == (3120, 5)
    # Most focus first; ties keep the AC7.1 tag order (study before nap).
    assert [(t, v.focus_seconds, v.sessions) for t, v in summary.tags] == [
        ("work", 1500, 1),
        ("study", 720, 2),
        ("nap", 600, 1),
        ("read", 300, 1),
    ]
    assert summary.sessions == sessions  # input order (newest first) is kept


@pytest.mark.parametrize(
    ("start", "end", "ok"),
    [
        ("1926-10-24", "2026-10-23", True),
        ("1926-10-24", "2026-10-24", False),
        ("2024-02-29", "2124-02-29", True),
        ("2024-02-29", "2124-03-01", False),
        ("9950-01-01", "9999-12-31", True),
    ],
)
def test_custom_range_must_end_less_than_100_years_after_it_starts(
    start: str, end: str, ok: bool
) -> None:
    assert within_custom_limit(d(start), d(end)) is ok
