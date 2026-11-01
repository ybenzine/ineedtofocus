import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.enums import COLORS, TAG_NAME_MAX_LENGTH, in_list


class CustomTag(Base):
    """A tag the user made (AC7.4). Removing one only sets `removed_at`: sessions keep it.

    The name is user content: never logged, traced or used as a metric label (AC7.9).
    """

    __tablename__ = "custom_tags"
    __table_args__ = (
        CheckConstraint(in_list("color", COLORS), name="color"),
        CheckConstraint(f"char_length(name) BETWEEN 1 AND {TAG_NAME_MAX_LENGTH}", name="name"),
        # Names are unique per account ignoring case, removed tags included, also when two
        # requests race (AC7.4).
        Index("uq_custom_tags_user_name_lower", "user_id", text("lower(name)"), unique=True),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    # ON DELETE CASCADE is in the database so the release before can still delete an account.
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(TAG_NAME_MAX_LENGTH))
    color: Mapped[str] = mapped_column(String(8))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp()
    )
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
