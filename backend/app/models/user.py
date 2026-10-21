import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.enums import REMINDER_MINUTES, TAGS, in_list


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        # Emails are unique case-insensitively.
        Index("uq_users_email_lower", text("lower(email)"), unique=True),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    email: Mapped[str] = mapped_column(String(320))
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserSettings(Base):
    """One row per user (F12); the column set and defaults are our reading of F12."""

    __tablename__ = "user_settings"
    __table_args__ = (
        CheckConstraint("week_start_day BETWEEN 0 AND 6", name="week_start_day"),
        CheckConstraint("alert_volume BETWEEN 0 AND 100", name="alert_volume"),
        CheckConstraint("background_volume BETWEEN 0 AND 100", name="background_volume"),
        CheckConstraint(
            "default_reminder_minutes IS NULL OR "
            + in_list("default_reminder_minutes", REMINDER_MINUTES),
            name="default_reminder_minutes",
        ),
        CheckConstraint("last_tag IS NULL OR " + in_list("last_tag", TAGS), name="last_tag"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # 0 = Sunday ... 6 = Saturday (AC10.6: Sunday by default).
    week_start_day: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    alert_volume: Mapped[int] = mapped_column(SmallInteger, server_default=text("80"))
    background_volume: Mapped[int] = mapped_column(SmallInteger, server_default=text("50"))
    keep_screen_awake: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    # Default unlimited-timer reminder in minutes; NULL = Off (AC12.4).
    default_reminder_minutes: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    # Last-used Pomodoro configuration (AC12.5); NULL until first use.
    pomodoro_config: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    last_tag: Mapped[str | None] = mapped_column(String(16), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
