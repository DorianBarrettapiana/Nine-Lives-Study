"""User XP / level routes (scoped to current user)."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.streak import compute_streak
from app.core.xp import EVENT_POMODORO, EVENT_STOPWATCH
from app.models.daily_tracker import DailyLog, DailyTask
from app.models.mood_entry import MoodEntry
from app.models.user import User
from app.models.user_progress import UserProgress, level_from_xp
from app.models.xp_event import XpEvent
from app.schemas.user_progress import UserProgressRead

router = APIRouter(prefix="/xp", tags=["xp"])


def _local_midnight_utc(tz_offset_minutes: int) -> datetime:
    tz_delta = timedelta(minutes=tz_offset_minutes)
    local_now = datetime.now(timezone.utc) + tz_delta
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    return local_midnight - tz_delta


@router.get("", response_model=UserProgressRead)
def get_xp(
    tz_offset: int = Query(default=0, ge=-720, le=840),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserProgressRead:
    """Return XP, level, progress, streak, and today's work minutes.

    `tz_offset` controls both the streak day boundary and today's work-time
    window (so users near midnight see the right values).
    """
    progress = db.get(UserProgress, current_user.id)
    if progress is None:
        progress = UserProgress(user_id=current_user.id, xp=0, level=1)
        db.add(progress)
        db.commit()
        db.refresh(progress)

    # Progressive levels: level N needs N*100 XP. Recompute on every read
    # so users created under the old (flat) rule self-heal to the new level
    # without a separate migration.
    level, xp_in_level, xp_to_next = level_from_xp(progress.xp)
    if progress.level != level:
        progress.level = level
        db.commit()

    streak_days, active_today = compute_streak(current_user.id, tz_offset, db)

    # Today's work minutes = sum(amount) of pomodoro_done + stopwatch_done
    # events since local midnight. Amount IS minutes under the current XP rule.
    today_start = _local_midnight_utc(tz_offset)
    today_minutes = db.scalar(
        select(func.coalesce(func.sum(XpEvent.amount), 0))
        .where(XpEvent.user_id == current_user.id)
        .where(XpEvent.event_type.in_([EVENT_POMODORO, EVENT_STOPWATCH]))
        .where(XpEvent.created_at >= today_start)
    ) or 0

    # --- Perfect day --------------------------------------------------------
    # All four conditions must hold:
    #   1. At least 1 daily task TODAY, and zero undone.
    #   2. A mood entry today.
    #   3. A reflection (non-empty text) today.
    #   4. At least 1 completed work session today (today_minutes > 0).
    today_local_date = (datetime.now(timezone.utc) + timedelta(minutes=tz_offset)).date()

    # Tasks: DailyTask has an explicit task_date — query directly.
    task_rows = db.execute(
        select(DailyTask.is_done)
        .where(DailyTask.user_id == current_user.id)
        .where(DailyTask.task_date == today_local_date)
    ).all()
    total_today = len(task_rows)
    undone_today = sum(1 for (is_done,) in task_rows if not is_done)
    tasks_complete_today = total_today > 0 and undone_today == 0

    # Daily log for today by log_date (the table uses a literal date, not a tz).
    log_today = db.scalar(
        select(DailyLog)
        .where(DailyLog.user_id == current_user.id)
        .where(DailyLog.log_date == today_local_date)
    )
    has_reflection_today = bool(log_today and log_today.reflection and log_today.reflection.strip())

    # Mood: any MoodEntry today (by created_at local date).
    mood_today = False
    mood_rows = db.scalars(
        select(MoodEntry.created_at)
        .where(MoodEntry.user_id == current_user.id)
    ).all()
    for ts in mood_rows:
        if ts is None:
            continue
        ts_aware = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        if (ts_aware + timedelta(minutes=tz_offset)).date() == today_local_date:
            mood_today = True
            break

    is_today_perfect = (
        tasks_complete_today
        and has_reflection_today
        and mood_today
        and today_minutes > 0
    )

    return UserProgressRead(
        user_id=progress.user_id,
        xp=progress.xp,
        level=level,
        xp_in_level=xp_in_level,
        xp_to_next_level=xp_to_next,
        streak_days=streak_days,
        streak_active_today=active_today,
        today_work_minutes=int(today_minutes),
        today_work_minutes_goal=current_user.daily_goal_minutes,
        is_today_perfect=is_today_perfect,
    )
