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

    notif_read_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)

    # User avatar — currently a fixed set of pixel-cat skins.
    cat_skin: Mapped[str] = mapped_column(String(20), default="tabby", nullable=False)
    # Set the first time the user explicitly picks a skin. Subsequent changes
    # are gated on accumulated study minutes (pomodoro + stopwatch) since
    # this ts. NULL = never explicitly picked yet → next change is free.
    cat_skin_changed_at: Mapped[datetime | None] = mapped_column(DateTime(), nullable=True)
    # Number of "free" skin changes that bypass the 30h study-time lock.
    # Existing users get 1 via migration so they always have one reset.
    cat_skin_free_changes: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    # Daily work-time goal in minutes (pomodoro + stopwatch combined).
    # Displayed as a progress meter under the XP card. Default 120 = 2h.
    daily_goal_minutes: Mapped[int] = mapped_column(Integer, default=120, nullable=False)

    # True once the user has explicitly agreed to send their reflection /
    # notes / session text to OpenAI for AI summary generation. The first
    # time they click a "Generate" button we show a disclosure modal that
    # flips this to True. Until then, AI routes refuse with 403.
    ai_opt_in: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # --- Zotero integration (per-user, optional) ----------------------------
    # `zotero_user_id` is the public numeric ID the user copies from their
    # Zotero profile URL (zotero.org/<username>; the integer is on Settings →
    # Feeds/API). `zotero_api_key_enc` is a Fernet-encrypted personal API
    # key — see app.core.crypto. Both NULL = not connected.
    zotero_user_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    zotero_api_key_enc: Mapped[str | None] = mapped_column(String(500), nullable=True)
