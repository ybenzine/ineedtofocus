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


@lru_cache
def get_settings() -> Settings:
    return Settings()
