"""Custom tags (#40, #400). Expand only: a new table and two nullable columns.

A custom tag is stored as `tag = 'work'` plus `custom_tag_id`, so the release before, whose
CHECK constraints and enums know only the six built-in tags, reads those sessions and the
last-used tag as Work and keeps working (no rollback floor, no `contract-migration` marker).
`custom_tags.user_id` is `ON DELETE CASCADE` in the database, so the release before can still
delete an account that has custom tags. Nothing here changes or drops an existing object.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

COLORS = "'indigo', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink'"


def upgrade() -> None:
    op.create_table(
        "custom_tags",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(24), nullable=False),
        sa.Column("color", sa.String(8), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.clock_timestamp(),
            nullable=False,
        ),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_custom_tags"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_custom_tags_user_id_users", ondelete="CASCADE"
        ),
        sa.CheckConstraint(f"color IN ({COLORS})", name=op.f("ck_custom_tags_color")),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 24", name=op.f("ck_custom_tags_name")),
    )
    op.create_index(
        "uq_custom_tags_user_name_lower",
        "custom_tags",
        ["user_id", sa.text("lower(name)")],
        unique=True,
    )

    op.add_column(
        "focus_sessions", sa.Column("custom_tag_id", postgresql.UUID(as_uuid=True), nullable=True)
    )
    op.create_foreign_key(
        "fk_focus_sessions_custom_tag_id_custom_tags",
        "focus_sessions",
        "custom_tags",
        ["custom_tag_id"],
        ["id"],
    )
    op.create_index(
        "ix_focus_sessions_user_custom_tag_started",
        "focus_sessions",
        ["user_id", "custom_tag_id", sa.text("started_at DESC")],
        postgresql_where=sa.text("custom_tag_id IS NOT NULL"),
    )

    op.add_column(
        "user_settings", sa.Column("custom_tag_id", postgresql.UUID(as_uuid=True), nullable=True)
    )
    op.create_foreign_key(
        "fk_user_settings_custom_tag_id_custom_tags",
        "user_settings",
        "custom_tags",
        ["custom_tag_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_user_settings_custom_tag_id_custom_tags", "user_settings", type_="foreignkey"
    )
    op.drop_column("user_settings", "custom_tag_id")
    op.drop_index("ix_focus_sessions_user_custom_tag_started", table_name="focus_sessions")
    op.drop_constraint(
        "fk_focus_sessions_custom_tag_id_custom_tags", "focus_sessions", type_="foreignkey"
    )
    op.drop_column("focus_sessions", "custom_tag_id")
    op.drop_index("uq_custom_tags_user_name_lower", table_name="custom_tags")
    op.drop_table("custom_tags")
