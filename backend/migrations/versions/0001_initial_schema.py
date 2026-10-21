"""Initial schema: users, user_settings, focus_sessions, youtube_recent_links.

Revision ID: 0001
Revises:
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TAGS = "'work', 'study', 'nap', 'read', 'meditation', 'exercise'"


def _uuid_pk(name: str, server_default: bool = True) -> sa.Column[object]:
    return sa.Column(
        name,
        postgresql.UUID(as_uuid=True),
        server_default=sa.text("gen_random_uuid()") if server_default else None,
        nullable=False,
    )


def upgrade() -> None:
    op.create_table(
        "users",
        _uuid_pk("id"),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
    )
    op.create_index("uq_users_email_lower", "users", [sa.text("lower(email)")], unique=True)

    op.create_table(
        "user_settings",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("week_start_day", sa.SmallInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("alert_volume", sa.SmallInteger(), server_default=sa.text("80"), nullable=False),
        sa.Column(
            "background_volume", sa.SmallInteger(), server_default=sa.text("50"), nullable=False
        ),
        sa.Column(
            "keep_screen_awake", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("default_reminder_minutes", sa.SmallInteger(), nullable=True),
        sa.Column("pomodoro_config", postgresql.JSONB(), nullable=True),
        sa.Column("last_tag", sa.String(16), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("user_id", name="pk_user_settings"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_user_settings_user_id_users",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "week_start_day BETWEEN 0 AND 6", name=op.f("ck_user_settings_week_start_day")
        ),
        sa.CheckConstraint(
            "alert_volume BETWEEN 0 AND 100", name=op.f("ck_user_settings_alert_volume")
        ),
        sa.CheckConstraint(
            "background_volume BETWEEN 0 AND 100", name=op.f("ck_user_settings_background_volume")
        ),
        sa.CheckConstraint(
            "default_reminder_minutes IS NULL OR "
            "default_reminder_minutes IN (15, 30, 45, 60, 90, 120)",
            name=op.f("ck_user_settings_default_reminder_minutes"),
        ),
        sa.CheckConstraint(
            f"last_tag IS NULL OR last_tag IN ({TAGS})", name=op.f("ck_user_settings_last_tag")
        ),
    )

    op.create_table(
        "focus_sessions",
        _uuid_pk("id", server_default=False),  # client-generated (AC13.4)
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("tag", sa.String(16), nullable=False),
        sa.Column("goal", sa.String(120), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("focus_seconds", sa.Integer(), nullable=False),
        sa.Column("paused_seconds", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column(
            "mode_config",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("blocks_completed", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id", name="pk_focus_sessions"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_focus_sessions_user_id_users",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(f"tag IN ({TAGS})", name=op.f("ck_focus_sessions_tag")),
        sa.CheckConstraint(
            "mode IN ('countdown', 'pomodoro', 'unlimited')", name=op.f("ck_focus_sessions_mode")
        ),
        sa.CheckConstraint(
            "status IN ('completed', 'ended_early')", name=op.f("ck_focus_sessions_status")
        ),
        sa.CheckConstraint("char_length(goal) <= 120", name=op.f("ck_focus_sessions_goal_length")),
        sa.CheckConstraint("focus_seconds >= 0", name=op.f("ck_focus_sessions_focus_seconds")),
        sa.CheckConstraint("paused_seconds >= 0", name=op.f("ck_focus_sessions_paused_seconds")),
        sa.CheckConstraint(
            "blocks_completed >= 0", name=op.f("ck_focus_sessions_blocks_completed")
        ),
        sa.CheckConstraint(
            "ended_at >= started_at", name=op.f("ck_focus_sessions_ended_after_started")
        ),
    )
    op.create_index(
        "ix_focus_sessions_user_started",
        "focus_sessions",
        ["user_id", sa.text("started_at DESC")],
    )
    op.create_index(
        "ix_focus_sessions_user_tag_started",
        "focus_sessions",
        ["user_id", "tag", sa.text("started_at DESC")],
    )
    op.create_index(
        "ix_focus_sessions_user_archived",
        "focus_sessions",
        ["user_id", "archived_at"],
        postgresql_where=sa.text("archived_at IS NOT NULL"),
    )

    op.create_table(
        "youtube_recent_links",
        _uuid_pk("id"),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("url", sa.String(2048), nullable=False),
        sa.Column(
            "last_used_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id", name="pk_youtube_recent_links"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_youtube_recent_links_user_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("user_id", "url", name="uq_youtube_recent_links_user_url"),
    )
    op.create_index(
        "ix_youtube_recent_links_user_used",
        "youtube_recent_links",
        ["user_id", sa.text("last_used_at DESC")],
    )


def downgrade() -> None:
    op.drop_table("youtube_recent_links")
    op.drop_table("focus_sessions")
    op.drop_table("user_settings")
    op.drop_table("users")
