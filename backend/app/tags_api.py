"""Custom tags (F7, AC7.4-AC7.9, #400): list, create or bring back, rename and recolour, remove.

Every query is scoped to the signed-in user (AC1.3). A tag name is user content, like a goal:
it is never logged, put in a span attribute or a metric label, and no error response repeats
it (AC7.9). Built-in tags are client constants and aren't served here.
"""

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.exceptions import RequestValidationError
from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.deps import CurrentUser, DbSession
from app.errors import ApiError, ErrorDetail, ErrorResponse
from app.models import CustomTag
from app.models.enums import (
    MAX_CUSTOM_TAGS_IN_USE,
    MAX_CUSTOM_TAGS_TOTAL,
    TAG_DISPLAY_NAMES,
    TAG_NAME_MAX_LENGTH,
    TAGS,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tags", tags=["tags"])

Color = Literal["indigo", "blue", "teal", "green", "yellow", "orange", "red", "pink"]  # AC7.5

UNKNOWN_TAG = "Unknown tag"
_BUILTIN_NAMES = frozenset(n.lower() for n in TAG_DISPLAY_NAMES)

# Every boundary str.splitlines() recognises, as for goals (sessions.one_line_goal).
_LINE_BREAKS = re.compile(r"[\r\n\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]+")


def _one_line(value: object) -> object:
    """AC7.4: trim, and replace each run of line breaks with one space."""
    if not isinstance(value, str):
        return value
    return _LINE_BREAKS.sub(" ", value).strip()


def _storable(value: str) -> str:
    """Postgres text cannot hold NUL, and a lone surrogate (valid in JSON) cannot be UTF-8."""
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("Name contains invalid characters") from None
    if "\x00" in value:
        raise ValueError("Name contains invalid characters")
    return value


TagName = Annotated[
    str,
    Field(min_length=1, max_length=TAG_NAME_MAX_LENGTH),
    BeforeValidator(_one_line),
    AfterValidator(_storable),
]


class TagCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: TagName
    color: Color


class TagPatch(BaseModel):
    """Rename and/or recolour. An omitted field is unchanged; neither may be null."""

    model_config = ConfigDict(extra="forbid")

    name: TagName | None = None
    color: Color | None = None

    @model_validator(mode="after")
    def _valid(self) -> "TagPatch":
        if not self.model_fields_set:
            raise ValueError("Provide name, color or both")
        if self.name is None and "name" in self.model_fields_set:
            raise ValueError("name cannot be null")
        if self.color is None and "color" in self.model_fields_set:
            raise ValueError("color cannot be null")
        return self


class TagOut(BaseModel):
    id: uuid.UUID
    name: str
    color: Color
    created_at: datetime
    removed_at: datetime | None = Field(description="null while the tag is in use (AC7.7)")


class TagList(BaseModel):
    tags: list[TagOut] = Field(description="Every custom tag, removed ones included, oldest first")


_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "Not signed in"},
    404: {"model": ErrorResponse, "description": "No such tag"},
    409: {
        "model": ErrorResponse,
        "description": (
            "Conflict: one `details` item whose `type` is name_taken, removed_name_taken, "
            "limit_in_use, limit_total or removed"
        ),
    },
}

_CONFLICTS: dict[str, tuple[str, str]] = {
    "name_taken": ("name", "A tag with this name already exists."),
    "removed_name_taken": (
        "name",
        "A removed tag has this name. Add a tag with this name to bring it back.",
    ),
    "limit_in_use": (
        "body",
        "You can have up to 20 tags of your own. Remove one to add another.",
    ),
    "limit_total": ("body", "You've reached the limit of 100 tags, including removed ones."),
    "removed": ("body", "This tag was removed on another device."),
}


def tag_conflict(kind: str) -> ApiError:
    """A 409 `conflict` whose single `details` item tells the cases apart by `type`."""
    field, message = _CONFLICTS[kind]
    return ApiError(409, message, [ErrorDetail(field=field, message=message, type=kind)])


def unknown_tag_detail(field: str = "tag") -> ErrorDetail:
    """The one error for any tag value that isn't a built-in or the user's own tag, so it never
    reveals whether the id exists for someone else."""
    return ErrorDetail(field=field, message=f"Value error, {UNKNOWN_TAG}", type="value_error")


def unknown_tag_error(*loc: str | int) -> RequestValidationError:
    return RequestValidationError(
        [{"loc": loc, "msg": f"Value error, {UNKNOWN_TAG}", "type": "value_error"}]
    )


def check_tag_shape(value: str) -> str:
    """Pydantic-level check: a built-in identifier or a canonical lower-case UUID. Whether the
    UUID is the user's own tag is checked against the database by `owned_tag_ids`."""
    if value in TAGS:
        return value
    try:
        if str(uuid.UUID(value)) == value:
            return value
    except ValueError:
        pass
    raise ValueError(UNKNOWN_TAG)


TagValue = Annotated[
    str,
    AfterValidator(check_tag_shape),
    Field(
        description=(
            "A built-in tag identifier (work, study, nap, read, meditation, exercise) or the "
            "id of one of the user's own custom tags, removed ones included"
        )
    ),
]


async def owned_tag_ids(db: DbSession, user_id: uuid.UUID) -> set[str]:
    """The ids (as text) of the user's custom tags, removed ones included."""
    rows = await db.scalars(select(CustomTag.id).where(CustomTag.user_id == user_id))
    return {str(i) for i in rows}


def is_known(value: str, owned: set[str]) -> bool:
    return value in TAGS or value in owned


def _out(row: CustomTag) -> TagOut:
    return TagOut.model_validate(row, from_attributes=True)


async def _lock_user_tags(db: DbSession, user_id: uuid.UUID) -> None:
    """One tag writer per user at a time, so the limits and the unique names hold when two
    devices write at once. The unique index on (user, lower(name)) is the backstop."""
    await db.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended(f"tags:{user_id}", 0)))
    )


async def _named(db: DbSession, user_id: uuid.UUID, name: str) -> CustomTag | None:
    """The user's tag with this name, ignoring case; the index makes it at most one."""
    return await db.scalar(
        select(CustomTag).where(
            CustomTag.user_id == user_id, func.lower(CustomTag.name) == func.lower(name)
        )
    )


async def _counts(db: DbSession, user_id: uuid.UUID) -> tuple[int, int]:
    """(tags in use, tags in all)."""
    in_use, total = (
        await db.execute(
            select(func.count().filter(CustomTag.removed_at.is_(None)), func.count()).where(
                CustomTag.user_id == user_id
            )
        )
    ).one()
    return in_use, total


@router.get("", responses=_ERRORS)
async def list_tags(user: CurrentUser, db: DbSession) -> TagList:
    """Every custom tag of the user, removed ones included, oldest first (AC7.8 order)."""
    rows = await db.scalars(
        select(CustomTag)
        .where(CustomTag.user_id == user.id)
        .order_by(CustomTag.created_at, CustomTag.id)
    )
    return TagList(tags=[_out(r) for r in rows])


@router.post("", status_code=201, responses={**_ERRORS, 200: {"model": TagOut}})
async def create_tag(
    body: TagCreate, user: CurrentUser, db: DbSession, response: Response
) -> TagOut:
    """Create a tag (201), or bring back the removed tag of the same name (200), keeping its
    stored name and taking the colour given (AC7.4, AC7.7). Checks run in this order:
    validation (422), `name_taken`, bring back (or `limit_in_use`), then for a new tag
    `limit_in_use` and `limit_total`."""
    await _lock_user_tags(db, user.id)
    if body.name.lower() in _BUILTIN_NAMES:
        raise tag_conflict("name_taken")
    existing = await _named(db, user.id, body.name)
    if existing is not None and existing.removed_at is None:
        raise tag_conflict("name_taken")
    in_use, total = await _counts(db, user.id)
    if in_use >= MAX_CUSTOM_TAGS_IN_USE:
        raise tag_conflict("limit_in_use")
    if existing is not None:
        existing.removed_at = None
        existing.color = body.color
        await db.commit()
        response.status_code = 200
        logger.info("tag brought back")
        return _out(existing)
    if total >= MAX_CUSTOM_TAGS_TOTAL:
        raise tag_conflict("limit_total")
    tag = CustomTag(user_id=user.id, name=body.name, color=body.color)
    db.add(tag)
    try:
        await db.commit()
    except IntegrityError:
        # Only the unique name can fail here; the lock above makes it a "can't happen" path.
        await db.rollback()
        raise tag_conflict("name_taken") from None
    await db.refresh(tag)
    logger.info("tag created")
    return _out(tag)


async def _owned(tag_id: uuid.UUID, user: CurrentUser, db: DbSession) -> CustomTag:
    """The user's tag or 404. A dependency, so an unknown id is 404 before the body is
    validated (422), as the contract orders the checks."""
    row = await db.scalar(
        select(CustomTag).where(CustomTag.id == tag_id, CustomTag.user_id == user.id)
    )
    if row is None:
        raise HTTPException(404, "Tag not found")
    return row


OwnedTag = Annotated[CustomTag, Depends(_owned)]


@router.patch("/{tag_id}", responses=_ERRORS)
async def update_tag(tag: OwnedTag, body: TagPatch, user: CurrentUser, db: DbSession) -> TagOut:
    """Rename and/or recolour (AC7.6). Checks run in this order: 404, 422 validation,
    `removed`, `name_taken`, `removed_name_taken`. Renaming a tag to its own name in another
    case is allowed."""
    await _lock_user_tags(db, user.id)
    await db.refresh(tag)  # the state after any writer that held the lock before us
    if tag.removed_at is not None:
        raise tag_conflict("removed")
    if body.name is not None:
        if body.name.lower() in _BUILTIN_NAMES:
            raise tag_conflict("name_taken")
        other = await _named(db, user.id, body.name)
        if other is not None and other.id != tag.id:
            raise tag_conflict("name_taken" if other.removed_at is None else "removed_name_taken")
        tag.name = body.name
    if body.color is not None:
        tag.color = body.color
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise tag_conflict("name_taken") from None
    await db.refresh(tag)
    logger.info("tag updated")
    return _out(tag)


@router.post("/{tag_id}/remove", responses=_ERRORS)
async def remove_tag(tag: OwnedTag, user: CurrentUser, db: DbSession) -> TagOut:
    """Remove a tag (AC7.7): it leaves the pickers, nothing else changes. Idempotent."""
    await _lock_user_tags(db, user.id)
    await db.refresh(tag)
    if tag.removed_at is None:
        tag.removed_at = datetime.now(UTC)
        await db.commit()
        await db.refresh(tag)
        logger.info("tag removed")
    return _out(tag)
