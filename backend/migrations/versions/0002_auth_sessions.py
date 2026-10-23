"""Sign-in sessions for the cookie auth (#8). Additive: one new table.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-23
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "auth_sessions",
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("token_hash", name="pk_auth_sessions"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_auth_sessions_user_id_users", ondelete="CASCADE"
        ),
    )
    op.create_index("ix_auth_sessions_user", "auth_sessions", ["user_id"])


def downgrade() -> None:
    op.drop_table("auth_sessions")
