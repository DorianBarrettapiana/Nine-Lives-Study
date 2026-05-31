"""Daily tracker ORM models."""

from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def utc_now() -> datetime:
    """Return the current UTC datetime."""
    return datetime.now(timezone.utc)


class DailyTask(Base):
    """Represent a task planned for a specific day."""

    __tablename__ = "daily_tasks"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    task_date: Mapped[date] = mapped_column(Date, index=True, nullable=False)
    # New scheduling fields (PR1 of the Today/Daily-tracker unification):
    # `planned_date` is "the day the user intends to work on this". For
    # legacy rows it's backfilled to equal task_date; for new rows the
    # route layer dual-writes both columns so the UI can switch over to
    # planned_date in a follow-up PR without breaking historical data.
    # `due_date` is the hard deadline (nullable — most tasks don't have one).
    planned_date: Mapped[date | None] = mapped_column(Date, index=True, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, index=True, nullable=True)
    text: Mapped[str] = mapped_column(String(500), nullable=False)
    is_done: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # User-controlled ordering within a day. Lower sorts first; ties break
    # by `created_at`. Float so the frontend can insert "between neighbors"
    # via the midpoint trick (e.g. 1.0 / 2.0 → drop between → 1.5).
    # Defaults to 0 so legacy rows stay in their original creation order
    # until the user reorders them.
    sort_order: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    # Optional research-thread bucket. NULL = unassigned. ON DELETE SET
    # NULL is enforced application-side (the /projects DELETE route nulls
    # this column before removing the project) since SQLite's FK enforcement
    # isn't enabled on this connection.
    project_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(),
        default=utc_now,
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(),
        default=utc_now,
        onupdate=utc_now,
        nullable=False,
    )


class DailyLog(Base):
    """Represent a daily mood and reflection log."""

    __tablename__ = "daily_logs"

    __table_args__ = (
        UniqueConstraint("user_id", "log_date", name="uq_daily_logs_user_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    log_date: Mapped[date] = mapped_column(Date, index=True, nullable=False)
    main_goal: Mapped[str] = mapped_column(String(500), default="", server_default="", nullable=False)
    # Preferred way to pin "today's most important thing": a reference to a
    # daily task rather than a free-text string. The free-text `main_goal`
    # column stays for backward compatibility but the UI will move to this.
    # Validated against the user's own tasks on write.
    main_goal_task_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    # `mood` is deprecated as a per-day storage location. Mood is being
    # consolidated into the mood_entries table (one stream, multiple per
    # day). The column stays so legacy reads + the dual-write transition
    # don't break, but new UI should target /mood instead of /daily/log.
    mood: Mapped[str] = mapped_column(String(20), default="", nullable=False)
    reflection: Mapped[str] = mapped_column(Text, default="", nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(),
        default=utc_now,
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(),
        default=utc_now,
        onupdate=utc_now,
        nullable=False,
    )
