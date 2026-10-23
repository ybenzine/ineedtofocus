"""Consistent JSON error format.

Every error response is `{"error": {"code", "message", "details"?}}`.
Validation errors are 422 with `details` listing `{field, message, type}`.
"""

import logging
import re
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)

_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    422: "validation_error",
    429: "rate_limited",
    503: "unavailable",
}


class ErrorDetail(BaseModel):
    field: str
    message: str
    type: str


class ErrorInfo(BaseModel):
    code: str
    message: str
    details: list[ErrorDetail] | None = None


class ErrorResponse(BaseModel):
    """The one error format returned by every non-2xx response."""

    error: ErrorInfo


def error_body(code: str, message: str, details: Any = None) -> dict[str, Any]:
    body: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        body["details"] = details
    return {"error": body}


_SAFE_SEGMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")


def _field(loc: tuple[Any, ...], error_type: str) -> str:
    """Client-visible field path that never echoes client-chosen keys.

    Segments that are not plain identifiers (e.g. a URL used as a dict key) become
    `<key>`, and the name of an unexpected extra field becomes `<unknown>`.
    """
    if error_type == "json_invalid":
        return "body"  # loc is the parser's character offset, not a field
    skip = ("body", "query", "path", "header", "cookie")
    out = [
        str(p) if isinstance(p, int) or _SAFE_SEGMENT.fullmatch(str(p)) else "<key>"
        for p in loc
        if p not in skip
    ]
    if error_type == "extra_forbidden" and out:
        out[-1] = "<unknown>"
    return ".".join(out)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Only field names and messages: never echo submitted input back.
        details = [
            {"field": _field(tuple(e["loc"]), e["type"]), "message": e["msg"], "type": e["type"]}
            for e in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content=error_body("validation_error", "Request validation failed", details),
        )

    @app.exception_handler(StarletteHTTPException)
    async def http(_: Request, exc: StarletteHTTPException) -> Response:
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(_CODES.get(exc.status_code, "error"), str(exc.detail)),
            headers=exc.headers,
        )

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception) -> JSONResponse:
        logger.error("unhandled exception", exc_info=exc)
        return JSONResponse(
            status_code=500,
            content=error_body("internal_error", "Internal server error"),
        )


def fix_openapi(app: FastAPI) -> None:
    """Make the generated schema describe the real 422 envelope, not FastAPI's default."""

    def openapi() -> dict[str, Any]:
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(
            title=app.title,
            version=app.version,
            openapi_version=app.openapi_version,
            summary=app.summary,
            description=app.description,
            terms_of_service=app.terms_of_service,
            contact=app.contact,
            license_info=app.license_info,
            routes=app.routes,
            webhooks=app.webhooks.routes,
            tags=app.openapi_tags,
            servers=app.servers,
        )
        ref = {"$ref": "#/components/schemas/ErrorResponse"}
        schemas = schema.setdefault("components", {}).setdefault("schemas", {})
        # Register ErrorResponse and its nested models whether or not a route uses them.
        error_schema = ErrorResponse.model_json_schema(ref_template="#/components/schemas/{model}")
        for name, nested in error_schema.pop("$defs", {}).items():
            schemas.setdefault(name, nested)
        schemas.setdefault("ErrorResponse", error_schema)
        for item in schema["paths"].values():
            for op in item.values():
                resp = op.get("responses", {}).get("422")
                if resp is not None:
                    resp["description"] = "Validation error"
                    resp["content"] = {"application/json": {"schema": ref}}
        schemas.pop("HTTPValidationError", None)
        schemas.pop("ValidationError", None)
        app.openapi_schema = schema
        return schema

    app.openapi = openapi  # type: ignore[method-assign]
