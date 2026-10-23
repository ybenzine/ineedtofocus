"""Application settings, read from environment variables."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_DEFAULT_DB = "postgresql+asyncpg://focus:focus@localhost:5432/focus"


class Settings(BaseSettings):
    """Settings; every field maps to an upper-case env var (see .env.example)."""

    model_config = SettingsConfigDict(extra="ignore")

    database_url: str = Field(default=_DEFAULT_DB)
    log_level: str = Field(default="INFO")
    # Built frontend (Vite output). Absent in local dev; the API still works.
    frontend_dist: Path = Field(default=Path(__file__).resolve().parents[2] / "frontend" / "dist")
    readiness_timeout_seconds: float = Field(default=2.0, gt=0)
    # Session cookie: `Secure` must be on in deployed (HTTPS) environments (#8).
    cookie_secure: bool = Field(default=True)
    session_ttl_days: int = Field(default=30, ge=1)
    # Failed sign-ins allowed per window: per (client, email) and per client (#8).
    signin_max_failures: int = Field(default=5, ge=1)
    signin_max_failures_per_client: int = Field(default=20, ge=1)
    signin_window_seconds: float = Field(default=900.0, gt=0)
    # Sign-ups allowed per client within the window (each runs a full argon2 hash).
    signup_max_per_client: int = Field(default=10, ge=1)
    signup_window_seconds: float = Field(default=3600.0, gt=0)


@lru_cache
def get_settings() -> Settings:
    return Settings()
