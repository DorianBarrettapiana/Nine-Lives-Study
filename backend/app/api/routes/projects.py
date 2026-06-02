"""Project (research-thread) routes (scoped to current user).

A Project is a top-level grouping bucket. Daily tasks, paper notes, and
Feynman entries can each belong to one. Sessions inherit their project
transitively via linked_task_id → daily_task.project_id.

Deletion unassigns dependent rows (project_id → NULL) rather than
cascading deletion — the user keeps their notes and tasks, they just
become unassigned. This matches how Linear/GitHub/Things treat
"deleting a project that still has work in it".
"""

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.xp import ENTITY_POMODORO, ENTITY_STOPWATCH, EVENT_POMODORO, EVENT_STOPWATCH
from app.models.daily_tracker import DailyLog, DailyTask
from app.models.feynman_entry import FeynmanEntry
from app.models.milestone import Milestone
from app.models.paper_insight import PaperInsight
from app.models.paper_note import PaperNote
from app.models.pomodoro_session import PomodoroSession
from app.models.project import Project
from app.models.stopwatch_session import StopwatchSession
from app.models.user import User
from app.models.xp_event import XpEvent
from app.schemas.project import (
    ProjectCreate,
    ProjectDashboardRead,
    ProjectRead,
    ProjectUpdate,
    ReflectionMention,
)

router = APIRouter(prefix="/projects", tags=["projects"])


def _get_owned_project(project_id: int, current_user: User, db: Session) -> Project:
    """Fetch a project ensuring it belongs to the current user (else 404)."""
    project = db.get(Project, project_id)
    if project is None or project.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found.",
        )
    return project


@router.get("", response_model=list[ProjectRead])
def list_projects(
    include_archived: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Project]:
    """List the current user's projects (active by default)."""
    stmt = (
        select(Project)
        .where(Project.user_id == current_user.id)
        .order_by(Project.is_archived.asc(), Project.created_at.desc())
    )
    if not include_archived:
        stmt = stmt.where(Project.is_archived == False)  # noqa: E712
    return list(db.scalars(stmt).all())


@router.post("", response_model=ProjectRead, status_code=201)
def create_project(
    payload: ProjectCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Project:
    project = Project(
        user_id=current_user.id,
        name=payload.name.strip(),
        color=payload.color,
        research_question=payload.research_question.strip(),
        milestone=payload.milestone.strip(),
        advisor_meeting_date=payload.advisor_meeting_date,
        blocker=payload.blocker.strip(),
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@router.patch("/{project_id}", response_model=ProjectRead)
def update_project(
    project_id: int,
    payload: ProjectUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Project:
    project = _get_owned_project(project_id, current_user, db)
    data = payload.model_dump(exclude_unset=True)
    for field in ("name", "research_question", "milestone", "blocker"):
        if field in data and data[field] is not None:
            data[field] = data[field].strip()
    for field, value in data.items():
        setattr(project, field, value)
    db.commit()
    db.refresh(project)
    return project


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Delete a project. Dependent rows (tasks, notes, feynman) have their
    project_id set to NULL — they survive as unassigned items."""
    project = _get_owned_project(project_id, current_user, db)

    # Unassign in three tables in one transaction. We scope the UPDATE to
    # the owning user as defense-in-depth — even though only the user's own
    # project_id values could match, scoping by user_id keeps a future
    # "shared project" feature from accidentally touching other users' rows.
    for model in (DailyTask, PaperNote, FeynmanEntry, Milestone):
        db.execute(
            update(model)
            .where(model.user_id == current_user.id)
            .where(model.project_id == project_id)
            .values(project_id=None),
        )

    db.delete(project)
    db.commit()


@router.get("/{project_id}/dashboard", response_model=ProjectDashboardRead)
def get_project_dashboard(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectDashboardRead:
    """Aggregated "research thread status" for a single project.

    Combines:
      * Pulse: minutes worked over last 7 / 30 days, completed tasks
        in last 7 days, last activity timestamp.
      * Open work: unfinished tasks attached to this project.
      * Knowledge: paper notes + Feynman entries attached to this
        project.
      * Mentions: snippets of daily reflections from the last 30 days
        where this project's name appears (case-insensitive substring).

    Time aggregation is transitive: a work session counts toward a
    project only if its `linked_task_id` references a task currently
    assigned to that project. Sessions on a since-reassigned task move
    with the task — same semantics as the Stats page.
    """
    project = _get_owned_project(project_id, current_user, db)
    user_id = current_user.id
    now = datetime.now(timezone.utc)
    today = date.today()
    cutoff_7d = now - timedelta(days=7)
    cutoff_30d = now - timedelta(days=30)
    reflection_since = today - timedelta(days=30)

    # --- Tasks for this project ----------------------------------------------
    tasks = list(db.scalars(
        select(DailyTask)
        .where(DailyTask.user_id == user_id)
        .where(DailyTask.project_id == project_id)
        # Open first; most recently touched first. created_at avoids NULL
        # ordering surprises now that backlog tasks have no planned_date.
        .order_by(DailyTask.is_done.asc(), DailyTask.created_at.desc())
    ).all())
    task_ids = {t.id for t in tasks}
    open_tasks = [t for t in tasks if not t.is_done]
    done_tasks_7d = sum(
        1 for t in tasks
        if t.is_done and t.updated_at and t.updated_at.replace(tzinfo=timezone.utc) >= cutoff_7d
    )

    # --- Work sessions linked (transitively) to this project ------------------
    # We pull only sessions whose linked_task_id is in this project's task
    # set, then sum minutes via the XP ledger (same logic as stats.py).
    if task_ids:
        pomodoros = list(db.scalars(
            select(PomodoroSession)
            .where(PomodoroSession.user_id == user_id)
            .where(PomodoroSession.linked_task_id.in_(task_ids))
            .where(PomodoroSession.is_completed == True)  # noqa: E712
        ).all())
        stopwatches = list(db.scalars(
            select(StopwatchSession)
            .where(StopwatchSession.user_id == user_id)
            .where(StopwatchSession.linked_task_id.in_(task_ids))
        ).all())
    else:
        pomodoros = []
        stopwatches = []

    pomo_ids = [s.id for s in pomodoros]
    sw_ids = [s.id for s in stopwatches]

    work_events: list[XpEvent] = []
    if pomo_ids:
        work_events.extend(db.scalars(
            select(XpEvent)
            .where(XpEvent.user_id == user_id)
            .where(XpEvent.event_type == EVENT_POMODORO)
            .where(XpEvent.entity_type == ENTITY_POMODORO)
            .where(XpEvent.entity_id.in_(pomo_ids))
        ).all())
    if sw_ids:
        work_events.extend(db.scalars(
            select(XpEvent)
            .where(XpEvent.user_id == user_id)
            .where(XpEvent.event_type == EVENT_STOPWATCH)
            .where(XpEvent.entity_type == ENTITY_STOPWATCH)
            .where(XpEvent.entity_id.in_(sw_ids))
        ).all())

    minutes_7d = 0
    minutes_30d = 0
    last_activity_at: datetime | None = None
    for ev in work_events:
        ts = ev.created_at.replace(tzinfo=timezone.utc) if ev.created_at and ev.created_at.tzinfo is None else ev.created_at
        if ts is None:
            continue
        if ts >= cutoff_30d:
            minutes_30d += ev.amount
            if ts >= cutoff_7d:
                minutes_7d += ev.amount
        if last_activity_at is None or ts > last_activity_at:
            last_activity_at = ts

    # --- Paper notes & Feynman entries ---------------------------------------
    paper_notes = list(db.scalars(
        select(PaperNote)
        .where(PaperNote.user_id == user_id)
        .where(PaperNote.project_id == project_id)
        .order_by(PaperNote.updated_at.desc())
    ).all())

    feynman_entries = list(db.scalars(
        select(FeynmanEntry)
        .where(FeynmanEntry.user_id == user_id)
        .where(FeynmanEntry.project_id == project_id)
        .order_by(FeynmanEntry.updated_at.desc())
    ).all())

    recent_insights = list(db.scalars(
        select(PaperInsight)
        .join(PaperNote, PaperNote.id == PaperInsight.paper_note_id)
        .where(PaperInsight.user_id == user_id)
        .where(PaperNote.project_id == project_id)
        .order_by(PaperInsight.created_at.desc())
        .limit(6)
    ).all())

    # --- Reflection mentions --------------------------------------------------
    # Case-insensitive substring match against the project's name. Cheap
    # MVP heuristic — false positives possible if the user has a short or
    # generic project name ("Notes"), but we'd rather over-surface than
    # require a markdown tag syntax in their reflection field.
    name_lower = project.name.lower()
    mentions: list[ReflectionMention] = []
    if name_lower.strip():
        recent_logs = db.scalars(
            select(DailyLog)
            .where(DailyLog.user_id == user_id)
            .where(DailyLog.log_date >= reflection_since)
            .order_by(DailyLog.log_date.desc())
        ).all()
        for log in recent_logs:
            text = (log.reflection or "")
            idx = text.lower().find(name_lower)
            if idx < 0:
                continue
            # ~80 chars of context around the match.
            start = max(0, idx - 30)
            end = min(len(text), idx + len(project.name) + 50)
            snippet = text[start:end].strip()
            if start > 0:
                snippet = "…" + snippet
            if end < len(text):
                snippet = snippet + "…"
            mentions.append(ReflectionMention(log_date=log.log_date, snippet=snippet))
            if len(mentions) >= 5:
                break

    return ProjectDashboardRead(
        project=ProjectRead.model_validate(project),
        minutes_7d=minutes_7d,
        minutes_30d=minutes_30d,
        done_tasks_7d=done_tasks_7d,
        open_tasks_count=len(open_tasks),
        last_activity_at=last_activity_at,
        open_tasks=[t for t in open_tasks],
        paper_notes=[n for n in paper_notes],
        feynman_entries=[e for e in feynman_entries],
        recent_reflections=mentions,
        recent_insights=recent_insights,
    )
