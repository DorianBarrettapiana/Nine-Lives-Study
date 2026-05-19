"""FeedCheer ORM model — bonus-XP cheers given by friends on activity items.

Unlike FeedLike (a toggleable reaction), a cheer is a one-shot, one-way
action: friend A cheers friend B's event, B receives +1 XP. Each user
can cheer a given event at most once, and is limited to a daily cap.
"""

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class FeedCheer(Base):
    __tablename__ = "feed_cheers"
    __table_args__ = (
        UniqueConstraint("user_id", "xp_event_id", name="uq_feed_cheer"),
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
