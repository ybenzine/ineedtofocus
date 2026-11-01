"""Last custom Countdown length (#405, #408). Additive: one nullable column, no default.

Old code ignores the column and existing rows read NULL (none), so it is safe to run before
the new code is live (expand only).

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "user_settings", sa.Column("countdown_recent_minutes", sa.SmallInteger(), nullable=True)
    )
    op.create_check_constraint(
        op.f("ck_user_settings_countdown_recent_minutes"),
        "user_settings",
        "countdown_recent_minutes IS NULL OR countdown_recent_minutes BETWEEN 1 AND 240",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_user_settings_countdown_recent_minutes"), "user_settings", type_="check"
    )
    op.drop_column("user_settings", "countdown_recent_minutes")
