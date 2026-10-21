"""Unit tests for the app skeleton (#7), using a fake readiness check (no database)."""

import io
import json
import logging
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

from app.config import Settings
from app.logging_config import JsonFormatter, configure_logging
from app.main import create_app


async def _up() -> bool:
    return True


async def _down() -> bool:
    return False


def make_app(tmp_path: Path, ready: bool = True, dist: bool = False) -> FastAPI:
    dist_dir = tmp_path / "dist"
    if dist:
        (dist_dir / "assets").mkdir(parents=True)
        (dist_dir / "index.html").write_text("<html>spa</html>")
        (dist_dir / "assets" / "app.js").write_text("console.log(1)")
    app = create_app(Settings(frontend_dist=dist_dir), readiness_check=_up if ready else _down)

    class Body(BaseModel):
        minutes: int = Field(ge=1, le=240)

    @app.post("/api/_echo")
    async def echo(body: Body) -> Body:
        return body

    @app.get("/api/_boom")
    async def boom() -> None:
        raise RuntimeError("secret-cookie-value")

    return app


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(make_app(tmp_path), raise_server_exceptions=False) as c:
        yield c


def test_settings_read_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@h/db")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    s = Settings()
    assert s.database_url == "postgresql+asyncpg://u:p@h/db"
    assert s.log_level == "DEBUG"


def test_healthz_does_not_need_database(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path, ready=False)) as c:
        r = c.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_readyz_ok_when_database_reachable(client: TestClient) -> None:
    r = client.get("/readyz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_readyz_503_when_database_down(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path, ready=False)) as c:
        r = c.get("/readyz")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "unavailable"


def test_validation_error_is_422_with_field_details(client: TestClient) -> None:
    r = client.post("/api/_echo", json={"minutes": 999, "email": "a@b.c"})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "validation_error"
    assert err["details"][0]["field"] == "minutes"
    assert "999" not in r.text  # submitted input is not echoed back


def test_not_found_uses_error_format(client: TestClient) -> None:
    r = client.get("/api/nope")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


def test_unhandled_error_is_500_json_without_leaking_detail(client: TestClient) -> None:
    r = client.get("/api/_boom")
    assert r.status_code == 500
    assert r.json() == {"error": {"code": "internal_error", "message": "Internal server error"}}


def test_logs_are_json_with_extras_and_exceptions() -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    lg = logging.getLogger("test.json")
    lg.addHandler(handler)
    lg.propagate = False
    try:
        raise ValueError("x")
    except ValueError:
        lg.error("failed", extra={"user_id": "u-1"}, exc_info=True)
    line = json.loads(stream.getvalue())
    assert line["level"] == "ERROR"
    assert line["message"] == "failed"
    assert line["user_id"] == "u-1"
    assert "ValueError" in line["exception"]
    assert "timestamp" in line


def test_configure_logging_writes_json_to_stdout(capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging("INFO")
    logging.getLogger("x").info("hello")
    out = capsys.readouterr().out.strip().splitlines()[-1]
    assert json.loads(out)["message"] == "hello"


def test_unhandled_error_log_has_no_request_data(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    app = make_app(tmp_path)
    with TestClient(app, raise_server_exceptions=False) as c:
        c.get("/api/_boom", headers={"Cookie": "session=abc123"})
    out = capsys.readouterr().out
    assert "abc123" not in out


def test_frontend_absent_is_graceful(client: TestClient) -> None:
    assert client.get("/").status_code == 404
    assert client.get("/healthz").status_code == 200


def test_serves_frontend_with_spa_fallback(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path, dist=True)) as c:
        assert "spa" in c.get("/").text
        assert c.get("/assets/app.js").text == "console.log(1)"
        assert "spa" in c.get("/history/week").text  # client-side route
        assert c.get("/healthz").json() == {"status": "ok"}  # API not shadowed
        r = c.get("/api/unknown")
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "not_found"
        assert "spa" in c.get("/..%2f..%2fetc/passwd").text  # no traversal out of dist
