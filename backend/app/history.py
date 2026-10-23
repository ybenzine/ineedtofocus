"""History grouping (F10, #11): pure functions, no database.

Sessions are stored in UTC. Grouping happens in the user's time zone: a session counts toward
the local day it started on, even if it runs past midnight (AC10.5). Weeks start on the user's
week-start day, 0 = Sunday ... 6 = Saturday (AC10.6).
"""

import calendar
import datetime as dt
from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import StrEnum
from functools import cache
from typing import Literal, Protocol
from zoneinfo import ZoneInfo, available_timezones

from app.models.enums import TAGS

# AC10.3 "by day for ... Custom ranges up to ~2 months": up to 62 days get one bar per day.
DAY_BUCKET_MAX_DAYS = 62
# A custom range ends less than 100 years after it starts, which bounds the month bars (1 201).
MAX_CUSTOM_YEARS = 100

BucketUnit = Literal["day", "month"]

_UTC_MIN = dt.datetime.min.replace(tzinfo=dt.UTC)
_UTC_MAX = dt.datetime.max.replace(tzinfo=dt.UTC)


class View(StrEnum):
    DAY = "day"
    WEEK = "week"
    MONTH = "month"
    ALL = "all"
    CUSTOM = "custom"


@cache
def _zone_names() -> frozenset[str]:
    return frozenset(available_timezones())


def time_zone(name: str) -> ZoneInfo:
    """The IANA zone called `name` (exact spelling, e.g. `Europe/Paris`); ValueError if unknown."""
    if name not in _zone_names():
        raise ValueError("Unknown time zone")
    return ZoneInfo(name)


@dataclass(frozen=True)
class DateRange:
    """Local calendar dates, both inclusive."""

    start: dt.date
    end: dt.date

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1


def within_custom_limit(start: dt.date, end: dt.date) -> bool:
    """True if `end` is earlier than the same date `MAX_CUSTOM_YEARS` after `start`."""
    year = start.year + MAX_CUSTOM_YEARS
    if year > dt.MAXYEAR:
        return True
    # 29 February maps to 1 March when the target year has no 29 February.
    limit = dt.date(year, 3, 1) if (start.month, start.day) == (2, 29) else start.replace(year=year)
    return end < limit


def _shift(day: dt.date, days: int) -> dt.date:
    """`day + days`, clamped to the representable dates."""
    try:
        return day + dt.timedelta(days=days)
    except OverflowError:
        return dt.date.min if days < 0 else dt.date.max


def week_of(day: dt.date, week_start_day: int) -> DateRange:
    """The 7-day week containing `day`, starting on `week_start_day` (0 = Sunday)."""
    sunday_based = (day.weekday() + 1) % 7  # date.weekday() has Monday = 0
    offset = (sunday_based - week_start_day) % 7  # days since the week started
    return DateRange(_shift(day, -offset), _shift(day, 6 - offset))


def month_of(day: dt.date) -> DateRange:
    last = calendar.monthrange(day.year, day.month)[1]
    return DateRange(day.replace(day=1), day.replace(day=last))


def resolve_range(
    view: View,
    anchor: dt.date | None,
    start: dt.date | None,
    end: dt.date | None,
    week_start_day: int,
) -> DateRange | None:
    """The dates a view covers; None for All time (it covers whatever the user has).

    The caller has already checked that the right parameters are present for the view.
    """
    if view is View.ALL:
        return None
    if view is View.CUSTOM:
        if start is None or end is None:
            raise ValueError("custom view needs start and end")
        return DateRange(start, end)
    if anchor is None:
        raise ValueError(f"{view} view needs an anchor date")
    if view is View.DAY:
        return DateRange(anchor, anchor)
    if view is View.WEEK:
        return week_of(anchor, week_start_day)
    return month_of(anchor)


def bucket_unit(view: View, date_range: DateRange | None) -> BucketUnit:
    """AC10.3: bars by day for Day, Week, Month and custom ranges up to ~2 months; by month
    for All time and longer ranges."""
    if view is View.ALL:
        return "month"
    if view is View.CUSTOM and date_range is not None and date_range.days > DAY_BUCKET_MAX_DAYS:
        return "month"
    return "day"


def utc_window(date_range: DateRange) -> tuple[dt.datetime, dt.datetime]:
    """A UTC interval `[lo, hi)` that contains every instant whose local date, in any time
    zone, falls in `date_range`. UTC offsets stay within a day, so a day of margin on each
    side is enough; the exact local-date check happens in `summarize`."""

    def at(day: dt.date, days: int) -> dt.datetime:
        try:
            return dt.datetime.combine(day, dt.time.min, dt.UTC) + dt.timedelta(days=days)
        except OverflowError:
            return _UTC_MIN if days < 0 else _UTC_MAX

    return at(date_range.start, -1), at(date_range.end, 2)


def local_date(instant: dt.datetime, zone: ZoneInfo) -> dt.date:
    """The calendar date of `instant` in `zone` (AC10.5), clamped at the ends of the calendar."""
    try:
        return instant.astimezone(zone).date()
    except OverflowError:
        return dt.date.max if instant.year > 1 else dt.date.min


def _bucket_key(day: dt.date, unit: BucketUnit) -> dt.date:
    return day if unit == "day" else day.replace(day=1)


def bucket_starts(date_range: DateRange, unit: BucketUnit) -> list[dt.date]:
    """The first day of every bucket covering `date_range`, in order."""
    if unit == "day":
        return [date_range.start + dt.timedelta(days=i) for i in range(date_range.days)]
    starts: list[dt.date] = []
    year, month = date_range.start.year, date_range.start.month
    while (year, month) <= (date_range.end.year, date_range.end.month):
        starts.append(dt.date(year, month, 1))
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return starts


class SessionLike(Protocol):
    @property
    def started_at(self) -> dt.datetime: ...
    @property
    def focus_seconds(self) -> int: ...
    @property
    def tag(self) -> str: ...


@dataclass
class Totals:
    focus_seconds: int = 0
    sessions: int = 0

    def add(self, focus_seconds: int) -> None:
        self.focus_seconds += focus_seconds
        self.sessions += 1


@dataclass
class Summary[S: SessionLike]:
    date_range: DateRange | None  # None: All time with no sessions
    unit: BucketUnit
    total: Totals
    tags: list[tuple[str, Totals]]  # tags that have sessions, most focus time first
    buckets: list[tuple[dt.date, Totals]]  # every bucket in the range, zero-filled, in order
    sessions: list[S] = field(default_factory=list)  # in the order given


def summarize[S: SessionLike](
    sessions: Iterable[S],
    zone: ZoneInfo,
    view: View,
    date_range: DateRange | None,
) -> Summary[S]:
    """Totals, per-tag totals, chart buckets and the sessions of a view (AC10.3, AC10.5).

    `sessions` may include rows outside the range (the database query uses a UTC window with
    margin); only those whose local start date is in the range are kept. For All time
    (`date_range` None) the range runs from the first to the last session's local date.
    """
    dated = [(local_date(s.started_at, zone), s) for s in sessions]
    if date_range is None:
        if dated:
            days = [d for d, _ in dated]
            date_range = DateRange(min(days), max(days))
    else:
        dated = [(d, s) for d, s in dated if date_range.start <= d <= date_range.end]
    unit = bucket_unit(view, date_range)
    buckets: dict[dt.date, Totals] = {}
    if date_range is not None:
        buckets = {start: Totals() for start in bucket_starts(date_range, unit)}
    total = Totals()
    by_tag: dict[str, Totals] = {}
    for day, s in dated:
        total.add(s.focus_seconds)
        by_tag.setdefault(s.tag, Totals()).add(s.focus_seconds)
        buckets[_bucket_key(day, unit)].add(s.focus_seconds)
    tag_order = {t: i for i, t in enumerate(TAGS)}
    tags = sorted(by_tag.items(), key=lambda kv: (-kv[1].focus_seconds, tag_order.get(kv[0], 99)))
    return Summary(
        date_range=date_range,
        unit=unit,
        total=total,
        tags=tags,
        buckets=list(buckets.items()),
        sessions=[s for _, s in dated],
    )
