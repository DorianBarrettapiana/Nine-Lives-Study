"""User XP and level progress ORM model."""

from sqlalchemy import ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# Base XP per level — level N requires N * XP_PER_LEVEL XP to advance.
# Total XP to reach level L from level 1: XP_PER_LEVEL * L * (L - 1) / 2.
#   L=2: 100   L=3: 300   L=5: 1000   L=10: 4500
# This is a deliberately progressive curve: early levels still feel
# rewarding, later levels take real commitment.
XP_PER_LEVEL = 100


def xp_needed_in_level(level: int) -> int:
    """XP needed WITHIN level `level` to advance to `level + 1`."""
    return level * XP_PER_LEVEL


def level_from_xp(total_xp: int) -> tuple[int, int, int]:
    """Return (level, xp_in_current_level, xp_to_next_level) for a total XP.

    Walks levels accumulating their thresholds until the remaining XP fits
    inside the current level. Safe (no infinite loop) thanks to the cap.
    """
    if total_xp < 0:
        total_xp = 0
    level = 1
    remaining = total_xp
    # Caps the loop in case of corrupt data; nobody hits level 1000 in
    # this app's lifetime so this is purely defensive.
    while level < 10_000:
        need = xp_needed_in_level(level)
        if remaining < need:
            return level, remaining, need - remaining
        remaining -= need
        level += 1
    return level, 0, xp_needed_in_level(level)


class UserProgress(Base):
    """Track XP and level for a user (one row per user)."""

    __tablename__ = "user_progress"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    xp: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    level: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
