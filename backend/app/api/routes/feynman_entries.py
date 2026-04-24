"""Feynman entry routes."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.feynman_entry import FeynmanEntry
from app.models.user import User
from app.schemas.feynman_entry import (
    FeynmanEntryCreate,
    FeynmanEntryRead,
    FeynmanEntryUpdate,
)

router = APIRouter(tags=["feynman"])


@router.get("/users/{user_id}/feynman", response_model=list[FeynmanEntryRead])
def list_user_feynman_entries(
    user_id: int,
    db: Session = Depends(get_db),
) -> list[FeynmanEntry]:
    """Return all Feynman entries attached to a user."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    statement = (
        select(FeynmanEntry)
        .where(FeynmanEntry.user_id == user_id)
        .order_by(FeynmanEntry.updated_at.desc())
    )
    return list(db.scalars(statement).all())


@router.post("/users/{user_id}/feynman", response_model=FeynmanEntryRead, status_code=201)
def create_user_feynman_entry(
    user_id: int,
    payload: FeynmanEntryCreate,
    db: Session = Depends(get_db),
) -> FeynmanEntry:
    """Create a Feynman entry for a user."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    entry = FeynmanEntry(
        user_id=user_id,
        concept=payload.concept,
        explanation=payload.explanation,
        gaps=payload.gaps,
        analogy=payload.analogy,
    )

    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.patch("/feynman/{entry_id}", response_model=FeynmanEntryRead)
def update_feynman_entry(
    entry_id: int,
    payload: FeynmanEntryUpdate,
    db: Session = Depends(get_db),
) -> FeynmanEntry:
    """Update an existing Feynman entry."""
    entry = db.get(FeynmanEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Feynman entry not found.")

    update_data = payload.model_dump(exclude_unset=True)

    for field_name, field_value in update_data.items():
        setattr(entry, field_name, field_value)

    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/feynman/{entry_id}", status_code=204)
def delete_feynman_entry(
    entry_id: int,
    db: Session = Depends(get_db),
) -> None:
    """Delete a Feynman entry."""
    entry = db.get(FeynmanEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Feynman entry not found.")

    db.delete(entry)
    db.commit()