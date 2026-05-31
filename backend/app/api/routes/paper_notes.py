"""Paper note routes (scoped to current user).

Includes the Zotero import workflow:
  GET    /notes/zotero/config   — connection status
  PUT    /notes/zotero/config   — save creds (verified before persisting)
  DELETE /notes/zotero/config   — disconnect
  GET    /notes/zotero/items    — live list from the user's Zotero library
  POST   /notes/zotero/import   — bulk-create/update PaperNotes from keys
"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.crypto import decrypt_str, encrypt_str
from app.core.database import get_db
from app.core.xp import ENTITY_NOTE, EVENT_NOTE, XP_NOTE_CREATE, award_xp_event
from app.core.zotero import (
    ZoteroError,
    fetch_items_by_keys,
    list_top_items,
    verify_credentials,
)
from app.models.paper_note import PaperNote
from app.models.user import User
from app.schemas.paper_note import PaperNoteCreate, PaperNoteRead, PaperNoteUpdate

router = APIRouter(prefix="/notes", tags=["paper-notes"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_owned_note(note_id: int, current_user: User, db: Session) -> PaperNote:
    """Fetch a note and ensure it belongs to the current user (else 404)."""
    note = db.get(PaperNote, note_id)
    if note is None or note.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Paper note not found.")
    return note


def _decrypt_user_key(user: User) -> str:
    """Decrypt the stored Zotero key, or raise 400 with a helpful message."""
    if not user.zotero_user_id or not user.zotero_api_key_enc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Zotero is not connected. Add your credentials in settings.",
        )
    try:
        return decrypt_str(user.zotero_api_key_enc)
    except ValueError:
        # Key rotation invalidated stored ciphertext — force the user to
        # re-paste rather than silently fail every Zotero call.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Stored Zotero key could not be decrypted. Please re-connect.",
        ) from None


def _zotero_error_to_http(exc: ZoteroError) -> HTTPException:
    """Translate Zotero HTTP failures into user-friendly app errors."""
    if exc.status_code == 403:
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Zotero rejected the credentials (key invalid or no library access).",
        )
    if exc.status_code == 404:
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Zotero user ID not found.",
        )
    if exc.status_code == 429:
        return HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Zotero rate limit hit. Try again in a minute.",
        )
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=f"Zotero error: {exc}",
    )


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


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
    note = PaperNote(
        user_id=current_user.id,
        title=payload.title,
        authors=payload.authors,
        year=payload.year,
        key_points=payload.key_points,
        questions=payload.questions,
        tags=payload.tags,
        item_type=payload.item_type,
        url=payload.url,
        doi=payload.doi,
        abstract=payload.abstract,
        source="manual",
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
    """Update an existing paper note (must belong to the current user).

    Note: editing a Zotero-synced note only changes the local copy. We
    don't push edits back to Zotero (yet). Re-importing the same item from
    Zotero will overwrite the bibliographic fields but preserve the
    user-written key_points / questions — see :func:`import_zotero_items`.
    """
    note = _get_owned_note(note_id, current_user, db)

    data = payload.model_dump(exclude_unset=True)
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


# ---------------------------------------------------------------------------
# Zotero: settings
# ---------------------------------------------------------------------------


class ZoteroConfigRead(BaseModel):
    connected: bool
    zotero_user_id: str | None = None


class ZoteroConfigWrite(BaseModel):
    zotero_user_id: str = Field(..., min_length=1, max_length=50, pattern=r"^[0-9]+$")
    # Zotero API keys are 24-char alphanumeric; allow up to 64 for headroom.
    api_key: str = Field(..., min_length=8, max_length=64)


@router.get("/zotero/config", response_model=ZoteroConfigRead)
def get_zotero_config(current_user: User = Depends(get_current_user)) -> ZoteroConfigRead:
    return ZoteroConfigRead(
        connected=bool(current_user.zotero_user_id and current_user.zotero_api_key_enc),
        zotero_user_id=current_user.zotero_user_id,
    )


@router.put("/zotero/config", response_model=ZoteroConfigRead)
def set_zotero_config(
    payload: ZoteroConfigWrite,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ZoteroConfigRead:
    """Verify the credentials with a live API hit, then persist.

    We test BEFORE saving so the user gets immediate feedback if they
    fat-fingered the key, instead of discovering it later when import fails.
    """
    try:
        verify_credentials(payload.zotero_user_id, payload.api_key)
    except ZoteroError as exc:
        raise _zotero_error_to_http(exc) from exc

    current_user.zotero_user_id = payload.zotero_user_id
    current_user.zotero_api_key_enc = encrypt_str(payload.api_key)
    db.commit()
    db.refresh(current_user)
    return ZoteroConfigRead(
        connected=True,
        zotero_user_id=current_user.zotero_user_id,
    )


@router.delete("/zotero/config", status_code=204)
def disconnect_zotero(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Forget the stored credentials. Previously-imported notes stay."""
    current_user.zotero_user_id = None
    current_user.zotero_api_key_enc = None
    db.commit()


# ---------------------------------------------------------------------------
# Zotero: browse + import
# ---------------------------------------------------------------------------


class ZoteroItemRead(BaseModel):
    """One row in the import picker."""

    key: str
    version: int
    item_type: str
    title: str
    authors: str
    year: int | None
    tags: str
    url: str
    doi: str
    abstract: str
    # True iff the user already has a PaperNote for this Zotero key —
    # the picker uses it to show "already imported" + change the button
    # to "Re-sync" instead of "Import".
    already_imported: bool


class ZoteroItemsResponse(BaseModel):
    items: list[ZoteroItemRead]
    total: int
    start: int
    limit: int


@router.get("/zotero/items", response_model=ZoteroItemsResponse)
def list_zotero_items(
    limit: int = Query(default=25, ge=1, le=100),
    start: int = Query(default=0, ge=0),
    q: str | None = Query(default=None, max_length=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ZoteroItemsResponse:
    api_key = _decrypt_user_key(current_user)
    try:
        items, total = list_top_items(
            current_user.zotero_user_id or "",
            api_key,
            limit=limit,
            start=start,
            query=q,
        )
    except ZoteroError as exc:
        raise _zotero_error_to_http(exc) from exc

    # Which of these keys does the user already have? One small query keeps
    # the picker UI honest without making it per-row.
    keys = [i.key for i in items]
    already = set()
    if keys:
        rows = db.scalars(
            select(PaperNote.zotero_key)
            .where(PaperNote.user_id == current_user.id)
            .where(PaperNote.zotero_key.in_(keys))
        ).all()
        already = {r for r in rows if r}

    return ZoteroItemsResponse(
        items=[
            ZoteroItemRead(
                key=i.key,
                version=i.version,
                item_type=i.item_type,
                title=i.title,
                authors=i.authors,
                year=i.year,
                tags=i.tags,
                url=i.url,
                doi=i.doi,
                abstract=i.abstract,
                already_imported=i.key in already,
            )
            for i in items
        ],
        total=total,
        start=start,
        limit=limit,
    )


class ZoteroImportRequest(BaseModel):
    keys: list[str] = Field(..., min_length=1, max_length=200)
    # 'preserve' (default): keep existing user-written key_points/questions
    #     when re-importing an item. Only refresh the bibliographic fields.
    # 'overwrite': also clear key_points/questions (rare — only useful if
    #     the user knows they want to start over from Zotero's abstract).
    on_existing: Literal["preserve", "overwrite"] = "preserve"


class ZoteroImportResult(BaseModel):
    imported: int
    updated: int
    skipped: int
    notes: list[PaperNoteRead]


@router.post("/zotero/import", response_model=ZoteroImportResult, status_code=201)
def import_zotero_items(
    payload: ZoteroImportRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ZoteroImportResult:
    """Import (or re-sync) the specified Zotero items into PaperNotes."""
    api_key = _decrypt_user_key(current_user)
    try:
        fetched = fetch_items_by_keys(
            current_user.zotero_user_id or "", api_key, payload.keys,
        )
    except ZoteroError as exc:
        raise _zotero_error_to_http(exc) from exc

    if not fetched:
        return ZoteroImportResult(imported=0, updated=0, skipped=len(payload.keys), notes=[])

    # Bulk-load existing rows for the requested keys so we don't issue one
    # SELECT per item.
    existing_rows = db.scalars(
        select(PaperNote)
        .where(PaperNote.user_id == current_user.id)
        .where(PaperNote.zotero_key.in_([i.key for i in fetched]))
    ).all()
    by_key = {row.zotero_key: row for row in existing_rows if row.zotero_key}

    imported = 0
    updated = 0
    out: list[PaperNote] = []

    for item in fetched:
        existing = by_key.get(item.key)
        if existing is None:
            note = PaperNote(
                user_id=current_user.id,
                title=item.title,
                authors=item.authors,
                year=item.year,
                key_points="",
                questions="",
                tags=item.tags,
                item_type=item.item_type,
                url=item.url,
                doi=item.doi,
                abstract=item.abstract,
                zotero_key=item.key,
                zotero_version=item.version,
                source="zotero",
            )
            db.add(note)
            db.flush()
            # Award XP once per Zotero key — award_xp_event is idempotent on
            # (user, event, entity_type, entity_id), so re-imports don't grant
            # extra XP later.
            award_xp_event(
                user_id=current_user.id,
                event_type=EVENT_NOTE,
                entity_type=ENTITY_NOTE,
                entity_id=note.id,
                amount=XP_NOTE_CREATE,
                db=db,
            )
            imported += 1
            out.append(note)
        else:
            # Refresh bibliographic fields. Keep user-written reflections
            # unless they explicitly asked to wipe them.
            existing.title = item.title
            existing.authors = item.authors
            existing.year = item.year
            existing.tags = item.tags
            existing.item_type = item.item_type
            existing.url = item.url
            existing.doi = item.doi
            existing.abstract = item.abstract
            existing.zotero_version = item.version
            existing.source = "zotero"
            if payload.on_existing == "overwrite":
                existing.key_points = ""
                existing.questions = ""
            updated += 1
            out.append(existing)

    db.commit()
    for n in out:
        db.refresh(n)

    skipped = len(payload.keys) - (imported + updated)
    return ZoteroImportResult(
        imported=imported,
        updated=updated,
        skipped=max(0, skipped),
        notes=[PaperNoteRead.model_validate(n) for n in out],
    )
