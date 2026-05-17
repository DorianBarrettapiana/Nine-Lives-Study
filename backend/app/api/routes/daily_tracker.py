"""Daily tracker routes."""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.xp import XP_DAILY_LOG_SAVE, XP_TASK_COMPLETE, award_xp
from app.models.daily_tracker import DailyLog, DailyTask
from app.models.user import User
from app.schemas.daily_tracker import (
    DailyLogRead,
    DailyLogUpsert,
    DailyStateRead,
    DailyTaskCreate,
    DailyTaskRead,
    DailyTaskUpdate,
)

router = APIRouter(tags=["daily-tracker"])


def resolve_target_date(value: date | None) -> date:
    """Return the requested date or today's local server date."""
    return value or date.today()


def ensure_user_exists(user_id: int, db: Session) -> User:
    """Return a user or raise a 404 error."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    return user


def compute_completion_percent(done_count: int, total_count: int) -> int:
    """Compute a rounded task completion percentage."""
    if total_count == 0:
        return 0
    return round(done_count / total_count * 100)


@router.get("/users/{user_id}/daily", response_model=DailyStateRead)
def get_daily_state(
    user_id: int,
    target_date: date | None = Query(default=None, alias="date"),
    db: Session = Depends(get_db),
) -> DailyStateRead:
    """Return tasks and daily log for a user at a given date."""
    ensure_user_exists(user_id, db)
    day = resolve_target_date(target_date)

    tasks_statement = (
        select(DailyTask)
        .where(DailyTask.user_id == user_id)
        .where(DailyTask.task_date == day)
        .order_by(DailyTask.created_at.asc())
    )
    tasks = list(db.scalars(tasks_statement).all())

    log_statement = (
        select(DailyLog)
        .where(DailyLog.user_id == user_id)
        .where(DailyLog.log_date == day)
    )
    log = db.scalar(log_statement)

    done_count = sum(1 for task in tasks if task.is_done)
    total_count = len(tasks)

    return DailyStateRead(
        date=day,
        tasks=tasks,
        log=log,
        done_count=done_count,
        total_count=total_count,
        completion_percent=compute_completion_percent(done_count, total_count),
    )


@router.post("/users/{user_id}/daily/tasks", response_model=DailyTaskRead, status_code=201)
def create_daily_task(
    user_id: int,
    payload: DailyTaskCreate,
    db: Session = Depends(get_db),
) -> DailyTask:
    """Create a daily task for a user."""
    ensure_user_exists(user_id, db)

    task = DailyTask(
        user_id=user_id,
        task_date=resolve_target_date(payload.task_date),
        text=payload.text,
        is_done=False,
    )

    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.patch("/daily/tasks/{task_id}", response_model=DailyTaskRead)
def update_daily_task(
    task_id: int,
    payload: DailyTaskUpdate,
    db: Session = Depends(get_db),
) -> DailyTask:
    """Update a daily task."""
    task = db.get(DailyTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Daily task not found.")

    was_done = task.is_done
    update_data = payload.model_dump(exclude_unset=True)

    for field_name, field_value in update_data.items():
        setattr(task, field_name, field_value)

    if not was_done and task.is_done:
        award_xp(task.user_id, XP_TASK_COMPLETE, db)

    db.commit()
    db.refresh(task)
    return task


@router.delete("/daily/tasks/{task_id}", status_code=204)
def delete_daily_task(
    task_id: int,
    db: Session = Depends(get_db),
) -> None:
    """Delete a daily task."""
    task = db.get(DailyTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Daily task not found.")

    db.delete(task)
    db.commit()


@router.put("/users/{user_id}/daily/log", response_model=DailyLogRead)
def upsert_daily_log(
    user_id: int,
    payload: DailyLogUpsert,
    db: Session = Depends(get_db),
) -> DailyLog:
    """Create or update a daily log for a user."""
    ensure_user_exists(user_id, db)

    day = resolve_target_date(payload.log_date)

    statement = (
        select(DailyLog)
        .where(DailyLog.user_id == user_id)
        .where(DailyLog.log_date == day)
    )
    log = db.scalar(statement)

    if log is None:
        log = DailyLog(
            user_id=user_id,
            log_date=day,
            mood=payload.mood,
            reflection=payload.reflection,
        )
        db.add(log)
    else:
        log.mood = payload.mood
        log.reflection = payload.reflection

    award_xp(user_id, XP_DAILY_LOG_SAVE, db)
    db.commit()
    db.refresh(log)
    return log