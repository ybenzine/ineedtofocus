"""Password reset by email (F1, AC1.9, #350).

Request: `POST /api/auth/password-reset` always answers 202 with the same body, whether or not
an account exists. Everything after the rate-limit check (looking up the account, writing the
token, sending) runs as a task after the 202 has gone out, so the response time can't reveal an
account either. Confirm: `POST /api/auth/password-reset/confirm` swaps the password, revokes
every sign-in of the account and clears its sign-in lockout.

Privacy: no email address, token, link or password reaches a log, a span or a metric. A failure
is logged as its error type and code only, because the text of an SES or database error can
contain the recipient's address.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    MAX_PASSWORD_LENGTH,
    MIN_PASSWORD_LENGTH,
    Email,
    _client,
    _errors,
)
from app.deps import DbSession
from app.errors import CodedError, ErrorResponse
from app.mailer import SEND_TIMEOUT_SECONDS, EmailConfig, EmailError, reset_message
from app.metrics import PASSWORD_RESET_REQUESTS
from app.models import AuthSession, PasswordResetToken, User
from app.security import hash_password, new_token, token_hash

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

RESET_TTL = timedelta(minutes=60)  # AC1.9
MAX_PER_EMAIL = 3  # requests per email per hour
MAX_PER_CLIENT = 10  # requests per client per hour
WINDOW_SECONDS = 3600.0
# Old rows (expired or used more than a day ago) deleted per request, at most.
CLEANUP_BATCH = 100

INVALID_TOKEN_MESSAGE = "This link has expired or was already used. Ask for a new one."


class AuthOptions(BaseModel):
    password_reset: bool = Field(
        description="True when the server can email a reset link; hide the offer when false"
    )


class ResetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Email


class ResetAccepted(BaseModel):
    """The same for every email, so the response can't reveal who has an account."""

    status: Literal["accepted"] = "accepted"


class ResetConfirm(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=1, max_length=512)
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)


_RESET_ERRORS: dict[int | str, dict[str, Any]] = {
    **_errors(429),
    503: {"model": ErrorResponse, "description": "Password reset by email is not configured"},
}
_CONFIRM_ERRORS: dict[int | str, dict[str, Any]] = {
    400: {
        "model": ErrorResponse,
        "description": "Code `invalid_token`: the link is unknown, expired or already used",
    }
}


def email_config(request: Request) -> EmailConfig:
    config: EmailConfig = request.app.state.email
    return config


@router.get("/options")
async def auth_options(request: Request) -> AuthOptions:
    """What sign-in can offer on this server. Unauthenticated."""
    return AuthOptions(password_reset=email_config(request).sender is not None)


@router.post("/password-reset", status_code=202, responses=_RESET_ERRORS)
async def request_password_reset(body: ResetRequest, request: Request) -> ResetAccepted:
    """Email a reset link if an account exists for this address (AC1.9). Always 202.

    Limited to 3 requests per email and 10 per client per hour; a limited request sends
    nothing. 503 when email isn't configured.
    """
    config = email_config(request)
    if config.sender is None:
        raise HTTPException(503, "Password reset by email isn't available right now")
    wait = request.app.state.reset_limiter.try_acquire(
        [(f"email:{body.email}", MAX_PER_EMAIL), (f"client:{_client(request)}", MAX_PER_CLIENT)]
    )
    if wait is not None:
        PASSWORD_RESET_REQUESTS.add(1, {"outcome": "rate_limited"})
        raise HTTPException(
            429, "Too many reset requests. Try again later.", headers={"Retry-After": str(wait)}
        )
    task = asyncio.create_task(_deliver(request.app, config, body.email))
    # The loop keeps only a weak reference to a task: hold it until it is done.
    tasks: set[asyncio.Task[None]] = request.app.state.background_tasks
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return ResetAccepted()


def _safe_error(exc: BaseException) -> tuple[str, str]:
    """(type, code) of an error, for the log: never its message, which can hold the recipient's
    address or a bound query value."""
    if isinstance(exc, EmailError):
        return "EmailError", exc.code
    sqlstate = getattr(getattr(exc, "orig", None), "sqlstate", None)
    return type(exc).__name__, sqlstate if isinstance(sqlstate, str) else ""


async def _deliver(app: Any, config: EmailConfig, email: str) -> None:
    """The work after the 202: look the account up, store a token, send the email. Counted as
    exactly one outcome; a failure anywhere counts as `send_failed`."""
    outcome = "send_failed"
    try:
        token = await _issue_token(app, email)
        if token is None:
            outcome = "no_account"
            return
        message = reset_message(email, f"{config.base_url}/reset-password#token={token}")
        assert config.sender is not None
        await asyncio.wait_for(config.sender.send(message), SEND_TIMEOUT_SECONDS)
        outcome = "sent"
    except Exception as exc:
        error_type, error_code = _safe_error(exc)
        logger.error(
            "password reset email failed",
            extra={"error_type": error_type, "error_code": error_code},
        )
    finally:
        PASSWORD_RESET_REQUESTS.add(1, {"outcome": outcome})


async def _issue_token(app: Any, email: str) -> str | None:
    """A fresh token for the account, replacing any earlier link; None when no account."""
    async with app.state.sessionmaker() as db:
        # Locking the user serialises two requests for one account, so only the later link lives.
        user_id = await db.scalar(select(User.id).where(User.email == email).with_for_update())
        if user_id is None:
            return None
        token = new_token()
        old = (
            select(PasswordResetToken.token_hash)
            .where(
                (PasswordResetToken.expires_at < func.now() - timedelta(days=1))
                | (PasswordResetToken.used_at < func.now() - timedelta(days=1))
            )
            .limit(CLEANUP_BATCH)
            .with_for_update(skip_locked=True)
        )
        await db.execute(delete(PasswordResetToken).where(PasswordResetToken.token_hash.in_(old)))
        # A new request invalidates earlier links: mark unused ones used, so they stay on record.
        await db.execute(
            update(PasswordResetToken)
            .where(PasswordResetToken.user_id == user_id, PasswordResetToken.used_at.is_(None))
            .values(used_at=func.now())
        )
        db.add(
            PasswordResetToken(
                token_hash=token_hash(token),
                user_id=user_id,
                expires_at=datetime.now(UTC) + RESET_TTL,
            )
        )
        await db.commit()
        return token


def _invalid_token() -> CodedError:
    return CodedError(400, "invalid_token", INVALID_TOKEN_MESSAGE)


async def _usable(db: AsyncSession, digest: str) -> bool:
    found = await db.scalar(
        select(PasswordResetToken.token_hash).where(
            PasswordResetToken.token_hash == digest,
            PasswordResetToken.used_at.is_(None),
            PasswordResetToken.expires_at > func.now(),
        )
    )
    return found is not None


@router.post("/password-reset/confirm", status_code=204, responses=_CONFIRM_ERRORS)
async def confirm_password_reset(body: ResetConfirm, request: Request, db: DbSession) -> Response:
    """Set a new password with a valid link's token (AC1.9). Single use. Revokes every sign-in
    of the account on every device and clears its sign-in lockout. Doesn't sign in."""
    digest = token_hash(body.token)
    # A cheap check first, so a made-up token doesn't cost an argon2 hash.
    if not await _usable(db, digest):
        raise _invalid_token()
    new_hash = await hash_password(body.password)
    # The claim is one statement, so two requests with one token can't both succeed.
    user_id = await db.scalar(
        update(PasswordResetToken)
        .where(
            PasswordResetToken.token_hash == digest,
            PasswordResetToken.used_at.is_(None),
            PasswordResetToken.expires_at > func.now(),
        )
        .values(used_at=func.now())
        .returning(PasswordResetToken.user_id)
    )
    if user_id is None:
        await db.rollback()
        raise _invalid_token()
    email = await db.scalar(
        update(User).where(User.id == user_id).values(password_hash=new_hash).returning(User.email)
    )
    await db.execute(delete(AuthSession).where(AuthSession.user_id == user_id))
    await db.commit()
    if email is not None:
        request.app.state.signin_limiter.clear_email(email)
    logger.info("password reset completed", extra={"user_id": str(user_id)})
    return Response(status_code=204)
