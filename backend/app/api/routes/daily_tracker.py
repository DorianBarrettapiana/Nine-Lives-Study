"""Daily tracker routes (scoped to current user)."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.xp import (
    ENTITY_DAILY_LOG,
    ENTITY_DAILY_TASK,
    EVENT_DAILY_LOG,
    EVENT_TASK_DONE,
    XP_DAILY_LOG_SAVE,
    XP_TASK_COMPLETE,
    award_xp_event,
)
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

router = APIRouter(prefix="/daily", tags=["daily-tracker"])


def resolve_target_date(value: date | None) -> date:
    return value or date.today()


def compute_completion_percent(done_count: int, total_count: int) -> int:
    if total_count == 0:
        return 0
    return round(done_count / total_count * 100)


def _get_owned_task(task_id: int, current_user: User, db: Session) -> DailyTask:
    task = db.get(DailyTask, task_id)
    if task is None or task.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Daily task not found.")
    return task


@router.get("", response_model=DailyStateRead)
def get_daily_state(
    target_date: date | None = Query(default=None, alias="date"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DailyStateRead:
    """Return tasks and daily log for the current user at a given date."""
    day = resolve_target_date(target_date)

    tasks_statement = (
        select(DailyTask)
        .where(DailyTask.user_id == current_user.id)
        .where(DailyTask.task_date == day)
        # Manual sort_order first (drag-reorder), creation time as tie-breaker.
        .order_by(DailyTask.sort_order.asc(), DailyTask.created_at.asc())
    )
    tasks = list(db.scalars(tasks_statement).all())

    log_statement = (
        select(DailyLog)
        .where(DailyLog.user_id == current_user.id)
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


@router.post("/tasks", response_model=DailyTaskRead, status_code=201)
def create_daily_task(
    payload: DailyTaskCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DailyTask:
    day = resolve_target_date(payload.task_date)
    # New tasks land at the bottom of the day's list. Compute as
    # (current max sort_order for the day) + 1, defaulting to 1.0 for the
    # very first task.
    max_so = db.scalar(
        select(DailyTask.sort_order)
        .where(DailyTask.user_id == current_user.id)
        .where(DailyTask.task_date == day)
        .order_by(DailyTask.sort_order.desc())
        .limit(1)
    )
    next_so = (max_so or 0.0) + 1.0
    task = DailyTask(
        user_id=current_user.id,
        task_date=day,
        text=payload.text,
        is_done=False,
        sort_order=next_so,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.patch("/tasks/{task_id}", response_model=DailyTaskRead)
def update_daily_task(
    task_id: int,
    payload: DailyTaskUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DailyTask:
    task = _get_owned_task(task_id, current_user, db)
    was_done = task.is_done

    data = payload.model_dump(exclude_unset=True)
    for field_name, field_value in data.items():
        setattr(task, field_name, field_value)

    # Award XP only on the not-done → done transition. award_xp_event is
    # idempotent on (event_type, entity_id), so even if this transition
    # happens multiple times (toggle / untoggle / re-toggle) we only credit
    # XP once for this task's lifetime.
    if not was_done and task.is_done:
        award_xp_event(
            user_id=task.user_id,
            event_type=EVENT_TASK_DONE,
            entity_type=ENTITY_DAILY_TASK,
            entity_id=task.id,
            amount=XP_TASK_COMPLETE,
            db=db,
        )

    db.commit()
    db.refresh(task)
    return task


@router.delete("/tasks/{task_id}", status_code=204)
def delete_daily_task(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    task = _get_owned_task(task_id, current_user, db)
    db.delete(task)
    db.commit()


@router.post("/tasks/{task_id}/carry-forward", response_model=DailyTaskRead, status_code=201)
def carry_daily_task_forward(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DailyTask:
    """Copy an unfinished task to the following day, without duplicates."""
    task = _get_owned_task(task_id, current_user, db)
    if task.is_done:
        raise HTTPException(status_code=400, detail="Completed tasks do not need to be carried forward.")
    target_date = task.task_date + timedelta(days=1)
    existing = db.scalar(
        select(DailyTask)
        .where(DailyTask.user_id == current_user.id)
        .where(DailyTask.task_date == target_date)
        .where(DailyTask.text == task.text)
    )
    if existing is not None:
        return existing

    max_so = db.scalar(
        select(DailyTask.sort_order)
        .where(DailyTask.user_id == current_user.id)
        .where(DailyTask.task_date == target_date)
        .order_by(DailyTask.sort_order.desc())
        .limit(1)
    )
    copied = DailyTask(
        user_id=current_user.id,
        task_date=target_date,
        text=task.text,
        is_done=False,
        sort_order=(max_so or 0.0) + 1.0,
    )
    db.add(copied)
    db.commit()
    db.refresh(copied)
    return copied


@router.put("/log", response_model=DailyLogRead)
def upsert_daily_log(
    payload: DailyLogUpsert,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DailyLog:
    day = resolve_target_date(payload.log_date)

    statement = (
        select(DailyLog)
        .where(DailyLog.user_id == current_user.id)
        .where(DailyLog.log_date == day)
    )
    log = db.scalar(statement)

    if log is None:
        log = DailyLog(
            user_id=current_user.id,
            log_date=day,
            main_goal=payload.main_goal or "",
            mood=payload.mood,
            reflection=payload.reflection,
        )
        db.add(log)
    else:
        if payload.main_goal is not None:
            log.main_goal = payload.main_goal
        log.mood = payload.mood
        log.reflection = payload.reflection

    db.flush()  # populate log.id

    # Idempotent on (event_type, entity_id=log.id), so the user can re-save
    # their daily log to update mood/reflection without farming XP.
    award_xp_event(
        user_id=current_user.id,
        event_type=EVENT_DAILY_LOG,
        entity_type=ENTITY_DAILY_LOG,
        entity_id=log.id,
        amount=XP_DAILY_LOG_SAVE,
        db=db,
    )

    db.commit()
    db.refresh(log)
    return log
