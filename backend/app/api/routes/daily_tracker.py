"""Daily tracker routes (scoped to current user)."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.mood import record_mood_entry
from app.core.tags import (
    delete_links_for_item,
    fetch_tags_for_items,
    parse_tag_input,
    replace_item_tags,
)
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
from app.models.paper_note import PaperNote
from app.models.project import Project
from app.models.tag import TAG_ITEM_DAILY_TASK
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


def _validate_project_id(project_id: int | None, current_user: User, db: Session) -> None:
    """Reject project_id values that don't belong to the current user.

    NULL is always allowed (it means "unassigned"). Anything else must be a
    Project row owned by the same user, otherwise we 400 to surface the
    UI bug rather than silently writing a cross-user FK that won't render.
    """
    if project_id is None:
        return
    project = db.get(Project, project_id)
    if project is None or project.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unknown project.",
        )


def _validate_parent_task_id(
    parent_task_id: int | None,
    current_user: User,
    db: Session,
    *,
    forbid_self: int | None = None,
) -> DailyTask | None:
    """Return an owned top-level parent, rejecting deeper task trees."""
    if parent_task_id is None:
        return None
    if forbid_self == parent_task_id:
        raise HTTPException(status_code=400, detail="A task cannot be its own parent.")
    parent = db.get(DailyTask, parent_task_id)
    if parent is None or parent.user_id != current_user.id:
        raise HTTPException(status_code=400, detail="Unknown parent task.")
    if parent.parent_task_id is not None:
        raise HTTPException(status_code=400, detail="Tasks can only have one level of subtasks.")
    return parent


def _serialize_tasks_with_tags(
    tasks: list[DailyTask], current_user: User, db: Session,
) -> list[DailyTaskRead]:
    """Build DailyTaskRead instances with tag_list populated in one query."""
    tag_map = fetch_tags_for_items(
        current_user.id, TAG_ITEM_DAILY_TASK, [t.id for t in tasks], db,
    )
    reads: list[DailyTaskRead] = []
    for task in tasks:
        read = DailyTaskRead.model_validate(task)
        read.tag_list = tag_map.get(task.id, [])
        reads.append(read)
    return reads


def _validate_paper_note_link(note_id: int | None, current_user: User, db: Session) -> None:
    if note_id is None:
        return
    note = db.get(PaperNote, note_id)
    if note is None or note.user_id != current_user.id:
        raise HTTPException(status_code=400, detail="Linked paper note not found.")


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
        tasks=_serialize_tasks_with_tags(tasks, current_user, db),
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
) -> DailyTaskRead:
    # Dual-write date semantics: the canonical "when do I work on this"
    # is `planned_date`. Old clients still send `task_date`; new clients
    # can send either / both. Resolution order:
    #   explicit planned_date  >  explicit task_date  >  today
    # Both columns are written so legacy queries keep functioning.
    parent = _validate_parent_task_id(payload.parent_task_id, current_user, db)
    day = parent.task_date if parent is not None else payload.planned_date or resolve_target_date(payload.task_date)
    _validate_paper_note_link(payload.paper_note_id, current_user, db)
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
    project_id = parent.project_id if parent is not None else payload.project_id
    _validate_project_id(project_id, current_user, db)
    task = DailyTask(
        user_id=current_user.id,
        task_date=day,
        planned_date=day,
        due_date=payload.due_date,
        text=payload.text,
        is_done=False,
        sort_order=next_so,
        project_id=project_id,
        paper_note_id=payload.paper_note_id,
        parent_task_id=parent.id if parent is not None else None,
    )
    db.add(task)
    db.flush()
    if payload.tag_names is not None:
        replace_item_tags(
            current_user.id, TAG_ITEM_DAILY_TASK, task.id,
            parse_tag_input(payload.tag_names), db,
        )
    db.commit()
    db.refresh(task)
    return _serialize_tasks_with_tags([task], current_user, db)[0]


@router.patch("/tasks/{task_id}", response_model=DailyTaskRead)
def update_daily_task(
    task_id: int,
    payload: DailyTaskUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DailyTaskRead:
    task = _get_owned_task(task_id, current_user, db)
    was_done = task.is_done

    data = payload.model_dump(exclude_unset=True)
    if "parent_task_id" in data:
        parent = _validate_parent_task_id(
            data["parent_task_id"], current_user, db, forbid_self=task.id,
        )
        if parent is not None:
            has_children = db.scalar(
                select(DailyTask.id)
                .where(DailyTask.user_id == current_user.id)
                .where(DailyTask.parent_task_id == task.id)
                .limit(1)
            )
            if has_children is not None:
                raise HTTPException(status_code=400, detail="A task with subtasks cannot become a subtask.")
            data["project_id"] = parent.project_id
            data["planned_date"] = parent.planned_date
            data["task_date"] = parent.task_date
    if "project_id" in data:
        _validate_project_id(data["project_id"], current_user, db)
        if task.parent_task_id is not None and "parent_task_id" not in data:
            parent = _get_owned_task(task.parent_task_id, current_user, db)
            if data["project_id"] != parent.project_id:
                raise HTTPException(status_code=400, detail="A subtask inherits its parent's project.")
    if task.parent_task_id is not None and "planned_date" in data and "parent_task_id" not in data:
        parent = _get_owned_task(task.parent_task_id, current_user, db)
        if data["planned_date"] != parent.planned_date:
            raise HTTPException(status_code=400, detail="A subtask inherits its parent's planned date.")
    # Keep the legacy `task_date` in sync when the client sets `planned_date`.
    # If the client explicitly sends both (rare), planned_date wins because
    # it's the canonical column going forward.
    if "planned_date" in data and data["planned_date"] is not None:
        data["task_date"] = data["planned_date"]

    has_tag_field = "tag_names" in data
    tag_payload = data.pop("tag_names", None)
    for field_name, field_value in data.items():
        setattr(task, field_name, field_value)
    if task.parent_task_id is None:
        if "project_id" in data:
            db.query(DailyTask).filter(
                DailyTask.user_id == current_user.id,
                DailyTask.parent_task_id == task.id,
            ).update({DailyTask.project_id: task.project_id}, synchronize_session=False)
        if "planned_date" in data:
            db.query(DailyTask).filter(
                DailyTask.user_id == current_user.id,
                DailyTask.parent_task_id == task.id,
            ).update(
                {DailyTask.task_date: task.task_date, DailyTask.planned_date: task.planned_date},
                synchronize_session=False,
            )
    if has_tag_field:
        replace_item_tags(
            current_user.id, TAG_ITEM_DAILY_TASK, task.id,
            parse_tag_input(tag_payload) if tag_payload is not None else [],
            db,
        )

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
    return _serialize_tasks_with_tags([task], current_user, db)[0]


@router.delete("/tasks/{task_id}", status_code=204)
def delete_daily_task(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    task = _get_owned_task(task_id, current_user, db)
    children = list(db.scalars(
        select(DailyTask)
        .where(DailyTask.user_id == current_user.id)
        .where(DailyTask.parent_task_id == task.id)
    ).all())
    for child in children:
        delete_links_for_item(TAG_ITEM_DAILY_TASK, child.id, db)
        db.delete(child)
    delete_links_for_item(TAG_ITEM_DAILY_TASK, task.id, db)
    db.delete(task)
    db.commit()


@router.get("/tasks/upcoming", response_model=list[DailyTaskRead])
def list_upcoming_tasks(
    horizon_days: int = 14,
    include_overdue: bool = True,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[DailyTaskRead]:
    """Tasks with a due_date inside [today, today+horizon_days], not done.

    Sorted by due_date ascending so the most pressing item is first.
    `include_overdue=True` extends the lower bound back to the dawn of time
    so the user is reminded of items that have already slipped (which is
    arguably more useful than a strictly-future "Upcoming"). Defaults to
    a 2-week horizon — long enough for typical PhD planning, short enough
    that the list stays scannable.
    """
    horizon = max(1, min(60, horizon_days))
    today = date.today()
    stmt = (
        select(DailyTask)
        .where(DailyTask.user_id == current_user.id)
        .where(DailyTask.is_done == False)  # noqa: E712
        .where(DailyTask.due_date.is_not(None))
        .where(DailyTask.due_date <= today + timedelta(days=horizon))
        .order_by(DailyTask.due_date.asc(), DailyTask.created_at.asc())
    )
    if not include_overdue:
        stmt = stmt.where(DailyTask.due_date >= today)
    return _serialize_tasks_with_tags(list(db.scalars(stmt).all()), current_user, db)


@router.post("/tasks/{task_id}/carry-forward", response_model=DailyTaskRead, status_code=201)
def carry_daily_task_forward(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DailyTaskRead:
    """Copy an unfinished task to the following day, without duplicates."""
    task = _get_owned_task(task_id, current_user, db)
    if task.is_done:
        raise HTTPException(status_code=400, detail="Completed tasks do not need to be carried forward.")
    target_date = task.task_date + timedelta(days=1)
    if task.parent_task_id is not None:
        parent = _get_owned_task(task.parent_task_id, current_user, db)
        copied_parent = _copy_task_to_date(parent, target_date, current_user, db)
        copied = _copy_task_to_date(task, target_date, current_user, db, parent_task_id=copied_parent.id)
    else:
        copied = _copy_task_to_date(task, target_date, current_user, db)
        children = db.scalars(
            select(DailyTask)
            .where(DailyTask.user_id == current_user.id)
            .where(DailyTask.parent_task_id == task.id)
            .where(DailyTask.is_done.is_(False))
            .order_by(DailyTask.sort_order.asc(), DailyTask.created_at.asc())
        ).all()
        for child in children:
            _copy_task_to_date(child, target_date, current_user, db, parent_task_id=copied.id)
    db.commit()
    db.refresh(copied)
    return _serialize_tasks_with_tags([copied], current_user, db)[0]


def _copy_task_to_date(
    task: DailyTask,
    target_date: date,
    current_user: User,
    db: Session,
    *,
    parent_task_id: int | None = None,
) -> DailyTask:
    """Copy one task once, preserving tags and an optional copied parent."""
    existing = db.scalar(
        select(DailyTask)
        .where(DailyTask.user_id == current_user.id)
        .where(DailyTask.task_date == target_date)
        .where(DailyTask.text == task.text)
        .where(DailyTask.parent_task_id == parent_task_id)
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
        planned_date=target_date,
        due_date=task.due_date,
        text=task.text,
        is_done=False,
        sort_order=(max_so or 0.0) + 1.0,
        project_id=task.project_id,
        paper_note_id=task.paper_note_id,
        parent_task_id=parent_task_id,
    )
    db.add(copied)
    db.flush()
    # Carry the tags along too — same conceptual task moving forward.
    src_tag_map = fetch_tags_for_items(
        current_user.id, TAG_ITEM_DAILY_TASK, [task.id], db,
    )
    src_names = [t.name for t in src_tag_map.get(task.id, [])]
    if src_names:
        replace_item_tags(
            current_user.id, TAG_ITEM_DAILY_TASK, copied.id, src_names, db,
        )
    return copied


@router.put("/log", response_model=DailyLogRead)
def upsert_daily_log(
    payload: DailyLogUpsert,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DailyLog:
    day = resolve_target_date(payload.log_date)

    # Validate main_goal_task_id (if supplied) belongs to the same user.
    # Doesn't have to match today's date — the user might pick a backlog
    # task as their main goal then start working on it today.
    # `0` is the explicit-unassign sentinel and skips validation.
    if payload.main_goal_task_id not in (None, 0):
        task = db.get(DailyTask, payload.main_goal_task_id)
        if task is None or task.user_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown main_goal task.",
            )

    statement = (
        select(DailyLog)
        .where(DailyLog.user_id == current_user.id)
        .where(DailyLog.log_date == day)
    )
    log = db.scalar(statement)
    previous_mood = log.mood if log is not None else ""

    if log is None:
        log = DailyLog(
            user_id=current_user.id,
            log_date=day,
            main_goal=payload.main_goal or "",
            # Normalise the 0-sentinel to NULL on create too.
            main_goal_task_id=(
                payload.main_goal_task_id
                if payload.main_goal_task_id not in (None, 0)
                else None
            ),
            mood=payload.mood,
            reflection=payload.reflection,
        )
        db.add(log)
    else:
        if payload.main_goal is not None:
            log.main_goal = payload.main_goal
        # Use exclude_unset would be cleaner, but DailyLogUpsert isn't a
        # plain PATCH — `mood` and `reflection` always overwrite by design.
        # Treat main_goal_task_id specially: a payload value of None means
        # "leave unchanged" rather than "unassign" so callers that don't
        # send the field don't accidentally clear it. Explicit unassign is
        # done by sending main_goal_task_id=0 — picked because 0 is never
        # a valid row id but stays a plain JSON number (no need for
        # exclude_unset gymnastics).
        if payload.main_goal_task_id is not None:
            log.main_goal_task_id = (
                payload.main_goal_task_id if payload.main_goal_task_id != 0 else None
            )
        log.mood = payload.mood
        log.reflection = payload.reflection

    if day == date.today() and payload.mood and payload.mood != previous_mood:
        record_mood_entry(current_user.id, payload.mood, "", db)

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
