"""Colour theme setting (#214). Additive: one NOT NULL column with a server default.

Old code ignores the column and new rows get "system", so it is safe to run before the new
code is live (expand only).

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "user_settings",
        sa.Column("theme", sa.String(8), server_default=sa.text("'system'"), nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_user_settings_theme"), "user_settings", "theme IN ('system', 'dark', 'light')"
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_user_settings_theme"), "user_settings", type_="check")
    op.drop_column("user_settings", "theme")
