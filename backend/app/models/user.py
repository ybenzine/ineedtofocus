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
from app.models.enums import (
    CALENDAR_MIN_MINUTES,
    CALENDAR_NAME_DEFAULT,
    CALENDAR_NAME_MAX_LENGTH,
    CALENDAR_TITLE_DEFAULT,
    CALENDAR_TITLE_MAX_LENGTH,
    REMINDER_MINUTES,
    TAGS,
    THEMES,
    in_list,
)
from app.models.tag_ref import effective_tag, set_tag


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
        CheckConstraint(
            "default_reminder_minutes IS NULL OR "
            + in_list("default_reminder_minutes", REMINDER_MINUTES),
            name="default_reminder_minutes",
        ),
        CheckConstraint("last_tag IS NULL OR " + in_list("last_tag", TAGS), name="last_tag"),
        CheckConstraint(in_list("theme", THEMES), name="theme"),
        CheckConstraint(
            "countdown_recent_minutes IS NULL OR countdown_recent_minutes BETWEEN 1 AND 240",
            name="countdown_recent_minutes",
        ),
        CheckConstraint(
            f"char_length(calendar_title_template) <= {CALENDAR_TITLE_MAX_LENGTH}",
            name="calendar_title_template",
        ),
        CheckConstraint(
            f"char_length(calendar_name) BETWEEN 1 AND {CALENDAR_NAME_MAX_LENGTH}",
            name="calendar_name",
        ),
        CheckConstraint(
            in_list("calendar_min_minutes", CALENDAR_MIN_MINUTES), name="calendar_min_minutes"
        ),
        CheckConstraint(
            "jsonb_typeof(calendar_excluded_tags) = 'array'", name="calendar_excluded_tags"
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # 0 = Sunday ... 6 = Saturday (AC10.6: Sunday by default).
    week_start_day: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    # `alert_volume` and `background_volume` (device settings since #336) were dropped by
    # migration 0009 (#430). The model stopped mapping them one release earlier (#446), so no
    # query named a column that was about to go.
    keep_screen_awake: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    # Pause Rain/YouTube audio during Pomodoro breaks (AC12.6); on for everyone by default.
    pause_audio_on_breaks: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    # Default unlimited-timer reminder in minutes; NULL = Off (AC12.4).
    default_reminder_minutes: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    # Last-used Pomodoro configuration (AC12.5); NULL until first use.
    pomodoro_config: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    # Last custom Countdown length in minutes (#405, AC2.7); NULL = none. Not checked against
    # the presets: those are a client rule.
    countdown_recent_minutes: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    # Like `FocusSession.tag`: "work" here plus `custom_tag_id` means a custom last-used tag.
    last_tag: Mapped[str | None] = mapped_column(String(16), nullable=True)
    custom_tag_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("custom_tags.id"), nullable=True
    )
    # Colour theme (#214): "system" follows the device's light/dark setting.
    theme: Mapped[str] = mapped_column(String(8), server_default=text("'system'"))
    # Calendar export (F14, AC12.8, #381). The title template is user content, like goals.
    calendar_title_template: Mapped[str] = mapped_column(
        String(CALENDAR_TITLE_MAX_LENGTH), server_default=CALENDAR_TITLE_DEFAULT
    )
    calendar_include_goal: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    calendar_include_description: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    # The tags LEFT OUT of the feed (built-in identifiers or custom tag ids), so a tag created
    # later is in by default.
    calendar_excluded_tags: Mapped[list[str]] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb")
    )
    calendar_min_minutes: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    calendar_name: Mapped[str] = mapped_column(
        String(CALENDAR_NAME_MAX_LENGTH), server_default=CALENDAR_NAME_DEFAULT
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    @property
    def effective_last_tag(self) -> str | None:
        """`last_tag` as the API shows it: a built-in identifier, a custom tag's id or None."""
        if self.last_tag is None:
            return None
        return effective_tag(self.last_tag, self.custom_tag_id)

    def set_last_tag(self, value: str | None) -> None:
        """Store a built-in identifier, a custom tag's id or None (see `last_tag`)."""
        if value is None:
            self.last_tag, self.custom_tag_id = None, None
        else:
            self.last_tag, self.custom_tag_id = set_tag(value)
