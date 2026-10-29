"""Per-user settings and recent YouTube links (F12, AC8.6, #12).

Privacy: YouTube links are user content. They are never logged, put in span attributes
or used as metric labels, and validation errors never echo them (see errors.py).
"""

import re
import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Annotated, Any, Literal
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
)
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from app.deps import CurrentUser, DbSession
from app.errors import ErrorResponse
from app.models import UserSettings, YoutubeRecentLink
from app.models.enums import Tag, Theme

router = APIRouter(prefix="/api", tags=["settings"])

RECENT_LINKS_LIMIT = 5  # AC8.6
ReminderMinutes = Literal[15, 30, 45, 60, 90, 120]  # AC4.2; null = Off (AC12.4)
_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "Not signed in"}
}


class PomodoroConfig(BaseModel):
    """Last-used Pomodoro configuration; ranges are AC3.2.

    Maps to the frontend `PomodoroConfig` (timer/config.ts) in snake_case, without `mode`:
    focusMinutes -> focus_minutes, breakMinutes -> break_minutes, blocks -> blocks,
    longBreakEnabled -> long_break_enabled, longBreakMinutes -> long_break_minutes.
    """

    model_config = ConfigDict(extra="forbid")

    focus_minutes: Annotated[StrictInt, Field(ge=5, le=90)]
    break_minutes: Annotated[StrictInt, Field(ge=1, le=30)]
    blocks: Annotated[StrictInt, Field(ge=1, le=8)]
    long_break_enabled: StrictBool
    # Validated even when the long break is off: it is remembered for next time.
    long_break_minutes: Annotated[StrictInt, Field(ge=5, le=60)]


class SettingsOut(BaseModel):
    week_start_day: int = Field(description="0 = Sunday ... 6 = Saturday")
    alert_volume: int = Field(description="0-100")
    background_volume: int = Field(description="0-100")
    keep_screen_awake: bool
    default_reminder_minutes: ReminderMinutes | None = Field(description="null = Off")
    pomodoro_config: PomodoroConfig | None = Field(description="null until first use")
    last_tag: Tag | None = Field(description="null means Work (AC7.2)")
    theme: Theme = Field(description="system follows the device's light/dark setting (#214)")
    updated_at: datetime


def _drop_defaults(schema: dict[str, Any]) -> None:
    """An omitted field means "unchanged", so the schema must not advertise a default."""
    for prop in schema.get("properties", {}).values():
        prop.pop("default", None)


class SettingsPatch(BaseModel):
    """Partial update: send only the fields to change. An omitted field means unchanged; no
    field has a default. `null` is a value for `default_reminder_minutes` (Off),
    `pomodoro_config` and `last_tag` (back to none)."""

    model_config = ConfigDict(extra="forbid", json_schema_extra=_drop_defaults)

    week_start_day: Annotated[StrictInt, Field(ge=0, le=6)] = 0
    alert_volume: Annotated[StrictInt, Field(ge=0, le=100)] = 80
    background_volume: Annotated[StrictInt, Field(ge=0, le=100)] = 50
    keep_screen_awake: StrictBool = False
    default_reminder_minutes: ReminderMinutes | None = None
    pomodoro_config: PomodoroConfig | None = None
    last_tag: Tag | None = None
    theme: Theme = Theme.SYSTEM


def _to_out(row: UserSettings) -> SettingsOut:
    return SettingsOut(
        week_start_day=row.week_start_day,
        alert_volume=row.alert_volume,
        background_volume=row.background_volume,
        keep_screen_awake=row.keep_screen_awake,
        default_reminder_minutes=row.default_reminder_minutes,  # type: ignore[arg-type]
        pomodoro_config=(
            PomodoroConfig.model_validate(row.pomodoro_config) if row.pomodoro_config else None
        ),
        last_tag=Tag(row.last_tag) if row.last_tag else None,
        theme=Theme(row.theme),
        updated_at=row.updated_at,
    )


async def _get_or_create(db: DbSession, user: CurrentUser) -> UserSettings:
    """The user's settings row; created with the defaults if somehow missing (sign-up
    normally creates it)."""
    await db.execute(
        insert(UserSettings)
        .values(user_id=user.id)
        .on_conflict_do_nothing(index_elements=["user_id"])
    )
    row = await db.scalar(
        select(UserSettings)
        .where(UserSettings.user_id == user.id)
        .execution_options(populate_existing=True)
    )
    if row is None:  # pragma: no cover - the insert above guarantees it
        raise RuntimeError("settings row missing after insert")
    return row


@router.get("/settings", responses=_ERRORS)
async def get_settings(user: CurrentUser, db: DbSession) -> SettingsOut:
    """The signed-in user's settings (AC12.1-12.5); defaults for a new user."""
    row = await _get_or_create(db, user)
    await db.commit()
    return _to_out(row)


@router.patch("/settings", responses=_ERRORS)
async def update_settings(body: SettingsPatch, user: CurrentUser, db: DbSession) -> SettingsOut:
    """Change the fields sent; the rest stay as they are. Out-of-range values are 422."""
    row = await _get_or_create(db, user)
    for name in body.model_fields_set:
        value = getattr(body, name)
        if name == "pomodoro_config":
            value = body.pomodoro_config.model_dump() if body.pomodoro_config else None
        elif name == "last_tag":
            value = body.last_tag.value if body.last_tag else None
        elif name == "theme":
            value = body.theme.value
        setattr(row, name, value)
    row.updated_at = func.now()
    await db.commit()
    await db.refresh(row)
    return _to_out(row)


_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}


def _check_youtube_url(value: str) -> str:
    """Accept only plain web links to the YouTube hosts. Anything a browser and `urlsplit`
    could read differently (a backslash, userinfo, a port) or that holds whitespace or
    control characters is refused."""
    value = value.strip()
    if "\\" in value or any(c.isspace() or not c.isprintable() for c in value):
        raise ValueError("Enter a valid YouTube link")
    try:
        parts = urlsplit(value)
        # urlsplit lowercases the host (U+212A Kelvin becomes "k"), so check the raw text.
        if not parts.netloc.isascii():
            raise ValueError
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        raise ValueError("Enter a valid YouTube link") from None
    default_port = {"http": 80, "https": 443}.get(parts.scheme)
    if (
        default_port is None
        or host not in _YOUTUBE_HOSTS
        or "@" in parts.netloc
        or port not in (None, default_port)
    ):
        raise ValueError("Enter a valid YouTube link")
    return value


YoutubeUrl = Annotated[str, Field(max_length=2048), AfterValidator(_check_youtube_url)]


YOUTUBE_TITLE_MAX_LENGTH = 200


def _clean_title(value: str | None) -> str | None:
    """Trim the title; a blank one counts as none. Length is checked before this (so an error
    never needs to repeat the value)."""
    if value is None:
        return None
    # Postgres text cannot hold NUL, and a lone surrogate (valid in JSON) cannot be UTF-8.
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("Title contains invalid characters") from None
    if "\x00" in value:
        raise ValueError("Title contains invalid characters")
    return value.strip() or None


YoutubeTitle = Annotated[
    str | None, Field(max_length=YOUTUBE_TITLE_MAX_LENGTH), AfterValidator(_clean_title)
]


class YoutubeLinkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: YoutubeUrl
    title: YoutubeTitle = Field(
        default=None,
        description=(
            "The video or playlist title the player reported, at most 200 characters. Optional: "
            "when it is missing or blank, a title already saved for this video or playlist is "
            "kept; when present it replaces the saved one."
        ),
    )


class YoutubeLinkOut(BaseModel):
    url: str
    title: str | None = Field(description="Null until the player has reported one")
    last_used_at: datetime


class YoutubeLinksOut(BaseModel):
    links: list[YoutubeLinkOut] = Field(description="Newest first, at most 5")


_VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
_PLAYLIST_ID = re.compile(r"[A-Za-z0-9_-]{12,64}")
_PATH_VIDEO = re.compile(r"/(?:embed|shorts|live|v)/([^/]+)")


_SINGLE_DOT = {".", "%2e"}
_DOUBLE_DOT = {"..", ".%2e", "%2e.", "%2e%2e"}


def _resolve_dot_segments(path: str) -> str:
    """The path as the browser's URL parser reports it: `.` and `..` segments (also written
    `%2e`, any case) resolved, never popping above the root (WHATWG URL, path state)."""
    out: list[str] = []
    segments = path.split("/")[1:] if path.startswith("/") else path.split("/")
    for i, segment in enumerate(segments):
        lowered = segment.lower()
        last = i == len(segments) - 1
        if lowered in _DOUBLE_DOT:
            if out:
                out.pop()
            if last:
                out.append("")
        elif lowered in _SINGLE_DOT:
            if last:
                out.append("")
        else:
            out.append(segment)
    return "/" + "/".join(out)


def youtube_key(url: str) -> str:
    """The identity of a link in the recent list: the id the player plays (#249).

    Mirrors `findTarget` in frontend/src/sounds/youtubeLink.ts: a video id (youtu.be/<id>,
    `v=`, or /embed|shorts|live|v/<id>) wins over a playlist id, so a video inside a playlist is
    keyed as the video, as the player plays it; otherwise the `list=` playlist id. Host, scheme,
    other parameters (t, si, feature) and parameter order don't matter, and dot segments in the
    path are resolved first, as the client's `new URL()` does (`/foo/../embed/<id>`). A link with
    no id (the server doesn't check the path) is keyed by its own text. Never logged or returned.
    """
    parts = urlsplit(url.strip())
    path = _resolve_dot_segments(parts.path)
    host = (parts.hostname or "").lower()
    query = parse_qs(parts.query, keep_blank_values=True)
    if host == "youtu.be":
        segments = path.split("/")
        video = segments[1] if len(segments) > 1 else None
    else:
        path_match = _PATH_VIDEO.match(path)
        video = query["v"][0] if "v" in query else (path_match.group(1) if path_match else None)
    if video is not None and video != "videoseries" and _VIDEO_ID.fullmatch(video):
        return f"video:{video}"
    playlist = query["list"][0] if "list" in query else None
    if playlist is not None and _PLAYLIST_ID.fullmatch(playlist):
        return f"playlist:{playlist}"
    return f"url:{url.strip()}"


_LinkRow = tuple[uuid.UUID, str, str | None, datetime]  # id, url, title, last_used_at


def _newest_per_key(rows: Sequence[_LinkRow]) -> list[_LinkRow]:
    """Rows (newest first) with one per key, the newest, at most RECENT_LINKS_LIMIT."""
    seen: set[str] = set()
    kept: list[_LinkRow] = []
    for row in rows:
        key = youtube_key(row[1])
        if key not in seen:
            seen.add(key)
            kept.append(row)
    return kept[:RECENT_LINKS_LIMIT]


async def _user_rows(db: DbSession, user: CurrentUser) -> list[_LinkRow]:
    result = await db.execute(
        select(
            YoutubeRecentLink.id,
            YoutubeRecentLink.url,
            YoutubeRecentLink.title,
            YoutubeRecentLink.last_used_at,
        )
        .where(YoutubeRecentLink.user_id == user.id)
        .order_by(YoutubeRecentLink.last_used_at.desc(), YoutubeRecentLink.id)
    )
    return [(i, u, title, t) for i, u, title, t in result.all()]


async def _recent(db: DbSession, user: CurrentUser) -> YoutubeLinksOut:
    # Rows written before #249 can hold one id under several URLs: collapse them on read.
    rows = _newest_per_key(await _user_rows(db, user))
    return YoutubeLinksOut(
        links=[YoutubeLinkOut(url=r[1], title=r[2], last_used_at=r[3]) for r in rows]
    )


@router.get("/youtube-links", responses=_ERRORS)
async def list_youtube_links(user: CurrentUser, db: DbSession) -> YoutubeLinksOut:
    """The user's 5 most recently used YouTube links, newest first, one per video or
    playlist id (AC8.6)."""
    return await _recent(db, user)


@router.post("/youtube-links", responses=_ERRORS)
async def use_youtube_link(
    body: YoutubeLinkIn, user: CurrentUser, db: DbSession
) -> YoutubeLinksOut:
    """Record a link as just used and drop all but the 5 newest ids. A link whose video or
    playlist id is already listed replaces that entry and moves to the top, with the URL just
    used. Returns the updated list."""
    # One writer per user at a time, so two pastes of the same id can't both insert (the lock
    # is what makes the delete-then-insert below safe). The ON CONFLICT on the insert is the
    # fallback if the lock is ever removed or moved: a duplicate (user, url) then updates the
    # row instead of failing with a 500.
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(str(user.id), 0))))
    key = youtube_key(body.url)
    same = [row for row in await _user_rows(db, user) if youtube_key(row[1]) == key]
    stale = [row[0] for row in same]
    # A new title wins; without one, keep the newest title already known for this id (#326).
    title = body.title or next((row[2] for row in same if row[2]), None)
    if stale:
        await db.execute(delete(YoutubeRecentLink).where(YoutubeRecentLink.id.in_(stale)))
    await db.execute(
        insert(YoutubeRecentLink)
        .values(user_id=user.id, url=body.url, title=title, last_used_at=func.clock_timestamp())
        .on_conflict_do_update(
            constraint="uq_youtube_recent_links_user_url",
            set_={"title": title, "last_used_at": func.clock_timestamp()},
        )
    )
    keep = [row[0] for row in _newest_per_key(await _user_rows(db, user))]
    await db.execute(
        delete(YoutubeRecentLink).where(
            YoutubeRecentLink.user_id == user.id, YoutubeRecentLink.id.not_in(keep)
        )
    )
    await db.commit()
    return await _recent(db, user)
