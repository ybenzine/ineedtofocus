"""FastAPI application factory."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from opentelemetry.sdk.trace import TracerProvider
from sqlalchemy.ext.asyncio import async_sessionmaker

from app import __version__
from app.auth import router as auth_router
from app.config import Settings, get_settings
from app.db import ReadinessCheck, create_engine, database_check
from app.errors import fix_openapi, register_error_handlers
from app.health import router as health_router
from app.logging_config import configure_logging
from app.rate_limit import FailureLimiter
from app.settings_api import router as settings_router
from app.telemetry import install_privacy_filters, telemetry_config
from app.web import mount_frontend

logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    readiness_check: ReadinessCheck | None = None,
    tracer_provider: TracerProvider | None = None,
) -> FastAPI:
    """Build the app. `tracer_provider` overrides the global one (tests)."""
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    engine = create_engine(settings.database_url)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logger.info("app starting", extra={"version": __version__})
        yield
        await engine.dispose()

    app = FastAPI(
        title="I Need To Focus",
        version=__version__,
        lifespan=lifespan,
        telemetry=telemetry_config(tracer_provider),
    )
    app.state.readiness_check = readiness_check or database_check(
        engine, settings.readiness_timeout_seconds
    )
    app.state.settings = settings
    app.state.sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    app.state.signin_limiter = FailureLimiter(
        settings.signin_max_failures,
        settings.signin_max_failures_per_client,
        settings.signin_window_seconds,
    )
    register_error_handlers(app)
    fix_openapi(app)
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(settings_router)
    mount_frontend(app, settings.frontend_dist)
    return app


def app_factory() -> FastAPI:
    """Entry point for `uvicorn app.main:app_factory --factory`."""
    install_privacy_filters()  # no-op unless run under `opentelemetry-instrument`
    return create_app()
