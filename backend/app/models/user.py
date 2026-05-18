"""User ORM model."""

from sqlalchemy import Boolean, Integer, String
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
