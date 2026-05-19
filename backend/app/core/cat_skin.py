"""Lock logic for user cat-skin changes.

Once a user explicitly picks a skin, they must accumulate
``CAT_SKIN_REQUIRED_MINUTES`` of completed pomodoro work time before they
can change again. The first explicit pick (when ``cat_skin_changed_at``
is still NULL) is always free.
"""

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.pomodoro_session import PomodoroSession
from app.models.user import User
from app.schemas.user import UserRead

# 30 hours of pomodoro work between changes.
CAT_SKIN_REQUIRED_MINUTES = 1800


def accumulated_pomodoro_minutes_since(user_id: int, since: datetime | None, db: Session) -> int:
    """Sum completed-work pomodoro durations since `since` (or all-time if None)."""
    stmt = (
        select(func.coalesce(func.sum(PomodoroSession.duration_minutes), 0))
        .where(PomodoroSession.user_id == user_id)
        .where(PomodoroSession.is_completed.is_(True))
        .where(PomodoroSession.session_type == "work")
    )
    if since is not None:
        stmt = stmt.where(PomodoroSession.started_at >= since)
    return int(db.scalar(stmt) or 0)


def user_read_with_skin_status(user: User, db: Session) -> UserRead:
    """Serialize a User to UserRead, filling in the cat-skin lock fields."""
    if user.cat_skin_changed_at is None:
        # First explicit pick is free; report accumulated = required so the
        # frontend treats it as "unlocked".
        accumulated = CAT_SKIN_REQUIRED_MINUTES
    else:
        changed_at = user.cat_skin_changed_at
        if changed_at.tzinfo is None:
            # SQLite drops tz info on round-trip; treat as UTC.
            changed_at = changed_at.replace(tzinfo=timezone.utc)
        accumulated = accumulated_pomodoro_minutes_since(user.id, changed_at, db)

    data = UserRead.model_validate(user).model_dump()
    data["cat_skin_minutes_accumulated"] = accumulated
    data["cat_skin_minutes_required"] = CAT_SKIN_REQUIRED_MINUTES
    return UserRead.model_validate(data)


def can_change_cat_skin(user: User, db: Session) -> tuple[bool, int]:
    """Return (allowed, accumulated_minutes_since_last_change)."""
    if user.cat_skin_changed_at is None:
        return True, CAT_SKIN_REQUIRED_MINUTES
    changed_at = user.cat_skin_changed_at
    if changed_at.tzinfo is None:
        changed_at = changed_at.replace(tzinfo=timezone.utc)
    accumulated = accumulated_pomodoro_minutes_since(user.id, changed_at, db)
    return accumulated >= CAT_SKIN_REQUIRED_MINUTES, accumulated
