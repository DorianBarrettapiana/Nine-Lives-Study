"""Project (research-thread) routes (scoped to current user).

A Project is a top-level grouping bucket. Daily tasks, paper notes, and
Feynman entries can each belong to one. Sessions inherit their project
transitively via linked_task_id → daily_task.project_id.

Deletion unassigns dependent rows (project_id → NULL) rather than
cascading deletion — the user keeps their notes and tasks, they just
become unassigned. This matches how Linear/GitHub/Things treat
"deleting a project that still has work in it".
"""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.xp import ENTITY_POMODORO, ENTITY_STOPWATCH, EVENT_POMODORO, EVENT_STOPWATCH
from app.models.daily_tracker import DailyTask
from app.models.feynman_entry import FeynmanEntry
from app.models.paper_insight import PaperInsight
from app.models.paper_note import PaperNote
from app.models.pomodoro_session import PomodoroSession
from app.models.project import Project
from app.models.stopwatch_session import StopwatchSession
from app.models.user import User
from app.models.xp_event import XpEvent
from app.schemas.project import (
    ProjectCreate,
    ProjectDashboardGap,
    ProjectDashboardPaper,
    ProjectDashboardRead,
    ProjectDashboardTask,
    ProjectRead,
    ProjectUpdate,
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


@router.get("/{project_id}/dashboard", response_model=ProjectDashboardRead)
def get_project_dashboard(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectDashboardRead:
    """Return the small set of signals needed to steer one research thread."""
    project = _get_owned_project(project_id, current_user, db)
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=7)
    work_events = db.scalars(
        select(XpEvent)
        .where(XpEvent.user_id == current_user.id)
        .where(XpEvent.event_type.in_([EVENT_POMODORO, EVENT_STOPWATCH]))
    ).all()

    weekly_focus_minutes = 0
    reading_minutes_by_note: dict[int, int] = {}
    for event in work_events:
        session = None
        if event.entity_type == ENTITY_POMODORO:
            session = db.get(PomodoroSession, event.entity_id)
        elif event.entity_type == ENTITY_STOPWATCH:
            session = db.get(StopwatchSession, event.entity_id)
        if session is None or session.linked_task_id is None:
            continue
        task = db.get(DailyTask, session.linked_task_id)
        if task is None or task.user_id != current_user.id:
            continue
        if task.paper_note_id is not None:
            reading_minutes_by_note[task.paper_note_id] = (
                reading_minutes_by_note.get(task.paper_note_id, 0) + event.amount
            )
        event_created_at = event.created_at
        if event_created_at.tzinfo is not None:
            event_created_at = event_created_at.astimezone(timezone.utc).replace(tzinfo=None)
        if task.project_id == project.id and event_created_at >= cutoff:
            weekly_focus_minutes += event.amount

    tasks = db.scalars(
        select(DailyTask)
        .where(DailyTask.user_id == current_user.id)
        .where(DailyTask.project_id == project.id)
        .where(DailyTask.is_done.is_(False))
        .order_by(DailyTask.due_date.asc().nullslast(), DailyTask.planned_date.asc())
        .limit(8)
    ).all()
    notes = db.scalars(
        select(PaperNote)
        .where(PaperNote.user_id == current_user.id)
        .where(PaperNote.project_id == project.id)
        .where(PaperNote.reading_status.in_(["inbox", "reading", "revisit"]))
        .order_by(PaperNote.updated_at.desc())
        .limit(8)
    ).all()
    gaps = db.scalars(
        select(FeynmanEntry)
        .where(FeynmanEntry.user_id == current_user.id)
        .where(FeynmanEntry.project_id == project.id)
        .where(FeynmanEntry.gaps != "")
        .order_by(FeynmanEntry.updated_at.desc())
        .limit(8)
    ).all()
    insights = db.scalars(
        select(PaperInsight)
        .join(PaperNote, PaperNote.id == PaperInsight.paper_note_id)
        .where(PaperInsight.user_id == current_user.id)
        .where(PaperNote.project_id == project.id)
        .order_by(PaperInsight.created_at.desc())
        .limit(6)
    ).all()

    return ProjectDashboardRead(
        project=ProjectRead.model_validate(project),
        weekly_focus_minutes=weekly_focus_minutes,
        open_tasks=[ProjectDashboardTask.model_validate(task) for task in tasks],
        reading_queue=[
            ProjectDashboardPaper(
                id=note.id,
                title=note.title,
                reading_status=note.reading_status,
                reading_minutes=reading_minutes_by_note.get(note.id, 0),
            )
            for note in notes
        ],
        unresolved_gaps=[ProjectDashboardGap.model_validate(gap) for gap in gaps],
        recent_insights=list(insights),
    )


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
    for model in (DailyTask, PaperNote, FeynmanEntry):
        db.execute(
            update(model)
            .where(model.user_id == current_user.id)
            .where(model.project_id == project_id)
            .values(project_id=None),
        )

    db.delete(project)
    db.commit()
