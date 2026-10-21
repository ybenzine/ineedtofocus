"""Throwaway Postgres databases for integration tests.

Each test gets its own freshly created database on the server at DATABASE_URL (the
compose `db` by default), dropped afterwards, so tests never touch the dev database
(_docs/testing.md). Skipped with a clear reason when Postgres is unreachable.
"""

import asyncio
import uuid
from collections.abc import Coroutine, Iterator
from typing import Any

import pytest
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import Settings


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


async def _admin(server: URL, sql: str) -> None:
    engine = create_async_engine(
        server.set(database="postgres"), isolation_level="AUTOCOMMIT", poolclass=None
    )
    try:
        async with engine.connect() as conn:
            await conn.execute(text(sql))
    finally:
        await engine.dispose()


@pytest.fixture(scope="session")
def server_url() -> URL:
    url = make_url(Settings().database_url)
    try:
        run(_admin(url, "SELECT 1"))
    except Exception:
        pytest.skip("no Postgres reachable at DATABASE_URL; run `make up` to enable")
    return url


@pytest.fixture
def test_db_url(server_url: URL) -> Iterator[str]:
    """URL of an empty, uniquely named database that is dropped after the test."""
    name = f"focus_test_{uuid.uuid4().hex[:12]}"
    run(_admin(server_url, f'CREATE DATABASE "{name}"'))
    try:
        yield server_url.set(database=name).render_as_string(hide_password=False)
    finally:
        run(_admin(server_url, f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))


@pytest.fixture
def alembic_config(test_db_url: str) -> Config:
    cfg = Config("alembic.ini")
    cfg.set_main_option("script_location", "migrations")
    cfg.set_main_option("sqlalchemy.url", test_db_url.replace("%", "%%"))
    return cfg
