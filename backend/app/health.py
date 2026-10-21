"""Liveness and readiness probes."""

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.errors import ErrorResponse, error_body

router = APIRouter(tags=["health"])


class Status(BaseModel):
    status: str


@router.get("/healthz")
async def healthz() -> Status:
    """Process is up. Does not touch the database."""
    return Status(status="ok")


_DOWN: dict[int | str, dict[str, Any]] = {
    503: {"model": ErrorResponse, "description": "Database down"}
}


@router.get("/readyz", response_model=Status, responses=_DOWN)
async def readyz(request: Request) -> Status | JSONResponse:
    """Ready when the database answers."""
    if await request.app.state.readiness_check():
        return Status(status="ok")
    return JSONResponse(
        status_code=503, content=error_body("unavailable", "Database is not reachable")
    )
