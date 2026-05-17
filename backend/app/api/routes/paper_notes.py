"""Paper note routes."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.xp import XP_NOTE_CREATE, award_xp
from app.models.paper_note import PaperNote
from app.models.user import User
from app.schemas.paper_note import PaperNoteCreate, PaperNoteRead, PaperNoteUpdate

router = APIRouter(tags=["paper-notes"])


@router.get("/users/{user_id}/notes", response_model=list[PaperNoteRead])
def list_user_notes(user_id: int, db: Session = Depends(get_db)) -> list[PaperNote]:
    """Return all paper notes attached to a user."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    statement = (
        select(PaperNote)
        .where(PaperNote.user_id == user_id)
        .order_by(PaperNote.updated_at.desc())
    )
    return list(db.scalars(statement).all())


@router.post("/users/{user_id}/notes", response_model=PaperNoteRead, status_code=201)
def create_user_note(
    user_id: int,
    payload: PaperNoteCreate,
    db: Session = Depends(get_db),
) -> PaperNote:
    """Create a paper note for a user."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    note = PaperNote(
        user_id=user_id,
        title=payload.title,
        authors=payload.authors,
        year=payload.year,
        key_points=payload.key_points,
        questions=payload.questions,
        tags=payload.tags,
    )

    db.add(note)
    award_xp(user_id, XP_NOTE_CREATE, db)
    db.commit()
    db.refresh(note)
    return note


@router.patch("/notes/{note_id}", response_model=PaperNoteRead)
def update_note(
    note_id: int,
    payload: PaperNoteUpdate,
    db: Session = Depends(get_db),
) -> PaperNote:
    """Update an existing paper note."""
    note = db.get(PaperNote, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Paper note not found.")

    update_data = payload.model_dump(exclude_unset=True)

    for field_name, field_value in update_data.items():
        setattr(note, field_name, field_value)

    db.commit()
    db.refresh(note)
    return note


@router.delete("/notes/{note_id}", status_code=204)
def delete_note(note_id: int, db: Session = Depends(get_db)) -> None:
    """Delete a paper note."""
    note = db.get(PaperNote, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Paper note not found.")

    db.delete(note)
    db.commit()