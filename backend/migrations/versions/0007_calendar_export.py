"""Calendar export (F14, AC12.8, #381). Expand only: six settings columns and a new table.

Every new `user_settings` column has a server default, so existing rows get the defaults and
the release before, which doesn't know the columns, keeps working (its inserts and updates
leave them alone). `calendar_feeds.user_id` is `ON DELETE CASCADE` in the database, so the
release before can still delete an account that has a feed. Nothing existing is changed.

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-02
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "user_settings",
        sa.Column(
            "calendar_title_template",
            sa.String(120),
            server_default="{tag}: {goal}",
            nullable=False,
        ),
    )
    op.add_column(
        "user_settings",
        sa.Column(
            "calendar_include_goal", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
    )
    op.add_column(
        "user_settings",
        sa.Column(
            "calendar_include_description",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
    )
    op.add_column(
        "user_settings",
        sa.Column(
            "calendar_excluded_tags",
            postgresql.JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "user_settings",
        sa.Column(
            "calendar_min_minutes", sa.SmallInteger(), server_default=sa.text("0"), nullable=False
        ),
    )
    op.add_column(
        "user_settings",
        sa.Column("calendar_name", sa.String(60), server_default="I Need To Focus", nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_user_settings_calendar_title_template"),
        "user_settings",
        "char_length(calendar_title_template) <= 120",
    )
    op.create_check_constraint(
        op.f("ck_user_settings_calendar_name"),
        "user_settings",
        "char_length(calendar_name) BETWEEN 1 AND 60",
    )
    op.create_check_constraint(
        op.f("ck_user_settings_calendar_min_minutes"),
        "user_settings",
        "calendar_min_minutes IN (0, 5, 10, 15)",
    )
    op.create_check_constraint(
        op.f("ck_user_settings_calendar_excluded_tags"),
        "user_settings",
        "jsonb_typeof(calendar_excluded_tags) = 'array'",
    )

    op.create_table(
        "calendar_feeds",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("last_fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("user_id", name="pk_calendar_feeds"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_calendar_feeds_user_id_users", ondelete="CASCADE"
        ),
        sa.UniqueConstraint("token_hash", name="uq_calendar_feeds_token_hash"),
    )


def downgrade() -> None:
    op.drop_table("calendar_feeds")
    for name in (
        "calendar_excluded_tags",
        "calendar_min_minutes",
        "calendar_name",
        "calendar_title_template",
    ):
        op.drop_constraint(op.f(f"ck_user_settings_{name}"), "user_settings", type_="check")
    for column in (
        "calendar_name",
        "calendar_min_minutes",
        "calendar_excluded_tags",
        "calendar_include_description",
        "calendar_include_goal",
        "calendar_title_template",
    ):
        op.drop_column("user_settings", column)
