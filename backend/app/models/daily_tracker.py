"""Daily tracker ORM models."""

from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, String, Text, UniqueConstraint
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
    text: Mapped[str] = mapped_column(String(500), nullable=False)
    is_done: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # User-controlled ordering within a day. Lower sorts first; ties break
    # by `created_at`. Float so the frontend can insert "between neighbors"
    # via the midpoint trick (e.g. 1.0 / 2.0 → drop between → 1.5).
    # Defaults to 0 so legacy rows stay in their original creation order
    # until the user reorders them.
    sort_order: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

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
