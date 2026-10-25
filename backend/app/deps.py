"""Request dependencies: database session and the signed-in user."""

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import AuthSession, User
from app.security import token_hash
from app.telemetry import tag_user

SESSION_COOKIE = "focus_session"


def session_cookie_name(secure: bool) -> str:
    """`__Host-focus_session` when cookies are Secure (deployed): the prefix stops a sibling
    subdomain setting it. Plain-http local work cannot use the prefix, which requires Secure."""
    return f"__Host-{SESSION_COOKIE}" if secure else SESSION_COOKIE


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    sessionmaker: async_sessionmaker[AsyncSession] = request.app.state.sessionmaker
    async with sessionmaker() as session:
        yield session


DbSession = Annotated[AsyncSession, Depends(get_session)]


async def current_user(request: Request, db: DbSession) -> User:
    """The signed-in user, or 401. Every data endpoint depends on this (AC1.2) and must
    scope its queries to `user.id` (AC1.3)."""
    token = request.cookies.get(session_cookie_name(request.app.state.settings.cookie_secure))
    if token:
        user = await db.scalar(
            select(User)
            .join(AuthSession, AuthSession.user_id == User.id)
            .where(AuthSession.token_hash == token_hash(token), AuthSession.expires_at > func.now())
        )
        if user is not None:
            # The opaque internal id only (never the email) lets a trace be tied to a user.
            tag_user(str(user.id))
            return user
    raise HTTPException(status_code=401, detail="Not signed in")


CurrentUser = Annotated[User, Depends(current_user)]
