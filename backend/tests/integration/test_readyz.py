"""/readyz against a real Postgres (the compose `db`, via `make up`).

Skipped with a clear reason when no database is reachable at DATABASE_URL.
"""

import asyncio
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import create_engine, database_check
from app.main import create_app

pytestmark = pytest.mark.integration


def _reachable(url: str) -> bool:
    async def probe() -> bool:
        engine = create_engine(url)
        try:
            return await database_check(engine, 2.0)()
        finally:
            await engine.dispose()

    return asyncio.run(probe())


@pytest.fixture(scope="module")
def settings() -> Settings:
    s = Settings()
    if not _reachable(s.database_url):
        pytest.skip("no Postgres reachable at DATABASE_URL; run `make up` to enable")
    return s


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as c:
        yield c


def test_readyz_ok_with_real_database(client: TestClient) -> None:
    r = client.get("/readyz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_readyz_503_when_database_unreachable() -> None:
    bad = Settings(
        database_url="postgresql+asyncpg://x:x@127.0.0.1:1/none", readiness_timeout_seconds=1
    )
    with TestClient(create_app(bad)) as c:
        r = c.get("/readyz")
        assert r.status_code == 503
        assert c.get("/healthz").status_code == 200
