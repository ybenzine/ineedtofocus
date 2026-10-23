"""Accounts: sign up, sign in, sign out, current user (F1, #8)."""

import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from app.config import Settings
from app.deps import CurrentUser, DbSession, session_cookie_name
from app.errors import ErrorResponse
from app.models import AuthSession, User, UserSettings
from app.rate_limit import client_key
from app.security import hash_password, new_token, token_hash, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

MIN_PASSWORD_LENGTH = 8  # AC1.1
MAX_PASSWORD_LENGTH = 128
_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")


def _normalize_email(value: str) -> str:
    value = value.strip().lower()
    if len(value) > 320 or not _EMAIL.fullmatch(value):
        raise ValueError("Enter a valid email address")
    return value


Email = Annotated[str, AfterValidator(_normalize_email)]


class SignUpRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Email
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)


class SignInRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Email
    # No minimum here: a wrong or short password is just "invalid credentials".
    password: str = Field(max_length=MAX_PASSWORD_LENGTH)


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    created_at: datetime


def _errors(*codes: int) -> dict[int | str, dict[str, Any]]:
    return {
        c: {"model": ErrorResponse, "description": d}
        for c, d in _DESCRIPTIONS.items()
        if c in codes
    }


_DESCRIPTIONS = {
    401: "Not signed in, or wrong email or password",
    409: "An account with this email already exists",
    429: "Too many attempts; see the Retry-After header",
}


def _settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def _client(request: Request) -> str:
    return client_key(request.client.host if request.client else None)


EXPIRED_CLEANUP_BATCH = 100


async def _start_session(request: Request, response: Response, db: DbSession, user: User) -> None:
    settings = _settings(request)
    token = new_token()
    ttl = timedelta(days=settings.session_ttl_days)
    # Opportunistic, bounded cleanup of expired sessions (#77): at most one batch per sign-in.
    expired = (
        select(AuthSession.token_hash)
        .where(AuthSession.expires_at <= func.now())
        .limit(EXPIRED_CLEANUP_BATCH)
        .with_for_update(skip_locked=True)  # never wait on, or deadlock with, another cleanup
    )
    await db.execute(delete(AuthSession).where(AuthSession.token_hash.in_(expired)))
    db.add(
        AuthSession(
            token_hash=token_hash(token), user_id=user.id, expires_at=datetime.now(UTC) + ttl
        )
    )
    await db.commit()
    response.set_cookie(
        session_cookie_name(settings.cookie_secure),
        token,
        max_age=int(ttl.total_seconds()),
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


@router.post("/signup", status_code=201, responses=_errors(409, 429))
async def sign_up(
    body: SignUpRequest, request: Request, response: Response, db: DbSession
) -> UserOut:
    """Create an account and sign in (AC1.1). Emails are unique case-insensitively.

    Rate limited per client: each sign-up runs a full argon2 hash.
    """
    wait = request.app.state.signup_limiter.try_acquire(_client(request), "")
    if wait is not None:
        raise HTTPException(
            429, "Too many sign-ups. Try again later.", headers={"Retry-After": str(wait)}
        )
    taken = HTTPException(409, "An account with this email already exists")
    if await db.scalar(select(User.id).where(User.email == body.email)):
        raise taken
    user = User(email=body.email, password_hash=await hash_password(body.password))
    db.add(user)
    try:
        await db.flush()  # assigns the id; the unique index decides races
    except IntegrityError:
        await db.rollback()
        raise taken from None
    db.add(UserSettings(user_id=user.id))
    await db.refresh(user)
    await _start_session(request, response, db, user)
    return UserOut(id=user.id, email=user.email, created_at=user.created_at)


@router.post("/signin", responses=_errors(401, 429))
async def sign_in(
    body: SignInRequest, request: Request, response: Response, db: DbSession
) -> UserOut:
    """Sign in with email and password (AC1.2); rate limited."""
    limiter = request.app.state.signin_limiter
    client = _client(request)
    wait = limiter.try_acquire(client, body.email)
    if wait is not None:
        raise HTTPException(
            429, "Too many sign-in attempts. Try again later.", headers={"Retry-After": str(wait)}
        )
    user = await db.scalar(select(User).where(User.email == body.email))
    ok = await verify_password(body.password, user.password_hash if user else None)
    if user is None or not ok:
        raise HTTPException(401, "Incorrect email or password")
    limiter.succeeded(client, body.email)
    await _start_session(request, response, db, user)
    return UserOut(id=user.id, email=user.email, created_at=user.created_at)


@router.post("/signout", status_code=204)
async def sign_out(request: Request, db: DbSession) -> Response:
    """End this device's sign-in. Safe to call when already signed out."""
    token = request.cookies.get(session_cookie_name(_settings(request).cookie_secure))
    if token:
        await db.execute(delete(AuthSession).where(AuthSession.token_hash == token_hash(token)))
        await db.commit()
    response = Response(status_code=204)
    settings = _settings(request)
    response.delete_cookie(
        session_cookie_name(settings.cookie_secure),
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return response


@router.get("/me", responses=_errors(401))
async def me(user: CurrentUser) -> UserOut:
    """The signed-in user."""
    return UserOut(id=user.id, email=user.email, created_at=user.created_at)
