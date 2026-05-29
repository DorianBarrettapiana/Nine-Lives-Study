"""Pomodoro session ORM model."""

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def utc_now() -> datetime:
    """Return the current UTC datetime."""
    return datetime.now(timezone.utc)


class PomodoroSession(Base):
    """Represent a single Pomodoro work or break session."""

    __tablename__ = "pomodoro_sessions"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    session_type: Mapped[str] = mapped_column(
        String(10), default="work", nullable=False
    )
    duration_minutes: Mapped[int] = mapped_column(Integer, default=25, nullable=False)
    is_completed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    started_at: Mapped[datetime] = mapped_column(
        DateTime(),
        default=utc_now,
        nullable=False,
    )
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(),
        nullable=True,
    )

    # Partial unique index: at most ONE in-progress work pomodoro per user.
    # Same family of bug as the stopwatch race — without this, two concurrent
    # POST /pomodoro requests could both pass the (currently absent) check and
    # leave the user with multiple "in progress" work sessions, each granting
    # 1 XP/min on Complete. Break sessions intentionally excluded: they're
    # short, count no XP, and the auto-cycle UX benefits from leniency.
    __table_args__ = (
        Index(
            "uq_pomodoro_one_active_work_per_user",
            "user_id",
            unique=True,
            sqlite_where=text("is_completed = 0 AND session_type = 'work'"),
            postgresql_where=text("is_completed = false AND session_type = 'work'"),
        ),
    )
