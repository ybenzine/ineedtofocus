"""Focus sessions: save, sync, edit, archive, restore, delete archived (F6, F7, F11, F13, #10).

Every query is scoped to the signed-in user (AC1.3). Times are stored and returned in UTC.
Field names are snake_case; the frontend's `SessionRecord` maps one to one (see
`_docs/architecture.md`).
"""

import re
import uuid
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import (
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from app.deps import CurrentUser, DbSession
from app.errors import ErrorDetail, ErrorInfo, ErrorResponse, error_field
from app.models import FocusSession, Mode, Status, Tag
from app.models.enums import GOAL_MAX_LENGTH

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

MIN_FOCUS_SECONDS = 60  # AC6.2
MAX_FOCUS_SECONDS = 12 * 60 * 60  # AC4.5: no session can hold more than 12 h of focus time
MAX_BATCH = 100
# The client rounds to whole seconds from millisecond timestamps.
CLOCK_TOLERANCE = timedelta(seconds=2)

# Every boundary str.splitlines() recognises: CR, LF, VT, FF, FS/GS/RS, NEL, LS, PS (tabs are
# not line breaks). CRLF is a run of two.
_LINE_BREAKS = re.compile(r"[\r\n\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]+")


def one_line_goal(value: object) -> object:
    """AC7.3/AC13.5: collapse each run of line breaks into one space and trim; blank is none."""
    if not isinstance(value, str):
        return value
    cleaned = _LINE_BREAKS.sub(" ", value).strip()
    return cleaned or None


Goal = Annotated[
    Annotated[str, Field(max_length=GOAL_MAX_LENGTH)] | None, BeforeValidator(one_line_goal)
]


class CountdownConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["countdown"]
    minutes: int = Field(ge=1, le=240)  # AC2.1


class PomodoroConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["pomodoro"]
    focus_minutes: int = Field(ge=5, le=90)
    break_minutes: int = Field(ge=1, le=30)
    blocks: int = Field(ge=1, le=8)
    long_break_enabled: bool
    long_break_minutes: int = Field(ge=5, le=60)


class UnlimitedConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["unlimited"]
    reminder_minutes: Literal[15, 30, 45, 60, 90, 120] | None  # AC4.2; null is Off


ModeConfig = Annotated[
    CountdownConfig | PomodoroConfig | UnlimitedConfig, Field(discriminator="mode")
]


class SessionIn(BaseModel):
    """A finished session as the client saved it on the device (AC6.3, AC13.2)."""

    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID  # client-generated; the idempotency key (AC13.4)
    mode: Mode
    tag: Tag
    goal: Goal = None
    started_at: AwareDatetime
    ended_at: AwareDatetime
    focus_seconds: int = Field(le=MAX_FOCUS_SECONDS)
    paused_seconds: int = Field(ge=0)
    status: Status
    mode_config: ModeConfig
    blocks_completed: int = Field(default=0, ge=0, le=8)

    @field_validator("focus_seconds")
    @classmethod
    def _long_enough(cls, value: int) -> int:
        if value < MIN_FOCUS_SECONDS:
            raise ValueError("Sessions under 1 minute of focus time aren't saved")
        return value

    @model_validator(mode="after")
    def _consistent(self) -> "SessionIn":
        if self.mode_config.mode != self.mode:
            raise ValueError("mode_config does not match mode")
        if self.ended_at < self.started_at:
            raise ValueError("ended_at is before started_at")
        elapsed = self.ended_at - self.started_at
        if timedelta(seconds=self.focus_seconds + self.paused_seconds) > elapsed + CLOCK_TOLERANCE:
            raise ValueError("focus and paused time exceed the time between start and end")
        if self.mode != Mode.POMODORO and self.blocks_completed != 0:
            raise ValueError("blocks_completed applies to Pomodoro only")
        if (
            isinstance(self.mode_config, PomodoroConfig)
            and self.blocks_completed > self.mode_config.blocks
        ):
            raise ValueError("blocks_completed exceeds the configured blocks")
        return self


class SyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Items are validated one by one in the handler, so one bad item doesn't fail the batch.
    # `SessionIn | Any` documents the item shape; an invalid item falls through as raw JSON.
    sessions: list[SessionIn | Any] = Field(min_length=1, max_length=MAX_BATCH)


class SessionEdit(BaseModel):
    """Change the tag and/or goal (AC11.1). `goal: null` (or blank) clears the goal."""

    model_config = ConfigDict(extra="forbid")

    tag: Tag | None = None
    goal: Goal = None

    @model_validator(mode="after")
    def _valid(self) -> "SessionEdit":
        if not self.model_fields_set:
            raise ValueError("Provide tag, goal or both")
        if "tag" in self.model_fields_set and self.tag is None:
            raise ValueError("tag cannot be null")
        return self


class SessionOut(BaseModel):
    id: uuid.UUID
    mode: Mode
    tag: Tag
    goal: str | None
    started_at: datetime
    ended_at: datetime
    focus_seconds: int
    paused_seconds: int
    status: Status
    mode_config: ModeConfig
    blocks_completed: int
    archived_at: datetime | None
    created_at: datetime


class SyncItemResult(BaseModel):
    """The outcome for one item of a sync request. `session` is set unless rejected, `error`
    only when rejected. `id` is null when the item had no usable id."""

    index: int
    id: uuid.UUID | None
    status: Literal["created", "existing", "rejected"]
    session: SessionOut | None = None
    error: ErrorInfo | None = None


class SyncResult(BaseModel):
    """Counts by status, and one result per request item in request order."""

    created: int
    existing: int
    rejected: int
    results: list[SyncItemResult]


class SessionList(BaseModel):
    sessions: list[SessionOut]


class DeletedCount(BaseModel):
    deleted: int


def _out(row: FocusSession) -> SessionOut:
    return SessionOut.model_validate(row, from_attributes=True)


_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "Not signed in"},
    404: {"model": ErrorResponse, "description": "No such session"},
    409: {"model": ErrorResponse, "description": "Conflict (see message)"},
}


async def _save(
    db: DbSession, user_id: uuid.UUID, items: list[SessionIn]
) -> tuple[set[uuid.UUID], dict[uuid.UUID, FocusSession]]:
    """Insert the sessions that are new; return (ids created, this user's stored rows by id).

    `ON CONFLICT DO NOTHING` on the primary key makes retries and concurrent duplicates safe.
    An id that belongs to another user is simply absent from the returned rows; the caller
    reports it. Everything else is saved.
    """
    if not items:
        return set(), {}
    unique = list({i.id: i for i in items}.values())
    values = [
        {
            "id": i.id,
            "user_id": user_id,
            "mode": i.mode.value,
            "tag": i.tag.value,
            "goal": i.goal,
            "started_at": i.started_at.astimezone(UTC),
            "ended_at": i.ended_at.astimezone(UTC),
            "focus_seconds": i.focus_seconds,
            "paused_seconds": i.paused_seconds,
            "status": i.status.value,
            "mode_config": i.mode_config.model_dump(mode="json"),
            "blocks_completed": i.blocks_completed,
        }
        for i in unique
    ]
    inserted = await db.execute(
        insert(FocusSession)
        .values(values)
        .on_conflict_do_nothing(index_elements=[FocusSession.id])
        .returning(FocusSession.id)
    )
    created = {r[0] for r in inserted.all()}
    rows = {
        r.id: r
        for r in await db.scalars(
            select(FocusSession).where(
                FocusSession.id.in_([i.id for i in unique]), FocusSession.user_id == user_id
            )
        )
    }
    await db.commit()
    return created, rows


@router.post("", status_code=201, responses={**_ERRORS, 200: {"model": SessionOut}})
async def save_session(
    body: SessionIn, user: CurrentUser, db: DbSession, response: Response
) -> SessionOut:
    """Save one finished session (AC6.3). Idempotent on `id` (AC13.4): a repeat returns 200 with
    the stored session and changes nothing."""
    created, rows = await _save(db, user.id, [body])
    if body.id not in rows:
        raise HTTPException(409, "A session id is already in use")
    if not created:
        response.status_code = 200
    return _out(rows[body.id])


def _item_error(code: str, message: str, details: list[ErrorDetail] | None = None) -> ErrorInfo:
    return ErrorInfo(code=code, message=message, details=details)


def _raw_id(raw: object) -> uuid.UUID | None:
    if isinstance(raw, dict):
        try:
            return uuid.UUID(str(raw.get("id")))
        except ValueError:
            return None
    return None


@router.post("/sync", responses=_ERRORS)
async def sync_sessions(body: SyncRequest, user: CurrentUser, db: DbSession) -> SyncResult:
    """Save a batch of 1 to 100 sessions (AC13.3), idempotent per `id` (AC13.4).

    Returns 200 with one result per item, in request order: `created`, `existing` (already
    saved; the stored copy is returned) or `rejected` (with an `error`; an id owned by another
    account is `conflict`). Valid items are saved even when others are rejected, so one bad
    session never blocks the queue (AC13.5). Only 401 and a malformed envelope (not a
    `sessions` list, or 0 or more than 100 items: 422) fail the whole request.
    """
    results: list[SyncItemResult | None] = [None] * len(body.sessions)
    valid: list[tuple[int, SessionIn]] = []
    for index, raw in enumerate(body.sessions):
        try:
            item = raw if isinstance(raw, SessionIn) else SessionIn.model_validate(raw)
        except ValidationError as exc:
            details = [
                ErrorDetail(
                    field=error_field(tuple(e["loc"]), e["type"]), message=e["msg"], type=e["type"]
                )
                for e in exc.errors()
            ]
            error = _item_error("validation_error", "Session validation failed", details)
            results[index] = SyncItemResult(
                index=index, id=_raw_id(raw), status="rejected", error=error
            )
        else:
            valid.append((index, item))
    created, rows = await _save(db, user.id, [item for _, item in valid])
    seen: set[uuid.UUID] = set()
    for index, item in valid:
        row = rows.get(item.id)
        if row is None:
            error = _item_error("conflict", "This session id is already in use")
            results[index] = SyncItemResult(index=index, id=item.id, status="rejected", error=error)
            continue
        first = item.id not in seen
        seen.add(item.id)
        results[index] = SyncItemResult(
            index=index,
            id=item.id,
            status="created" if first and item.id in created else "existing",
            session=_out(row),
        )
    final = [r for r in results if r is not None]
    count = Counter(r.status for r in final)
    return SyncResult(
        created=count["created"],
        existing=count["existing"],
        rejected=count["rejected"],
        results=final,
    )


@router.get("/archived", responses=_ERRORS)
async def list_archived(user: CurrentUser, db: DbSession) -> SessionList:
    """The Archive view (AC11.3): archived sessions, most recently archived first."""
    rows = await db.scalars(
        select(FocusSession)
        .where(FocusSession.user_id == user.id, FocusSession.archived_at.is_not(None))
        .order_by(FocusSession.archived_at.desc(), FocusSession.id)
    )
    return SessionList(sessions=[_out(r) for r in rows])


@router.delete("/archived", responses=_ERRORS)
async def delete_archived(user: CurrentUser, db: DbSession) -> DeletedCount:
    """Permanently delete every archived session and return how many (AC11.6). Non-archived
    sessions are never touched, and no endpoint deletes one (AC11.7)."""
    result = await db.execute(
        delete(FocusSession)
        .where(FocusSession.user_id == user.id, FocusSession.archived_at.is_not(None))
        .returning(FocusSession.id)
    )
    deleted = len(result.all())
    await db.commit()
    return DeletedCount(deleted=deleted)


async def _owned(db: DbSession, user_id: uuid.UUID, session_id: uuid.UUID) -> FocusSession:
    row = await db.scalar(
        select(FocusSession)
        .where(FocusSession.id == session_id, FocusSession.user_id == user_id)
        .with_for_update()
    )
    if row is None:
        raise HTTPException(404, "Session not found")
    return row


@router.patch("/{session_id}", responses=_ERRORS)
async def edit_session(
    session_id: uuid.UUID, body: SessionEdit, user: CurrentUser, db: DbSession
) -> SessionOut:
    """Change tag and/or goal of a non-archived session (AC11.1). Archived sessions are
    read-only (AC11.4): 409."""
    row = await _owned(db, user.id, session_id)
    if row.archived_at is not None:
        raise HTTPException(409, "Archived sessions can't be edited; restore it first")
    if body.tag is not None:
        row.tag = body.tag.value
    if "goal" in body.model_fields_set:
        row.goal = body.goal
    await db.commit()
    return _out(row)


@router.post("/{session_id}/archive", responses=_ERRORS)
async def archive_session(session_id: uuid.UUID, user: CurrentUser, db: DbSession) -> SessionOut:
    """Archive a session (AC11.2). Already archived: unchanged, still 200."""
    row = await _owned(db, user.id, session_id)
    if row.archived_at is None:
        row.archived_at = datetime.now(UTC)
        await db.commit()
    return _out(row)


@router.post("/{session_id}/restore", responses=_ERRORS)
async def restore_session(session_id: uuid.UUID, user: CurrentUser, db: DbSession) -> SessionOut:
    """Return an archived session to history exactly as it was (AC11.5). Not archived:
    unchanged, still 200."""
    row = await _owned(db, user.id, session_id)
    if row.archived_at is not None:
        row.archived_at = None
        await db.commit()
    return _out(row)
