"""Title of a recent YouTube link (#326). Additive: one nullable column.

Old code ignores the column and old rows keep NULL (the client shows "YouTube video"), so it is
safe to run before the new code is live (expand only).

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("youtube_recent_links", sa.Column("title", sa.String(200), nullable=True))


def downgrade() -> None:
    op.drop_column("youtube_recent_links", "title")
