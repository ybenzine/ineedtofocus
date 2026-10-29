import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class YoutubeRecentLink(Base):
    """Recently used YouTube links per user (AC8.6). The API keeps the latest 5."""

    __tablename__ = "youtube_recent_links"
    __table_args__ = (
        UniqueConstraint("user_id", "url", name="uq_youtube_recent_links_user_url"),
        Index("ix_youtube_recent_links_user_used", "user_id", text("last_used_at DESC")),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )
    url: Mapped[str] = mapped_column(String(2048))
    # The video or playlist title the player reported (#326). User content: never logged.
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    last_used_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
