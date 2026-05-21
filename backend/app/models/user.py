"""User ORM model."""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class User(Base):
    """Represent an application user."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    language: Mapped[str] = mapped_column(String(10), default="en", nullable=False)
    theme: Mapped[str] = mapped_column(String(20), default="dark", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Pomodoro settings (per user, persisted across devices).
    pomodoro_work_minutes: Mapped[int] = mapped_column(Integer, default=25, nullable=False)
    pomodoro_short_break_minutes: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    pomodoro_long_break_minutes: Mapped[int] = mapped_column(Integer, default=15, nullable=False)
    pomodoro_sessions_before_long_break: Mapped[int] = mapped_column(Integer, default=4, nullable=False)

    notif_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # User avatar — currently a fixed set of pixel-cat skins.
    cat_skin: Mapped[str] = mapped_column(String(20), default="tabby", nullable=False)
    # Set the first time the user explicitly picks a skin. Subsequent changes
    # are gated on accumulated study minutes (pomodoro + stopwatch) since
    # this ts. NULL = never explicitly picked yet → next change is free.
    cat_skin_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Number of "free" skin changes that bypass the 30h study-time lock.
    # Existing users get 1 via migration so they always have one reset.
    cat_skin_free_changes: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    # Daily work-time goal in minutes (pomodoro + stopwatch combined).
    # Displayed as a progress meter under the XP card. Default 120 = 2h.
    daily_goal_minutes: Mapped[int] = mapped_column(Integer, default=120, nullable=False)
