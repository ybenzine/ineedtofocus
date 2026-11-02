"""Pause background audio during Pomodoro breaks (AC12.6, #370). Expand only.

One NOT NULL column with server default true: existing rows get true too, because the new
behaviour applies to every user. The release before ignores the column, so this is safe to
run before the new code is live. (The issue said 0005; 0005-0007 had landed, so this is 0008.)

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-02
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "user_settings",
        sa.Column(
            "pause_audio_on_breaks", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_column("user_settings", "pause_audio_on_breaks")
