"""Liveness and readiness probes."""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.errors import error_body

router = APIRouter(tags=["health"])


class Status(BaseModel):
    status: str


@router.get("/healthz")
async def healthz() -> Status:
    """Process is up. Does not touch the database."""
    return Status(status="ok")


@router.get("/readyz", response_model=Status, responses={503: {"description": "Database down"}})
async def readyz(request: Request) -> Status | JSONResponse:
    """Ready when the database answers."""
    if await request.app.state.readiness_check():
        return Status(status="ok")
    return JSONResponse(
        status_code=503, content=error_body("unavailable", "Database is not reachable")
    )
