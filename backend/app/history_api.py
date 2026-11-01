"""History API (F10, #11): totals, tag breakdown, chart buckets and the session list.

Scoped to the signed-in user (AC1.3); archived sessions are excluded (AC10.7). Grouping is
in `app.history`. Privacy: goals are returned to their owner but never logged.
"""

import datetime as dt
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Query
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, and_, or_, select

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
from app.metrics import HISTORY_LOAD_DURATION, HISTORY_LOADS, observe
from app.models import CustomTag, FocusSession, UserSettings
from app.models.enums import TAGS
from app.sessions import SessionOut, _out
from app.tags_api import TagValue, unknown_tag_error

router = APIRouter(prefix="/api", tags=["history"])

_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "Not signed in"}
}


class TagTotal(BaseModel):
    tag: str = Field(description="A built-in tag identifier or a custom tag's id")
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


def _tag_filter(tags: list[str], owned: set[str]) -> ColumnElement[bool]:
    """Sessions whose tag, as the API shows it, is one of `tags` (AC10.2). A custom tag is
    stored as `work` plus its id, and a row with another built-in `tag` next to an id was
    changed by the release before, so it counts as that built-in tag (`app.models.tag_ref`)."""
    for index, value in enumerate(tags):
        if value not in TAGS and value not in owned:
            raise unknown_tag_error("query", "tag", index)
    wanted = set(tags)
    others = [t for t in TAGS if t in wanted and t != "work"]
    custom = [uuid.UUID(t) for t in wanted if t not in TAGS]
    parts: list[ColumnElement[bool]] = []
    if others:
        parts.append(FocusSession.tag.in_(others))
    if "work" in wanted:
        parts.append(and_(FocusSession.tag == "work", FocusSession.custom_tag_id.is_(None)))
    if custom:
        parts.append(and_(FocusSession.tag == "work", FocusSession.custom_tag_id.in_(custom)))
    return or_(*parts)


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
        list[TagValue] | None,
        Query(
            description="Repeat to filter by any of several tags, built-in or the user's own "
            "custom tags, removed ones included (AC10.2); none = all"
        ),
    ] = None,
) -> HistoryOut:
    """One history view (AC10.1-AC10.7).

    `view=day|week|month` takes `date`; `view=custom` takes `start` and `end` (inclusive, at
    most 100 years); `view=all` takes neither. Days follow `tz`, and a session counts on the
    local day it started (AC10.5). Weeks start on the user's week-start setting (AC10.6).
    Bars are per day, except per month for All time and custom ranges over 62 days (AC10.3).
    Archived sessions are excluded (AC10.7).
    """
    with observe(HISTORY_LOADS, HISTORY_LOAD_DURATION, client_outcome="invalid"):
        try:
            zone = time_zone(tz)
        except ValueError:
            raise _invalid(
                "tz", "Unknown time zone; use an IANA name such as Europe/Paris"
            ) from None
        _check_params(view, anchor, start, end)
        week_start_day = (
            await db.scalar(
                select(UserSettings.week_start_day).where(UserSettings.user_id == user.id)
            )
            or 0
        )
        date_range = resolve_range(view, anchor, start, end, week_start_day)

        # AC7.8's order of tags: the built-in ones, then custom tags oldest first.
        custom_ids = [
            str(i)
            for i in await db.scalars(
                select(CustomTag.id)
                .where(CustomTag.user_id == user.id)
                .order_by(CustomTag.created_at, CustomTag.id)
            )
        ]
        tag_order = {t: i for i, t in enumerate([*TAGS, *custom_ids])}
        query = select(FocusSession).where(
            FocusSession.user_id == user.id, FocusSession.archived_at.is_(None)
        )
        if tag:
            query = query.where(_tag_filter(tag, set(custom_ids)))
        if date_range is not None:
            lo, hi = utc_window(date_range)
            query = query.where(FocusSession.started_at >= lo, FocusSession.started_at < hi)
        rows = (
            await db.scalars(query.order_by(FocusSession.started_at.desc(), FocusSession.id.desc()))
        ).all()

        summary = summarize([_out(r) for r in rows], zone, view, date_range, tag_order)
        covered = summary.date_range
        HISTORY_LOADS.add(1, {"outcome": "ok"})
        return HistoryOut(
            view=view,
            time_zone=tz,
            week_start_day=week_start_day,
            start=covered.start if covered else None,
            end=covered.end if covered else None,
            bucket=summary.unit,
            total_focus_seconds=summary.total.focus_seconds,
            session_count=summary.total.sessions,
            tags=[TagTotal(tag=t, **_totals(v)) for t, v in summary.tags],
            buckets=[Bucket(date=d, **_totals(v)) for d, v in summary.buckets],
            sessions=summary.sessions,
        )
