"""Stats aggregation routes (scoped to current user)."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.daily_tracker import DailyTask
from app.models.feynman_entry import FeynmanEntry
from app.models.mood_entry import MoodEntry
from app.models.paper_note import PaperNote
from app.models.pomodoro_session import PomodoroSession
from app.models.user import User
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

    # Tasks per day
    task_rows = db.execute(
        select(
            DailyTask.task_date,
            func.count(DailyTask.id).label("total"),
            func.sum(DailyTask.is_done).label("done"),
        )
        .where(DailyTask.user_id == user_id)
        .where(DailyTask.task_date >= since)
        .group_by(DailyTask.task_date)
        .order_by(DailyTask.task_date)
    ).all()

    daily_tasks = [
        DailyTaskStat(date=row.task_date, total=row.total, done=row.done or 0)
        for row in task_rows
    ]

    # Mood per day — one entry per day (most recent), from mood_entries
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

    # Pomodoros per day
    pomodoro_rows = db.execute(
        select(
            func.date(PomodoroSession.started_at).label("day"),
            func.count(PomodoroSession.id).label("count"),
        )
        .where(PomodoroSession.user_id == user_id)
        .where(PomodoroSession.is_completed == True)  # noqa: E712
        .where(PomodoroSession.session_type == "work")
        .where(func.date(PomodoroSession.started_at) >= since.isoformat())
        .group_by(func.date(PomodoroSession.started_at))
        .order_by(func.date(PomodoroSession.started_at))
    ).all()

    daily_pomodoros = [
        DailyPomodoroStat(date=date.fromisoformat(row.day), count=row.count)
        for row in pomodoro_rows
    ]

    # Totals
    total_tasks_done = db.scalar(
        select(func.count(DailyTask.id))
        .where(DailyTask.user_id == user_id)
        .where(DailyTask.is_done == True)  # noqa: E712
    ) or 0

    total_pomodoros = db.scalar(
        select(func.count(PomodoroSession.id))
        .where(PomodoroSession.user_id == user_id)
        .where(PomodoroSession.is_completed == True)  # noqa: E712
        .where(PomodoroSession.session_type == "work")
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
