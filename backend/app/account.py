"""Account export and deletion (F1, AC1.6, AC1.7, #349).

Both are scoped to the signed-in user. Privacy: nothing here logs, traces or labels an
email, password, goal or YouTube link; a deletion logs the opaque user id only.
"""

import logging
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Body, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select

from app.auth import _client, _errors, _settings
from app.deps import CurrentUser, DbSession, session_cookie_name
from app.errors import ErrorResponse
from app.models import FocusSession, User, YoutubeRecentLink
from app.security import verify_password
from app.sessions import SessionOut, _out
from app.settings_api import SettingsOut, YoutubeLinkOut, _get_or_create, _to_out

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/account", tags=["account"])

EXPORT_FORMAT_VERSION = 1
MAX_PASSWORD_LENGTH = 128

_UNAUTHORIZED: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "Not signed in"}
}


class ExportAccount(BaseModel):
    email: str
    created_at: datetime


class ExportOut(BaseModel):
    """Everything stored for the account, except the password hash and sign-in records."""

    format_version: int = Field(description="1; bumped when the shape changes")
    exported_at: datetime
    account: ExportAccount
    settings: SettingsOut
    sessions: list[SessionOut] = Field(
        description="Every session, archived ones included, oldest first"
    )
    youtube_links: list[YoutubeLinkOut]


class DeleteAccountRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # A missing password is a wrong password (403), not a validation error.
    password: str = Field(default="", max_length=MAX_PASSWORD_LENGTH)


@router.get("/export", responses=_UNAUTHORIZED)
async def export_account(user: CurrentUser, db: DbSession, response: Response) -> ExportOut:
    """Download the whole account as JSON (AC1.6)."""
    now = datetime.now(UTC)
    response.headers["Content-Disposition"] = (
        f'attachment; filename="ineedtofocus-export-{now:%Y-%m-%d}.json"'
    )
    response.headers["Cache-Control"] = "no-store"
    settings_row = await _get_or_create(db, user)
    await db.commit()
    rows = await db.scalars(
        select(FocusSession)
        .where(FocusSession.user_id == user.id)
        .order_by(FocusSession.started_at, FocusSession.id)
    )
    links = await db.execute(
        select(YoutubeRecentLink.url, YoutubeRecentLink.title, YoutubeRecentLink.last_used_at)
        .where(YoutubeRecentLink.user_id == user.id)
        .order_by(YoutubeRecentLink.last_used_at.desc(), YoutubeRecentLink.id)
    )
    return ExportOut(
        format_version=EXPORT_FORMAT_VERSION,
        exported_at=now,
        account=ExportAccount(email=user.email, created_at=user.created_at),
        settings=_to_out(settings_row),
        sessions=[_out(r) for r in rows],
        youtube_links=[YoutubeLinkOut(url=u, title=t, last_used_at=at) for u, t, at in links.all()],
    )


_DELETE_ERRORS: dict[int | str, dict[str, Any]] = {
    **_UNAUTHORIZED,
    **_errors(429),
    403: {"model": ErrorResponse, "description": "Incorrect password; nothing was deleted"},
}


@router.post("/delete", status_code=204, responses=_DELETE_ERRORS)
async def delete_account(
    request: Request,
    user: CurrentUser,
    db: DbSession,
    body: Annotated[DeleteAccountRequest, Body(default_factory=DeleteAccountRequest)],
) -> Response:
    """Permanently delete the account after re-entering the password (AC1.7).

    A wrong password is 403, not 401: the frontend treats 401 as an expired sign-in. Failed
    attempts share the sign-in limiter (per client and email, and per client).
    """
    limiter = request.app.state.signin_limiter
    client = _client(request)
    wait = limiter.try_acquire(client, user.email)
    if wait is not None:
        raise HTTPException(
            429, "Too many attempts. Try again later.", headers={"Retry-After": str(wait)}
        )
    if not await verify_password(body.password, user.password_hash):
        raise HTTPException(403, "Incorrect password")
    limiter.succeeded(client, user.email)
    user_id = user.id
    # ON DELETE CASCADE removes settings, sign-ins, sessions and recent links.
    await db.execute(delete(User).where(User.id == user_id))
    await db.commit()
    logger.info("account deleted", extra={"user_id": str(user_id)})
    settings = _settings(request)
    response = Response(status_code=204)
    response.delete_cookie(
        session_cookie_name(settings.cookie_secure),
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return response
