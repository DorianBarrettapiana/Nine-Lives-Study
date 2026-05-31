"""Project (research-thread) routes (scoped to current user).

A Project is a top-level grouping bucket. Daily tasks, paper notes, and
Feynman entries can each belong to one. Sessions inherit their project
transitively via linked_task_id → daily_task.project_id.

Deletion unassigns dependent rows (project_id → NULL) rather than
cascading deletion — the user keeps their notes and tasks, they just
become unassigned. This matches how Linear/GitHub/Things treat
"deleting a project that still has work in it".
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.daily_tracker import DailyTask
from app.models.feynman_entry import FeynmanEntry
from app.models.paper_note import PaperNote
from app.models.project import Project
from app.models.user import User
from app.schemas.project import ProjectCreate, ProjectRead, ProjectUpdate

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
    if "name" in data and data["name"] is not None:
        data["name"] = data["name"].strip()
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
    for model in (DailyTask, PaperNote, FeynmanEntry):
        db.execute(
            update(model)
            .where(model.user_id == current_user.id)
            .where(model.project_id == project_id)
            .values(project_id=None),
        )

    db.delete(project)
    db.commit()
