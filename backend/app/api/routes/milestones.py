"""Milestone routes (scoped to current user).

A Milestone is a date-anchored target (conference deadline, defense,
chapter due). Optionally bound to a Project. Returned by default
sorted by due_date ascending so the sidebar can show "next up" without
re-sorting client-side.

Default listing: active (not archived), regardless of whether due_date
is past — the user often wants to see "expired but not yet acknowledged"
items. `include_archived` and `only_future` flags carve out the other
common views.
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.milestone import Milestone
from app.models.project import Project
from app.models.user import User
from app.schemas.milestone import (
    MilestoneCreate,
    MilestoneRead,
    MilestoneUpdate,
)

router = APIRouter(prefix="/milestones", tags=["milestones"])


def _get_owned_milestone(milestone_id: int, current_user: User, db: Session) -> Milestone:
    """Fetch a milestone or 404 if it doesn't belong to the caller."""
    m = db.get(Milestone, milestone_id)
    if m is None or m.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Milestone not found.",
        )
    return m


def _validate_project_id(project_id: int | None, current_user: User, db: Session) -> None:
    """Reject project_id values that don't belong to the current user.

    Same shape as the daily_tasks / paper_notes validator. NULL is
    always allowed (cross-project milestone).
    """
    if project_id is None:
        return
    project = db.get(Project, project_id)
    if project is None or project.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unknown project.",
        )


@router.get("", response_model=list[MilestoneRead])
def list_milestones(
    include_archived: bool = False,
    only_future: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Milestone]:
    """List the caller's milestones, soonest-first.

    Defaults to active (not archived), all dates. `only_future=true`
    drops items whose due_date has passed; the sidebar uses that to
    avoid showing stale items at the top of the countdown list.
    """
    stmt = (
        select(Milestone)
        .where(Milestone.user_id == current_user.id)
        .order_by(Milestone.due_date.asc(), Milestone.id.asc())
    )
    if not include_archived:
        stmt = stmt.where(Milestone.is_archived == False)  # noqa: E712
    if only_future:
        stmt = stmt.where(Milestone.due_date >= date.today())
    return list(db.scalars(stmt).all())


@router.post("", response_model=MilestoneRead, status_code=201)
def create_milestone(
    payload: MilestoneCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Milestone:
    _validate_project_id(payload.project_id, current_user, db)
    m = Milestone(
        user_id=current_user.id,
        title=payload.title.strip(),
        due_date=payload.due_date,
        project_id=payload.project_id,
        notes=payload.notes or "",
        is_archived=False,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


@router.patch("/{milestone_id}", response_model=MilestoneRead)
def update_milestone(
    milestone_id: int,
    payload: MilestoneUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Milestone:
    m = _get_owned_milestone(milestone_id, current_user, db)
    data = payload.model_dump(exclude_unset=True)
    if "project_id" in data:
        _validate_project_id(data["project_id"], current_user, db)
    if "title" in data and data["title"] is not None:
        data["title"] = data["title"].strip()
    for field, value in data.items():
        setattr(m, field, value)
    db.commit()
    db.refresh(m)
    return m


@router.delete("/{milestone_id}", status_code=204)
def delete_milestone(
    milestone_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Hard-delete the milestone.

    No dependent rows yet (tasks don't reference milestones), so this
    is a plain DELETE. When/if task → milestone wiring lands, mirror
    the /projects DELETE policy: set FK to NULL before removing.
    """
    m = _get_owned_milestone(milestone_id, current_user, db)
    db.delete(m)
    db.commit()
