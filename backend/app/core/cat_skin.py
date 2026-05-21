"""Lock logic for user cat-skin changes.

Once a user explicitly picks a skin, they must accumulate
``CAT_SKIN_REQUIRED_MINUTES`` of *study time* (pomodoro work + stopwatch)
before they can change again. The first explicit pick (when
``cat_skin_changed_at`` is still NULL) is always free.

Study time is read from the xp_events ledger so the two contributions
(EVENT_POMODORO + EVENT_STOPWATCH) sum cleanly into one minutes total —
under the current XP rule (1 min = 1 XP) `amount` IS minutes.
"""

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.xp import EVENT_POMODORO, EVENT_STOPWATCH
from app.models.user import User
from app.models.xp_event import XpEvent
from app.schemas.user import UserRead

# 30 hours of study time between changes.
CAT_SKIN_REQUIRED_MINUTES = 1800


def accumulated_work_minutes_since(user_id: int, since: datetime | None, db: Session) -> int:
    """Sum study minutes (pomodoro_done + stopwatch_done) since `since`.

    Under the current XP rule, xp_events.amount equals the minutes worked
    for those event types, so one summation across both covers all study
    time. `since=None` means all-time.
    """
    stmt = (
        select(func.coalesce(func.sum(XpEvent.amount), 0))
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type.in_([EVENT_POMODORO, EVENT_STOPWATCH]))
    )
    if since is not None:
        stmt = stmt.where(XpEvent.created_at >= since)
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
            changed_at = changed_at.replace(tzinfo=timezone.utc)
        accumulated = accumulated_work_minutes_since(user.id, changed_at, db)

    data = UserRead.model_validate(user).model_dump()
    data["cat_skin_minutes_accumulated"] = accumulated
    data["cat_skin_minutes_required"] = CAT_SKIN_REQUIRED_MINUTES
    return UserRead.model_validate(data)


def can_change_cat_skin(user: User, db: Session) -> tuple[bool, int, bool]:
    """Return (allowed, accumulated_minutes_since_last_change, used_free).

    `used_free` indicates whether this change is being granted via a free-
    change coupon (instead of clearing the study-time requirement).
    Callers should decrement `user.cat_skin_free_changes` on a successful
    change when `used_free` is True.
    """
    # Free coupon always wins, even if user has never picked before.
    if user.cat_skin_free_changes > 0:
        return True, 0, True

    if user.cat_skin_changed_at is None:
        return True, CAT_SKIN_REQUIRED_MINUTES, False
    changed_at = user.cat_skin_changed_at
    if changed_at.tzinfo is None:
        changed_at = changed_at.replace(tzinfo=timezone.utc)
    accumulated = accumulated_work_minutes_since(user.id, changed_at, db)
    return accumulated >= CAT_SKIN_REQUIRED_MINUTES, accumulated, False
