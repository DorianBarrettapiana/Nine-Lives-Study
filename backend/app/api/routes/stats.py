"""Stats aggregation routes."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.daily_tracker import DailyLog, DailyTask
from app.models.feynman_entry import FeynmanEntry
from app.models.paper_note import PaperNote
from app.models.pomodoro_session import PomodoroSession
from app.models.user import User
from app.schemas.stats import DailyMoodStat, DailyPomodoroStat, DailyTaskStat, UserStatsRead

router = APIRouter(tags=["stats"])


@router.get("/users/{user_id}/stats", response_model=UserStatsRead)
def get_user_stats(
    user_id: int,
    days: int = Query(default=7, ge=1, le=90),
    db: Session = Depends(get_db),
) -> UserStatsRead:
    """Return aggregated stats for a user over the last N days."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

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

    # Mood per day
    mood_rows = db.execute(
        select(DailyLog.log_date, DailyLog.mood)
        .where(DailyLog.user_id == user_id)
        .where(DailyLog.log_date >= since)
        .order_by(DailyLog.log_date)
    ).all()

    daily_moods = [
        DailyMoodStat(date=row.log_date, mood=row.mood)
        for row in mood_rows
        if row.mood
    ]

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

    return UserStatsRead(
        days=days,
        daily_tasks=daily_tasks,
        daily_moods=daily_moods,
        daily_pomodoros=daily_pomodoros,
        total_tasks_done=total_tasks_done,
        total_pomodoros=total_pomodoros,
        total_notes=total_notes,
        total_feynman=total_feynman,
    )
