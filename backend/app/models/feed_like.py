"""FeedLike ORM model — flower reactions on friend activity feed."""

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class FeedLike(Base):
    __tablename__ = "feed_likes"
    __table_args__ = (
        UniqueConstraint("user_id", "xp_event_id", name="uq_feed_like"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    xp_event_id: Mapped[int] = mapped_column(
        ForeignKey("xp_events.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
