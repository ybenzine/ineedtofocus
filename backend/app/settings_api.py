"""Per-user settings and recent YouTube links (F12, AC8.6, #12).

Privacy: YouTube links are user content. They are never logged, put in span attributes
or used as metric labels, and validation errors never echo them (see errors.py).
"""

from datetime import datetime
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

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
from app.models.enums import Tag

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


class YoutubeLinkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: YoutubeUrl


class YoutubeLinkOut(BaseModel):
    url: str
    last_used_at: datetime


class YoutubeLinksOut(BaseModel):
    links: list[YoutubeLinkOut] = Field(description="Newest first, at most 5")


async def _recent(db: DbSession, user: CurrentUser) -> YoutubeLinksOut:
    rows = await db.execute(
        select(YoutubeRecentLink.url, YoutubeRecentLink.last_used_at)
        .where(YoutubeRecentLink.user_id == user.id)
        .order_by(YoutubeRecentLink.last_used_at.desc(), YoutubeRecentLink.id)
        .limit(RECENT_LINKS_LIMIT)
    )
    return YoutubeLinksOut(links=[YoutubeLinkOut(url=u, last_used_at=t) for u, t in rows.all()])


@router.get("/youtube-links", responses=_ERRORS)
async def list_youtube_links(user: CurrentUser, db: DbSession) -> YoutubeLinksOut:
    """The user's 5 most recently used YouTube links, newest first (AC8.6)."""
    return await _recent(db, user)


@router.post("/youtube-links", responses=_ERRORS)
async def use_youtube_link(
    body: YoutubeLinkIn, user: CurrentUser, db: DbSession
) -> YoutubeLinksOut:
    """Record a link as just used (moves it to the top if known) and drop all but the 5
    newest. Returns the updated list."""
    await db.execute(
        insert(YoutubeRecentLink)
        .values(user_id=user.id, url=body.url, last_used_at=func.clock_timestamp())
        .on_conflict_do_update(
            constraint="uq_youtube_recent_links_user_url",
            set_={"last_used_at": func.clock_timestamp()},
        )
    )
    keep = (
        select(YoutubeRecentLink.id)
        .where(YoutubeRecentLink.user_id == user.id)
        .order_by(YoutubeRecentLink.last_used_at.desc(), YoutubeRecentLink.id)
        .limit(RECENT_LINKS_LIMIT)
    )
    await db.execute(
        delete(YoutubeRecentLink).where(
            YoutubeRecentLink.user_id == user.id, YoutubeRecentLink.id.not_in(keep)
        )
    )
    await db.commit()
    return await _recent(db, user)
