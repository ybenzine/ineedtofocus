"""Async SQLAlchemy engine and the readiness probe."""

import asyncio
from collections.abc import Awaitable, Callable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

ReadinessCheck = Callable[[], Awaitable[bool]]


def create_engine(database_url: str) -> AsyncEngine:
    return create_async_engine(database_url, pool_pre_ping=True)


def database_check(engine: AsyncEngine, timeout: float) -> ReadinessCheck:
    """Return a check that is True when the database answers `SELECT 1` in time."""

    async def check() -> bool:
        try:
            async with asyncio.timeout(timeout), engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
        except Exception:  # unreachable, auth failure, timeout: all mean "not ready"
            return False
        return True

    return check
