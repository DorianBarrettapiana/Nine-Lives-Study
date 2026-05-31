"""Paper note routes (scoped to current user)."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.xp import ENTITY_NOTE, EVENT_NOTE, XP_NOTE_CREATE, award_xp_event
from app.models.feynman_entry import FeynmanEntry
from app.models.paper_note import PaperNote
from app.models.user import User
from app.schemas.paper_note import PaperNoteCreate, PaperNoteRead, PaperNoteUpdate

router = APIRouter(prefix="/notes", tags=["paper-notes"])


def _get_owned_note(note_id: int, current_user: User, db: Session) -> PaperNote:
    """Fetch a note and ensure it belongs to the current user (else 404)."""
    note = db.get(PaperNote, note_id)
    if note is None or note.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Paper note not found.")
    return note


def _validate_feynman_link(entry_id: int | None, current_user: User, db: Session) -> None:
    if entry_id is None:
        return
    entry = db.get(FeynmanEntry, entry_id)
    if entry is None or entry.user_id != current_user.id:
        raise HTTPException(status_code=400, detail="Linked Feynman entry not found.")


@router.get("", response_model=list[PaperNoteRead])
def list_notes(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PaperNote]:
    """Return all paper notes for the current user."""
    statement = (
        select(PaperNote)
        .where(PaperNote.user_id == current_user.id)
        .order_by(PaperNote.updated_at.desc())
    )
    return list(db.scalars(statement).all())


@router.post("", response_model=PaperNoteRead, status_code=201)
def create_note(
    payload: PaperNoteCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PaperNote:
    """Create a paper note for the current user."""
    _validate_feynman_link(payload.feynman_entry_id, current_user, db)
    note = PaperNote(
        user_id=current_user.id,
        title=payload.title,
        authors=payload.authors,
        year=payload.year,
        key_points=payload.key_points,
        questions=payload.questions,
        tags=payload.tags,
        doi=payload.doi,
        url=payload.url,
        feynman_entry_id=payload.feynman_entry_id,
    )
    db.add(note)
    db.flush()  # populate note.id so we can pin the XP event to it
    award_xp_event(
        user_id=current_user.id,
        event_type=EVENT_NOTE,
        entity_type=ENTITY_NOTE,
        entity_id=note.id,
        amount=XP_NOTE_CREATE,
        db=db,
    )
    db.commit()
    db.refresh(note)
    return note


@router.patch("/{note_id}", response_model=PaperNoteRead)
def update_note(
    note_id: int,
    payload: PaperNoteUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PaperNote:
    """Update an existing paper note (must belong to the current user)."""
    note = _get_owned_note(note_id, current_user, db)

    data = payload.model_dump(exclude_unset=True)
    if "feynman_entry_id" in data:
        _validate_feynman_link(data["feynman_entry_id"], current_user, db)
    for field_name, field_value in data.items():
        setattr(note, field_name, field_value)

    db.commit()
    db.refresh(note)
    return note


@router.delete("/{note_id}", status_code=204)
def delete_note(
    note_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Delete a paper note (must belong to the current user)."""
    note = _get_owned_note(note_id, current_user, db)
    db.delete(note)
    db.commit()
