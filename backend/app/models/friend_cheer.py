"""FriendCheer ORM model — one-way encouragement from one friend to another.

A cheer targets a *friend* (not a specific activity event), so the relation
is sender → recipient. Daily limit (24h rolling) is enforced in the route
layer rather than via a uniqueness constraint, which lets us keep the
historical record of every cheer ever sent.
"""

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class FriendCheer(Base):
    __tablename__ = "friend_cheers"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    sender_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    recipient_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
