import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class CalendarFeed(Base):
    """The account's private calendar subscription link (AC14.4, #381): at most one per user.

    Only the SHA-256 of the secret is stored, like `AuthSession`; the secret is shown once when
    the link is made. Neither the secret nor its hash is ever exported, logged or traced.
    """

    __tablename__ = "calendar_feeds"

    # ON DELETE CASCADE is in the database so the release before can still delete an account.
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
