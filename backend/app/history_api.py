"""History API (F10, #11): totals, tag breakdown, chart buckets and the session list.

Scoped to the signed-in user (AC1.3); archived sessions are excluded (AC10.7). Grouping is
in `app.history`. Privacy: goals are returned to their owner but never logged.
"""

import datetime as dt
from typing import Annotated, Any

from fastapi import APIRouter, Query
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.deps import CurrentUser, DbSession
from app.errors import ErrorResponse
from app.history import (
    BucketUnit,
    Totals,
    View,
    resolve_range,
    summarize,
    time_zone,
    utc_window,
    within_custom_limit,
)
from app.models import FocusSession, Tag, UserSettings
from app.sessions import SessionOut

router = APIRouter(prefix="/api", tags=["history"])

_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "Not signed in"}
}


class TagTotal(BaseModel):
    tag: Tag
    focus_seconds: int
    sessions: int


class Bucket(BaseModel):
    date: dt.date = Field(description="First day of the bar: the day, or the 1st of the month")
    focus_seconds: int
    sessions: int


class HistoryOut(BaseModel):
    view: View
    time_zone: str
    week_start_day: int = Field(description="0 = Sunday ... 6 = Saturday, from settings")
    start: dt.date | None = Field(
        description="First local date covered (inclusive); null for All time with no sessions"
    )
    end: dt.date | None = Field(description="Last local date covered (inclusive)")
    bucket: BucketUnit = Field(description="What one chart bar covers")
    total_focus_seconds: int
    session_count: int
    tags: list[TagTotal] = Field(description="Tags with sessions in the view, most focus first")
    buckets: list[Bucket] = Field(description="One per day or month of the range, zero-filled")
    sessions: list[SessionOut] = Field(description="Newest first")


def _invalid(field: str, message: str) -> RequestValidationError:
    error = {"loc": ("query", field), "msg": message, "type": "value_error"}
    return RequestValidationError([error])


def _check_params(
    view: View, anchor: dt.date | None, start: dt.date | None, end: dt.date | None
) -> None:
    """Each view takes exactly its own parameters, so a client mistake isn't silently ignored."""
    if view in (View.DAY, View.WEEK, View.MONTH):
        if anchor is None:
            raise _invalid("date", f"Required for the {view} view")
        if start is not None or end is not None:
            raise _invalid("start" if start is not None else "end", f"Not used by the {view} view")
    elif view is View.CUSTOM:
        if anchor is not None:
            raise _invalid("date", "Not used by the custom view; send start and end")
        if start is None or end is None:
            raise _invalid("start" if start is None else "end", "Required for the custom view")
        if end < start:
            raise _invalid("end", "End date is before start date")
        if not within_custom_limit(start, end):
            raise _invalid("end", "A custom range must end less than 100 years after it starts")
    else:
        for name, value in (("date", anchor), ("start", start), ("end", end)):
            if value is not None:
                raise _invalid(name, "Not used by the all view")


def _totals(t: Totals) -> dict[str, int]:
    return {"focus_seconds": t.focus_seconds, "sessions": t.sessions}


@router.get("/history", responses=_ERRORS)
async def get_history(
    user: CurrentUser,
    db: DbSession,
    view: View,
    tz: Annotated[
        str, Query(max_length=64, description="IANA time zone, e.g. Europe/Paris (AC10.5)")
    ],
    anchor: Annotated[
        dt.date | None,
        Query(alias="date", description="Any local date in the day, week or month to show"),
    ] = None,
    start: Annotated[dt.date | None, Query(description="Custom range start (inclusive)")] = None,
    end: Annotated[dt.date | None, Query(description="Custom range end (inclusive)")] = None,
    tag: Annotated[
        list[Tag] | None,
        Query(description="Repeat to filter by any of several tags (AC10.2); none = all"),
    ] = None,
) -> HistoryOut:
    """One history view (AC10.1-AC10.7).

    `view=day|week|month` takes `date`; `view=custom` takes `start` and `end` (inclusive, at
    most 100 years); `view=all` takes neither. Days follow `tz`, and a session counts on the
    local day it started (AC10.5). Weeks start on the user's week-start setting (AC10.6).
    Bars are per day, except per month for All time and custom ranges over 62 days (AC10.3).
    Archived sessions are excluded (AC10.7).
    """
    try:
        zone = time_zone(tz)
    except ValueError:
        raise _invalid("tz", "Unknown time zone; use an IANA name such as Europe/Paris") from None
    _check_params(view, anchor, start, end)
    week_start_day = (
        await db.scalar(select(UserSettings.week_start_day).where(UserSettings.user_id == user.id))
        or 0
    )
    date_range = resolve_range(view, anchor, start, end, week_start_day)

    query = select(FocusSession).where(
        FocusSession.user_id == user.id, FocusSession.archived_at.is_(None)
    )
    if tag:
        query = query.where(FocusSession.tag.in_({t.value for t in tag}))
    if date_range is not None:
        lo, hi = utc_window(date_range)
        query = query.where(FocusSession.started_at >= lo, FocusSession.started_at < hi)
    rows = (
        await db.scalars(query.order_by(FocusSession.started_at.desc(), FocusSession.id.desc()))
    ).all()

    summary = summarize(rows, zone, view, date_range)
    covered = summary.date_range
    return HistoryOut(
        view=view,
        time_zone=tz,
        week_start_day=week_start_day,
        start=covered.start if covered else None,
        end=covered.end if covered else None,
        bucket=summary.unit,
        total_focus_seconds=summary.total.focus_seconds,
        session_count=summary.total.sessions,
        tags=[TagTotal(tag=Tag(t), **_totals(v)) for t, v in summary.tags],
        buckets=[Bucket(date=d, **_totals(v)) for d, v in summary.buckets],
        sessions=[SessionOut.model_validate(r, from_attributes=True) for r in summary.sessions],
    )
