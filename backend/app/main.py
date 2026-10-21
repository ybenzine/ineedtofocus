"""FastAPI application factory."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import __version__
from app.config import Settings, get_settings
from app.db import ReadinessCheck, create_engine, database_check
from app.errors import fix_openapi, register_error_handlers
from app.health import router as health_router
from app.logging_config import configure_logging
from app.web import mount_frontend

logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None, readiness_check: ReadinessCheck | None = None
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    engine = create_engine(settings.database_url)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logger.info("app starting", extra={"version": __version__})
        yield
        await engine.dispose()

    app = FastAPI(title="I Need To Focus", version=__version__, lifespan=lifespan)
    app.state.readiness_check = readiness_check or database_check(
        engine, settings.readiness_timeout_seconds
    )
    register_error_handlers(app)
    fix_openapi(app)
    app.include_router(health_router)
    mount_frontend(app, settings.frontend_dist)
    return app


def app_factory() -> FastAPI:
    """Entry point for `uvicorn app.main:app_factory --factory`."""
    return create_app()
