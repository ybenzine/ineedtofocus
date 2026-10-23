"""Follow-ups from the #7 reviews, folded into #8: body-level JSON errors, route-raised
404s outside /api, and OpenAPI metadata and nested error models."""

from pathlib import Path

from fastapi import HTTPException
from fastapi.testclient import TestClient

from tests.unit.test_app import make_app


def test_malformed_json_body_is_a_body_level_field(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path)) as c:
        r = c.post("/api/_echo", content="{not json", headers={"content-type": "application/json"})
    assert r.status_code == 422
    (detail,) = r.json()["error"]["details"]
    assert detail["field"] == "body"
    assert detail["type"] == "json_invalid"


def test_route_raised_404_outside_api_stays_json_with_frontend(tmp_path: Path) -> None:
    app = make_app(tmp_path, dist=True)

    @app.get("/things/{thing_id}")
    async def thing(thing_id: str) -> None:
        raise HTTPException(status_code=404, detail="No such thing")

    with TestClient(app) as c:
        r = c.get("/things/1")
        assert r.status_code == 404
        assert r.json()["error"] == {"code": "not_found", "message": "No such thing"}
        assert "spa" in c.get("/unmatched").text  # real routing misses still get the SPA


def test_openapi_keeps_app_metadata_and_registers_error_models(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    app.description = "Described"
    app.openapi_tags = [{"name": "t", "description": "d"}]
    app.servers = [{"url": "https://example.com"}]
    app.openapi_schema = None
    schema = app.openapi()
    assert schema["info"]["description"] == "Described"
    assert schema["tags"] == [{"name": "t", "description": "d"}]
    assert schema["servers"] == [{"url": "https://example.com"}]
    assert {"ErrorResponse", "ErrorInfo", "ErrorDetail"} <= set(schema["components"]["schemas"])
