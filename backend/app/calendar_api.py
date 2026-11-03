"""Calendar export (F14, AC14.1-AC14.8, #381): the private subscription feed, the History
download and the management of the feed link.

The feed is read without signing in, by a calendar app holding the link's secret. Only the
secret's SHA-256 hash is stored (like sign-in tokens), and it is compared through an indexed
lookup on that hash. Privacy: the secret, goals and custom tag names never reach logs, spans
or metrics, and no response repeats them (AC14.8). The access log is off (logging_config), and
the span path is the route template `/api/calendar/{secret}.ics`.
"""

import asyncio
import datetime as dt
import logging
import re
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, literal_column, select, update
from sqlalchemy.dialects.postgresql import insert

from app.calendar_ics import (
    CalendarSettings,
    EventSession,
    export_filename,
    matches_etag,
    render_calendar,
)
from app.deps import CurrentUser, DbSession
from app.errors import ErrorResponse
from app.history import View, local_date, time_zone
from app.history_api import (
    DateParam,
    EndParam,
    StartParam,
    TagParam,
    TzParam,
    select_view_sessions,
)
from app.models import CalendarFeed, CustomTag, FocusSession, UserSettings
from app.models.enums import (
    CALENDAR_NAME_DEFAULT,
    CALENDAR_TITLE_DEFAULT,
    TAG_DISPLAY_NAMES,
    TAGS,
)
from app.models.tag_ref import effective_tag
from app.rate_limit import FailureLimiter, client_key
from app.security import new_token, token_hash
from app.telemetry import tag_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/calendar", tags=["calendar"])

# Calendar apps poll on a schedule (hourly at most, AC14.2), often several at once from one
# address: generous per client address, with a tighter limit on unknown secrets (guessing).
# Both budgets are shared by everything behind one fetcher address (Google and iCloud fetch for
# many users from shared servers) or one IPv6 /64, so the unknown-secret budget only gates
# requests whose lookup fails: a valid secret is always served, within the general limit.
FEED_MAX_PER_CLIENT = 300
FEED_WINDOW_SECONDS = 300.0
BAD_SECRET_MAX_PER_CLIENT = 20
BAD_SECRET_WINDOW_SECONDS = 900.0
# `last_fetched_at` moves at most this often per feed.
FETCHED_AT_RESOLUTION = dt.timedelta(minutes=1)

# secrets.token_urlsafe(32): 43 URL-safe characters. Anything else is not a secret we made.
_SECRET = re.compile(r"[A-Za-z0-9_-]{43}")
_BUILTIN_NAMES = dict(zip(TAGS, TAG_DISPLAY_NAMES, strict=True))
_ICS = "text/calendar; charset=utf-8"

_UNAUTHORIZED: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "Not signed in"}
}
_ICS_BODY: dict[int | str, dict[str, Any]] = {
    200: {"content": {"text/calendar": {"schema": {"type": "string"}}}, "description": "iCalendar"}
}


def new_limiters() -> tuple[FailureLimiter, FailureLimiter]:
    """(every feed request per client, requests with an unknown secret per client). The pair
    limit of the second is out of reach on purpose: only the client count matters."""
    return (
        FailureLimiter(FEED_MAX_PER_CLIENT, FEED_MAX_PER_CLIENT, FEED_WINDOW_SECONDS),
        FailureLimiter(10**9, BAD_SECRET_MAX_PER_CLIENT, BAD_SECRET_WINDOW_SECONDS),
    )


class FeedStatus(BaseModel):
    enabled: bool = Field(description="Whether a link exists. The link itself is never returned")
    created_at: dt.datetime | None
    last_fetched_at: dt.datetime | None = Field(
        description="When a calendar app last fetched the feed (to the minute); null = not yet"
    )


class FeedCreated(BaseModel):
    path: str = Field(
        description="`/api/calendar/<secret>.ics`, returned once; the app adds its own origin"
    )
    created_at: dt.datetime


@dataclass(frozen=True)
class _Settings:
    calendar: CalendarSettings
    name: str
    min_minutes: int
    excluded: frozenset[str]


async def _settings(db: DbSession, user_id: uuid.UUID) -> _Settings:
    row = (
        await db.execute(
            select(
                UserSettings.calendar_title_template,
                UserSettings.calendar_include_goal,
                UserSettings.calendar_include_description,
                UserSettings.calendar_excluded_tags,
                UserSettings.calendar_min_minutes,
                UserSettings.calendar_name,
            ).where(UserSettings.user_id == user_id)
        )
    ).first()
    if row is None:  # no settings row yet: the defaults
        return _Settings(
            CalendarSettings(CALENDAR_TITLE_DEFAULT, True, True),
            CALENDAR_NAME_DEFAULT,
            0,
            frozenset(),
        )
    return _Settings(
        CalendarSettings(
            row.calendar_title_template, row.calendar_include_goal, row.calendar_include_description
        ),
        row.calendar_name,
        row.calendar_min_minutes,
        frozenset(row.calendar_excluded_tags),
    )


async def _tag_names(db: DbSession, user_id: uuid.UUID) -> dict[str, str]:
    """Display names by tag value: the built-in ones, and the user's custom tags by id
    (their current names, removed tags included, AC14.2)."""
    names = dict(_BUILTIN_NAMES)
    rows = await db.execute(
        select(CustomTag.id, CustomTag.name).where(CustomTag.user_id == user_id)
    )
    names.update({str(tag_id): name for tag_id, name in rows})
    return names


def _events(
    rows: Iterable[Any], names: dict[str, str], excluded: frozenset[str] = frozenset()
) -> list[EventSession]:
    """Events for session rows (ORM objects or column rows), skipping excluded tags."""
    events: list[EventSession] = []
    for r in rows:
        tag = effective_tag(r.tag, r.custom_tag_id)
        if tag in excluded:
            continue
        mode_config = r.mode_config
        events.append(
            EventSession(
                id=str(r.id),
                mode=r.mode,
                tag_name=names.get(tag, "Tag"),
                goal=r.goal,
                started_at=r.started_at,
                ended_at=r.ended_at,
                focus_seconds=r.focus_seconds,
                paused_seconds=r.paused_seconds,
                ended_early=r.status == "ended_early",
                blocks=mode_config.get("blocks") if r.mode == "pomodoro" else None,
                blocks_completed=r.blocks_completed,
            )
        )
    return events


def _ics(request: Request, body: bytes, **headers: str) -> Response:
    """The calendar response. A HEAD gets the GET's headers, Content-Length too, and no body."""
    if request.method == "HEAD":
        return Response(
            content=b"", media_type=_ICS, headers={**headers, "Content-Length": str(len(body))}
        )
    return Response(content=body, media_type=_ICS, headers=headers)


def _origin(request: Request) -> str:
    """The origin the request reached (scheme from Caddy's X-Forwarded-Proto, which uvicorn
    trusts from Caddy only), used for the History link in each event."""
    return str(request.base_url).rstrip("/")


def _limited(wait: int) -> HTTPException:
    return HTTPException(
        429, "Too many requests. Try again later.", headers={"Retry-After": str(wait)}
    )


def _not_found() -> HTTPException:
    return HTTPException(404, "Not Found")


_FEED_ERRORS: dict[int | str, dict[str, Any]] = {
    **_ICS_BODY,
    304: {"description": "The feed has not changed since `If-None-Match`"},
    404: {"model": ErrorResponse, "description": "Unknown, reset or turned-off link"},
    429: {"model": ErrorResponse, "description": "Too many requests; see Retry-After"},
}


# Declared before `/{secret}.ics`, which would also match `export.ics`.
@router.head("/export.ics", include_in_schema=False)  # same handler; not a second operation
@router.get("/export.ics", response_class=Response, responses={**_UNAUTHORIZED, **_ICS_BODY})
async def download_history(
    request: Request,
    user: CurrentUser,
    db: DbSession,
    view: View,
    tz: TzParam,
    anchor: DateParam = None,
    start: StartParam = None,
    end: EndParam = None,
    tag: TagParam = None,
) -> Response:
    """The sessions a History view counts (AC14.6), as an `.ics` file. Takes the parameters of
    `GET /api/history` and validates them the same way. Sessions under the minimum length are
    left out; the calendar's tag setting doesn't apply (the History filter already chose)."""
    picked = await select_view_sessions(db, user, view, tz, anchor, start, end, tag)
    settings = await _settings(db, user.id)
    names = await _tag_names(db, user.id)
    date_range = picked.date_range
    floor = settings.min_minutes * 60
    rows = [
        r
        for r in picked.rows
        if r.focus_seconds >= floor
        and (
            date_range is None
            or date_range.start <= local_date(r.started_at, picked.zone) <= date_range.end
        )
    ]
    rendered = await asyncio.to_thread(
        render_calendar,
        _events(rows, names),
        settings.calendar,
        name=settings.name,
        origin=_origin(request),
        feed=False,
        now=dt.datetime.now(dt.UTC),
    )
    filename = export_filename(
        date_range.start.isoformat() if date_range else None,
        date_range.end.isoformat() if date_range else None,
    )
    return _ics(
        request,
        rendered.body,
        **{
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@router.head("/session/{session_id}.ics", include_in_schema=False)
@router.get(
    "/session/{session_id}.ics",
    response_class=Response,
    responses={
        **_UNAUTHORIZED,
        **_ICS_BODY,
        404: {"model": ErrorResponse, "description": "Not found, not yours, or archived"},
    },
)
async def download_session(
    session_id: str, request: Request, user: CurrentUser, db: DbSession, tz: TzParam = "UTC"
) -> Response:
    """One of the caller's sessions as a single-event `.ics` (AC14.7, #454), for iOS, which
    opens an https `text/calendar` response in Calendar's sheet. The event is the feed's, with
    the same title, goal and description settings; the tag and minimum-length filters don't
    apply. A session that doesn't exist, isn't the caller's or is archived is the same plain
    404. `tz` (IANA name, default UTC) only sets the local date and time in the file name."""
    try:
        zone = time_zone(tz)
    except ValueError:
        raise RequestValidationError(
            [
                {
                    "loc": ("query", "tz"),
                    "msg": "Unknown time zone; use an IANA name such as Europe/Paris",
                    "type": "value_error",
                }
            ]
        ) from None
    try:
        wanted = uuid.UUID(session_id)
    except ValueError:
        raise _not_found() from None
    row = (
        await db.execute(
            select(
                FocusSession.id,
                FocusSession.mode,
                FocusSession.tag,
                FocusSession.custom_tag_id,
                FocusSession.goal,
                FocusSession.started_at,
                FocusSession.ended_at,
                FocusSession.focus_seconds,
                FocusSession.paused_seconds,
                FocusSession.status,
                FocusSession.mode_config,
                FocusSession.blocks_completed,
            ).where(
                FocusSession.id == wanted,
                FocusSession.user_id == user.id,
                FocusSession.archived_at.is_(None),
            )
        )
    ).first()
    if row is None:
        raise _not_found()
    settings = await _settings(db, user.id)
    names = await _tag_names(db, user.id)
    rendered = await asyncio.to_thread(
        render_calendar,
        _events([row], names),
        settings.calendar,
        name=settings.name,
        origin=_origin(request),
        feed=False,
        now=dt.datetime.now(dt.UTC),
    )
    local = row.started_at.astimezone(zone)
    filename = f"ineedtofocus-{local:%Y-%m-%d-%H%M}.ics"
    return _ics(
        request,
        rendered.body,
        **{
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@router.head("/{secret}.ics", include_in_schema=False)
@router.get("/{secret}.ics", response_class=Response, responses=_FEED_ERRORS)
async def subscription_feed(secret: str, request: Request, db: DbSession) -> Response:
    """The private subscription feed (AC14.4, AC14.5), read without signing in. Every
    non-archived session of the account whose tag is in the calendar and whose focus time meets
    the minimum length, newest first. An unknown, malformed, reset or turned-off secret is the
    same plain 404. A weak `ETag` lets a refresh with `If-None-Match` get a 304."""
    client = client_key(request.client.host if request.client else None)
    state = request.app.state
    wait = state.calendar_limiter.try_acquire(client, "")
    if wait is not None:
        raise _limited(wait)
    user_id = (
        await db.scalar(
            select(CalendarFeed.user_id).where(CalendarFeed.token_hash == token_hash(secret))
        )
        if _SECRET.fullmatch(secret)
        else None
    )
    if user_id is None:
        # Only a failed lookup spends the unknown-secret budget; a valid secret never does.
        wait = state.calendar_bad_limiter.try_acquire(client, "")
        if wait is not None:
            raise _limited(wait)
        raise _not_found()
    tag_user(str(user_id))

    settings = await _settings(db, user_id)
    names = await _tag_names(db, user_id)
    rows = await db.execute(
        select(
            FocusSession.id,
            FocusSession.mode,
            FocusSession.tag,
            FocusSession.custom_tag_id,
            FocusSession.goal,
            FocusSession.started_at,
            FocusSession.ended_at,
            FocusSession.focus_seconds,
            FocusSession.paused_seconds,
            FocusSession.status,
            FocusSession.mode_config,
            FocusSession.blocks_completed,
        )
        .where(
            FocusSession.user_id == user_id,
            FocusSession.archived_at.is_(None),
            FocusSession.focus_seconds >= settings.min_minutes * 60,
        )
        .order_by(FocusSession.started_at.desc(), FocusSession.id.desc())
    )
    rendered = await asyncio.to_thread(
        render_calendar,
        _events(rows, names, settings.excluded),
        settings.calendar,
        name=settings.name,
        origin=_origin(request),
        feed=True,
        now=dt.datetime.now(dt.UTC),
    )
    head = request.method == "HEAD"
    if not head:  # a HEAD is not a fetch of the calendar
        # At most once a minute per feed, so a polling calendar app doesn't write on every fetch.
        await db.execute(
            update(CalendarFeed)
            .where(
                CalendarFeed.user_id == user_id,
                (CalendarFeed.last_fetched_at.is_(None))
                | (CalendarFeed.last_fetched_at < func.now() - FETCHED_AT_RESOLUTION),
            )
            .values(last_fetched_at=func.now())
        )
        await db.commit()
    headers = {"ETag": rendered.etag, "Cache-Control": "private, no-cache"}
    if matches_etag(request.headers.get("if-none-match"), rendered.etag):
        return Response(status_code=304, headers=headers)
    return _ics(request, rendered.body, **headers)


@router.get("/feed", responses=_UNAUTHORIZED)
async def feed_status(user: CurrentUser, db: DbSession) -> FeedStatus:
    """Whether the account has a subscription link, and when it was made and last fetched.
    Never the link itself: it is shown once, when made (AC14.4)."""
    row = (
        await db.execute(
            select(CalendarFeed.created_at, CalendarFeed.last_fetched_at).where(
                CalendarFeed.user_id == user.id
            )
        )
    ).first()
    if row is None:
        return FeedStatus(enabled=False, created_at=None, last_fetched_at=None)
    return FeedStatus(enabled=True, created_at=row.created_at, last_fetched_at=row.last_fetched_at)


@router.post("/feed", status_code=201, responses={**_UNAUTHORIZED, 200: {"model": FeedCreated}})
async def create_feed(user: CurrentUser, db: DbSession, response: Response) -> FeedCreated:
    """Make the link (201), or replace it (200, Reset): the old secret stops working at once.
    The path with the new secret is returned only here, once."""
    secret = new_token()
    base = insert(CalendarFeed).values(
        user_id=user.id, token_hash=token_hash(secret), created_at=func.clock_timestamp()
    )
    stmt: Any = base.on_conflict_do_update(
        index_elements=["user_id"],
        set_={
            "token_hash": base.excluded.token_hash,
            "created_at": base.excluded.created_at,
            "last_fetched_at": None,
        },
    ).returning(CalendarFeed.created_at, literal_column("(xmax = 0)").label("inserted"))
    created_at, inserted = (await db.execute(stmt)).one()
    await db.commit()
    response.status_code = 201 if inserted else 200
    response.headers["Cache-Control"] = "no-store"
    logger.info("calendar feed created" if inserted else "calendar feed reset")
    return FeedCreated(path=f"/api/calendar/{secret}.ics", created_at=created_at)


@router.delete("/feed", status_code=204, responses=_UNAUTHORIZED)
async def delete_feed(user: CurrentUser, db: DbSession) -> Response:
    """Turn the link off (AC14.4). Idempotent: 204 whether or not there was one."""
    result = await db.execute(delete(CalendarFeed).where(CalendarFeed.user_id == user.id))
    await db.commit()
    if result.rowcount:  # type: ignore[attr-defined]
        logger.info("calendar feed deleted")
    return Response(status_code=204)
