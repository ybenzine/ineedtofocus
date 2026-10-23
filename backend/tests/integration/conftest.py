"""Throwaway Postgres databases for integration tests.

Each test gets its own freshly created database on the server at DATABASE_URL (the
compose `db` by default), dropped afterwards, so tests never touch the dev database
(_docs/testing.md). Skipped with a clear reason when Postgres is unreachable.
"""

import asyncio
import uuid
from collections.abc import Callable, Coroutine, Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi import APIRouter
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import Settings
from app.deps import CurrentUser, DbSession
from app.main import create_app

PASSWORD = "correct horse battery"

BACKEND = Path(__file__).resolve().parents[2]


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


async def _drop(server: URL, name: str) -> None:
    """Drop a throwaway database, waiting out Postgres' own background workers.

    Every engine the tests open is disposed before this runs (the app lifespan disposes its
    engine; `_query` and `_admin` dispose theirs), so no test connection is left. What can
    remain is an autovacuum/autoanalyze worker: a freshly migrated and populated database
    soon crosses the analyze threshold, and the worker holds a connection to it for a few
    milliseconds. `DROP DATABASE ... WITH (FORCE)` tries to terminate every connection, and
    the non-superuser test role may not terminate that worker ("permission denied to
    terminate process"). The worker exits on its own, so retry briefly.
    """
    sql = f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'
    for attempt in range(50):
        try:
            await _admin(server, sql)
            return
        except DBAPIError as exc:
            if "permission denied to terminate process" not in str(exc) or attempt == 49:
                raise
            await asyncio.sleep(0.2)


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
        run(_drop(server_url, name))


@pytest.fixture
def alembic_config(test_db_url: str) -> Config:
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "migrations"))
    cfg.set_main_option("sqlalchemy.url", test_db_url.replace("%", "%%"))
    return cfg


MakeClient = Callable[..., AbstractContextManager[TestClient]]


@pytest.fixture
def make_client(alembic_config: Config, test_db_url: str) -> MakeClient:
    """Factory for app clients on one migrated throwaway database.

    Each client is its own app (and event loop); all talk to the same database.
    Keyword arguments override `Settings`.
    """
    command.upgrade(alembic_config, "head")

    @contextmanager
    def make(**overrides: Any) -> Iterator[TestClient]:
        overrides.setdefault("cookie_secure", False)  # tests talk plain http
        app = create_app(Settings(database_url=test_db_url, **overrides))

        # A stand-in for the data endpoints that later issues add (AC1.2, AC1.3).
        router = APIRouter()

        @router.get("/api/_whoami")
        async def whoami(user: CurrentUser, db: DbSession) -> dict[str, str]:
            rows = await db.execute(text("SELECT email FROM users WHERE id = :id"), {"id": user.id})
            return {"email": rows.scalar_one()}

        app.include_router(router)
        with TestClient(app) as c:
            yield c

    return make


def signup(c: TestClient, email: str = "ada@example.com", password: str = PASSWORD) -> Response:
    r: Response = c.post("/api/auth/signup", json={"email": email, "password": password})
    return r


@pytest.fixture
def app_url(alembic_config: Config, test_db_url: str) -> str:
    command.upgrade(alembic_config, "head")
    return test_db_url


@pytest.fixture
def ada(make_client: MakeClient) -> Iterator[TestClient]:
    """Ada, signed up; her `.bob` attribute is a second signed-up client (the `bob` fixture)."""
    with make_client() as c, make_client() as bob:
        assert signup(c, "ada@example.com").status_code == 201
        assert signup(bob, "bob@example.com").status_code == 201
        c.bob = bob
        yield c


@pytest.fixture
def bob(ada: TestClient) -> TestClient:
    client: TestClient = ada.bob
    return client
