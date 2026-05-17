"""Feynman entry routes (scoped to current user)."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.xp import XP_FEYNMAN_CREATE, award_xp
from app.models.feynman_entry import FeynmanEntry
from app.models.user import User
from app.schemas.feynman_entry import (
    FeynmanEntryCreate,
    FeynmanEntryRead,
    FeynmanEntryUpdate,
)

router = APIRouter(prefix="/feynman", tags=["feynman"])


def _get_owned_entry(entry_id: int, current_user: User, db: Session) -> FeynmanEntry:
    entry = db.get(FeynmanEntry, entry_id)
    if entry is None or entry.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Feynman entry not found.")
    return entry


@router.get("", response_model=list[FeynmanEntryRead])
def list_feynman_entries(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[FeynmanEntry]:
    statement = (
        select(FeynmanEntry)
        .where(FeynmanEntry.user_id == current_user.id)
        .order_by(FeynmanEntry.updated_at.desc())
    )
    return list(db.scalars(statement).all())


@router.post("", response_model=FeynmanEntryRead, status_code=201)
def create_feynman_entry(
    payload: FeynmanEntryCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FeynmanEntry:
    entry = FeynmanEntry(
        user_id=current_user.id,
        concept=payload.concept,
        explanation=payload.explanation,
        gaps=payload.gaps,
        analogy=payload.analogy,
    )
    db.add(entry)
    award_xp(current_user.id, XP_FEYNMAN_CREATE, db)
    db.commit()
    db.refresh(entry)
    return entry


@router.patch("/{entry_id}", response_model=FeynmanEntryRead)
def update_feynman_entry(
    entry_id: int,
    payload: FeynmanEntryUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FeynmanEntry:
    entry = _get_owned_entry(entry_id, current_user, db)
    data = payload.model_dump(exclude_unset=True)
    for field_name, field_value in data.items():
        setattr(entry, field_name, field_value)
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/{entry_id}", status_code=204)
def delete_feynman_entry(
    entry_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    entry = _get_owned_entry(entry_id, current_user, db)
    db.delete(entry)
    db.commit()
