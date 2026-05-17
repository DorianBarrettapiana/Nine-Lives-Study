"""XP award logic shared across routes."""

from sqlalchemy.orm import Session

from app.models.user_progress import XP_PER_LEVEL, UserProgress

XP_TASK_COMPLETE = 10
XP_POMODORO_COMPLETE = 25
XP_DAILY_LOG_SAVE = 5
XP_FEYNMAN_CREATE = 15
XP_NOTE_CREATE = 10


def award_xp(user_id: int, amount: int, db: Session) -> UserProgress:
    """Add XP to a user, creating their progress row if needed. Returns updated progress."""
    progress = db.get(UserProgress, user_id)
    if progress is None:
        progress = UserProgress(user_id=user_id, xp=0, level=1)
        db.add(progress)

    progress.xp += amount
    progress.level = (progress.xp // XP_PER_LEVEL) + 1

    db.flush()
    return progress
