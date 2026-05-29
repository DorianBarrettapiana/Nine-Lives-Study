"""Stopwatch / "positive timing" work session.

A stopwatch session is an open-ended work block: the user presses Start,
optionally pauses/resumes, and presses End when done. Unlike a pomodoro,
there is no target duration — the result is whatever wall-clock time was
actually counted (excluding paused intervals).

State machine:
  - Active running: `last_started_at` is set, `ended_at` is NULL.
  - Active paused:  `last_started_at` is NULL, `ended_at` is NULL.
  - Ended:          `ended_at` is set; the session is immutable.

`accumulated_seconds` is the canonical total of counted time across all
prior running segments — the current running segment, if any, has not yet
been merged in. Compute total = accumulated_seconds + (now - last_started_at)
when running.
"""

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, Integer, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class StopwatchSession(Base):
    __tablename__ = "stopwatch_sessions"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    # First Start.
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False,
    )
    # Final End. NULL while still active (running or paused).
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    # Counted seconds from prior running segments. Does NOT include the
    # in-progress segment when running.
    accumulated_seconds: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False,
    )
    # When the current running segment started (initial Start or Resume).
    # NULL when the session is paused or ended.
    last_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )

    # Partial unique index: at most ONE not-yet-ended row per user. Blocks the
    # TOCTOU race in POST /stopwatch/start where two concurrent requests both
    # passed the "no active session" check and inserted, leaving the user with
    # two parallel running sessions that each awarded XP on End → today's
    # work-minutes were doubled.
    __table_args__ = (
        Index(
            "uq_stopwatch_one_active_per_user",
            "user_id",
            unique=True,
            sqlite_where=text("ended_at IS NULL"),
            postgresql_where=text("ended_at IS NULL"),
        ),
    )
