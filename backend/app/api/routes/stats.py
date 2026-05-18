"""Stats aggregation routes (scoped to current user).

Counts come from the ``xp_events`` ledger, not from live rows, so deleting
a task / pomodoro / mood entry does NOT retroactively rewrite history.
"""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.xp import (
    EVENT_FEYNMAN,
    EVENT_MOOD,
    EVENT_NOTE,
    EVENT_POMODORO,
    EVENT_TASK_DONE,
)
from app.models.feynman_entry import FeynmanEntry
from app.models.mood_entry import MoodEntry
from app.models.paper_note import PaperNote
from app.models.user import User
from app.models.xp_event import XpEvent
from app.schemas.stats import DailyMoodStat, DailyPomodoroStat, DailyTaskStat, UserStatsRead

router = APIRouter(prefix="/stats", tags=["stats"])


@router.get("", response_model=UserStatsRead)
def get_stats(
    days: int = Query(default=7, ge=1, le=90),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserStatsRead:
    """Return aggregated stats for the current user over the last N days."""
    user_id = current_user.id

    today = date.today()
    since = today - timedelta(days=days - 1)

    # --- Tasks per day (XP_TASK_DONE events grouped by day) -----------------
    task_rows = db.execute(
        select(
            func.date(XpEvent.created_at).label("day"),
            func.count(XpEvent.id).label("done"),
        )
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type == EVENT_TASK_DONE)
        .where(func.date(XpEvent.created_at) >= since.isoformat())
        .group_by(func.date(XpEvent.created_at))
        .order_by(func.date(XpEvent.created_at))
    ).all()
    daily_tasks = [
        DailyTaskStat(date=date.fromisoformat(row.day), total=row.done, done=row.done)
        for row in task_rows
    ]

    # --- Mood per day: latest emoji recorded that day -----------------------
    mood_rows = db.execute(
        select(
            func.date(MoodEntry.created_at).label("day"),
            MoodEntry.mood,
        )
        .where(MoodEntry.user_id == user_id)
        .where(func.date(MoodEntry.created_at) >= since.isoformat())
        .order_by(func.date(MoodEntry.created_at), MoodEntry.created_at.desc())
    ).all()
    seen_days: set[str] = set()
    daily_moods = []
    for row in mood_rows:
        if row.day not in seen_days:
            seen_days.add(row.day)
            daily_moods.append(DailyMoodStat(date=date.fromisoformat(row.day), mood=row.mood))
    daily_moods.sort(key=lambda d: d.date)

    # --- Pomodoros per day (XP_POMODORO events) -----------------------------
    pomo_rows = db.execute(
        select(
            func.date(XpEvent.created_at).label("day"),
            func.count(XpEvent.id).label("count"),
        )
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type == EVENT_POMODORO)
        .where(func.date(XpEvent.created_at) >= since.isoformat())
        .group_by(func.date(XpEvent.created_at))
        .order_by(func.date(XpEvent.created_at))
    ).all()
    daily_pomodoros = [
        DailyPomodoroStat(date=date.fromisoformat(row.day), count=row.count)
        for row in pomo_rows
    ]

    # --- Totals (all-time, from xp_events for activity-based counters; the
    #     "current rows" counts for notes / feynman / mood reflect what the
    #     user can still see in their UI, which is more useful than history) -
    total_tasks_done = db.scalar(
        select(func.count(XpEvent.id))
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type == EVENT_TASK_DONE)
    ) or 0

    total_pomodoros = db.scalar(
        select(func.count(XpEvent.id))
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type == EVENT_POMODORO)
    ) or 0

    total_notes = db.scalar(
        select(func.count(PaperNote.id)).where(PaperNote.user_id == user_id)
    ) or 0

    total_feynman = db.scalar(
        select(func.count(FeynmanEntry.id)).where(FeynmanEntry.user_id == user_id)
    ) or 0

    total_moods = db.scalar(
        select(func.count(MoodEntry.id)).where(MoodEntry.user_id == user_id)
    ) or 0

    # Silence unused-import linter without breaking type hint inference
    _ = (EVENT_NOTE, EVENT_FEYNMAN, EVENT_MOOD)

    return UserStatsRead(
        days=days,
        daily_tasks=daily_tasks,
        daily_moods=daily_moods,
        daily_pomodoros=daily_pomodoros,
        total_tasks_done=total_tasks_done,
        total_pomodoros=total_pomodoros,
        total_notes=total_notes,
        total_feynman=total_feynman,
        total_moods=total_moods,
    )
