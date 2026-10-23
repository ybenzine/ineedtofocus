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

    class Strict(BaseModel):
        model_config = {"extra": "forbid"}
        name: str

    class Tags(BaseModel):
        tags: dict[str, int]

    @app.post("/api/_strict")
    async def strict(body: Strict) -> Strict:
        return body

    @app.post("/api/_tags")
    async def tags(body: Tags) -> Tags:
        return body

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


def test_configure_logging_keeps_telemetry_handler_and_one_json_handler() -> None:
    """The OTLP log handler added by `opentelemetry-instrument` survives (#4)."""

    class ExportHandler(logging.Handler):  # stands in for OpenTelemetry's LoggingHandler
        def __init__(self) -> None:
            super().__init__()
            self.records: list[logging.LogRecord] = []

        def emit(self, record: logging.LogRecord) -> None:
            self.records.append(record)

    root = logging.getLogger()
    saved = root.handlers[:]
    export = ExportHandler()
    try:
        root.handlers[:] = [export, logging.StreamHandler()]
        configure_logging("INFO")
        configure_logging("INFO")  # idempotent: no duplicate console handlers
        streams = [h for h in root.handlers if isinstance(h, logging.StreamHandler)]
        assert export in root.handlers
        assert len(streams) == 1
        assert isinstance(streams[0].formatter, JsonFormatter)
        logging.getLogger("x").info("exported")
        assert [r.getMessage() for r in export.records] == ["exported"]
    finally:
        root.handlers[:] = saved


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


def test_unknown_and_url_keys_are_not_echoed_in_422(client: TestClient) -> None:
    secret = "https://youtube.com/watch?v=abc"
    r = client.post("/api/_strict", json={"name": "x", secret: 1})
    assert r.status_code == 422
    assert "youtube" not in r.text
    assert r.json()["error"]["details"][0]["field"] == "<unknown>"
    r = client.post("/api/_tags", json={"tags": {secret: "nope"}})
    assert r.status_code == 422
    assert "youtube" not in r.text
    assert r.json()["error"]["details"][0]["field"] == "tags.<key>"


def test_routes_added_after_create_app_are_not_shadowed_by_spa(tmp_path: Path) -> None:
    app = make_app(tmp_path, dist=True)

    @app.get("/late")
    async def late() -> dict[str, str]:
        return {"late": "yes"}

    with TestClient(app) as c:
        assert c.get("/late").json() == {"late": "yes"}
        assert "spa" in c.get("/other").text


def test_openapi_describes_error_envelope(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    resp = schema["paths"]["/api/_echo"]["post"]["responses"]["422"]
    assert resp["content"]["application/json"]["schema"]["$ref"].endswith("/ErrorResponse")
    assert "HTTPValidationError" not in schema["components"]["schemas"]
    ready = schema["paths"]["/readyz"]["get"]["responses"]["503"]
    assert ready["content"]["application/json"]["schema"]["$ref"].endswith("/ErrorResponse")


def test_log_scrub_redacts_postgres_detail_line() -> None:
    from app.logging_config import scrub

    msg = "duplicate key\nDETAIL:  Key (lower(email))=(a@b.c) already exists.\nmore"
    out = scrub(msg)
    assert "a@b.c" not in out
    assert out.startswith("duplicate key") and out.endswith("more")


def test_cookie_secure_defaults_to_true_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("COOKIE_SECURE", raising=False)
    assert Settings().cookie_secure is True
