"""Drop the unused sound-level settings (#430). The repo's first contract migration.

The sound levels have been device settings since #336 (AC12.2). Two releases got the code out
first: #443 stopped returning, accepting and exporting the two columns, and #446 (96538d6)
stopped mapping them in the model, so the release before this one no longer maps, reads,
writes or returns them. Dropping them is safe for it, but not for a release from before #446:
that one selects and inserts them and would fail on this schema. So prod must take #446 before
this revision, and the revision sets each environment's rollback floor when that environment
deploys it (_docs/deployment.md, Rollback floor). Dropping a column drops its CHECK constraint
too.

downgrade() puts both columns back with their old defaults (80, 50) and checks. Rows get the
defaults: the values they held are not recoverable.

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-02
"""

# contract-migration: volume columns unused since #336 and gone from the API in #443
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("user_settings", "alert_volume")
    op.drop_column("user_settings", "background_volume")


def downgrade() -> None:
    op.add_column(
        "user_settings",
        sa.Column("alert_volume", sa.SmallInteger(), server_default=sa.text("80"), nullable=False),
    )
    op.add_column(
        "user_settings",
        sa.Column(
            "background_volume", sa.SmallInteger(), server_default=sa.text("50"), nullable=False
        ),
    )
    op.create_check_constraint(
        op.f("ck_user_settings_alert_volume"), "user_settings", "alert_volume BETWEEN 0 AND 100"
    )
    op.create_check_constraint(
        op.f("ck_user_settings_background_volume"),
        "user_settings",
        "background_volume BETWEEN 0 AND 100",
    )
