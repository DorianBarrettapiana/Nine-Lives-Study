"""Daily tracker routes (scoped to current user)."""

from datetime import date

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
        .order_by(DailyTask.created_at.asc())
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
    task = DailyTask(
        user_id=current_user.id,
        task_date=resolve_target_date(payload.task_date),
        text=payload.text,
        is_done=False,
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
            mood=payload.mood,
            reflection=payload.reflection,
        )
        db.add(log)
    else:
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
