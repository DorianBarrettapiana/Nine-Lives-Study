"""Paper note routes (scoped to current user).

Includes the Zotero import workflow:
  GET    /notes/zotero/config   — connection status
  PUT    /notes/zotero/config   — save creds (verified before persisting)
  DELETE /notes/zotero/config   — disconnect
  GET    /notes/zotero/items    — live list from the user's Zotero library
  POST   /notes/zotero/import   — bulk-create/update PaperNotes from keys
"""

from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.crypto import decrypt_str, encrypt_str
from app.core.database import get_db
from app.core.links import (
    delete_links_touching_item,
    extract_link_tokens,
    replace_links_for_item,
)
from app.core.tags import (
    delete_links_for_item,
    fetch_tags_for_items,
    parse_tag_input,
    replace_item_tags,
)
from app.core.xp import (
    ENTITY_NOTE,
    ENTITY_POMODORO,
    ENTITY_STOPWATCH,
    EVENT_NOTE,
    EVENT_POMODORO,
    EVENT_STOPWATCH,
    XP_NOTE_CREATE,
    award_xp_event,
)
from app.core.zotero import (
    ZoteroError,
    fetch_items_by_keys,
    list_top_items,
    verify_credentials,
)
from app.models.daily_tracker import DailyTask
from app.models.feynman_entry import FeynmanEntry
from app.models.note_link import LINK_ITEM_PAPER_NOTE
from app.models.paper_insight import PaperInsight
from app.models.paper_note import PaperNote
from app.models.pomodoro_session import PomodoroSession
from app.models.project import Project
from app.models.stopwatch_session import StopwatchSession
from app.models.tag import TAG_ITEM_PAPER_NOTE
from app.models.user import User
from app.models.xp_event import XpEvent
from app.schemas.daily_tracker import DailyTaskRead
from app.schemas.paper_note import (
    PaperInsightCreate,
    PaperInsightRead,
    PaperNoteCreate,
    PaperNoteRead,
    PaperNoteUpdate,
    ReadingContextRead,
)

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


def _validate_feynman_link(entry_id: int | None, current_user: User, db: Session) -> None:
    if entry_id is None:
        return
    entry = db.get(FeynmanEntry, entry_id)
    if entry is None or entry.user_id != current_user.id:
        raise HTTPException(status_code=400, detail="Linked Feynman entry not found.")


def _validate_project_link(project_id: int | None, current_user: User, db: Session) -> None:
    if project_id is None:
        return
    project = db.get(Project, project_id)
    if project is None or project.user_id != current_user.id:
        raise HTTPException(status_code=400, detail="Unknown project.")


def _has_reading_notes(note: PaperNote) -> bool:
    return bool((note.key_points or "").strip() or (note.questions or "").strip())


def _reading_minutes_by_note(user_id: int, db: Session) -> dict[int, int]:
    """Attribute XP-backed focus minutes through paper-backed daily tasks."""
    totals: dict[int, int] = {}
    events = db.scalars(
        select(XpEvent).where(
            XpEvent.user_id == user_id,
            XpEvent.event_type.in_([EVENT_POMODORO, EVENT_STOPWATCH]),
        )
    ).all()
    for event in events:
        session = None
        if event.entity_type == ENTITY_POMODORO:
            session = db.get(PomodoroSession, event.entity_id)
        elif event.entity_type == ENTITY_STOPWATCH:
            session = db.get(StopwatchSession, event.entity_id)
        if session is None or session.linked_task_id is None:
            continue

        task = db.get(DailyTask, session.linked_task_id)
        if task is None or task.user_id != user_id or task.paper_note_id is None:
            continue
        totals[task.paper_note_id] = totals.get(task.paper_note_id, 0) + event.amount
    return totals


def _attach_note_metadata(notes: list[PaperNote], current_user: User, db: Session) -> list[PaperNote]:
    totals = _reading_minutes_by_note(current_user.id, db)
    for note in notes:
        note.reading_minutes = totals.get(note.id, 0)
        insight_rows = db.scalars(
            select(PaperInsight)
            .where(PaperInsight.user_id == current_user.id)
            .where(PaperInsight.paper_note_id == note.id)
            .order_by(PaperInsight.created_at.desc())
        ).all()
        note.insight_count = len(insight_rows)
        note.latest_insight = insight_rows[0] if insight_rows else None
    return notes


def _resolve_tag_names(payload_tag_names: list[str] | None, payload_tags_csv: str | None) -> list[str] | None:
    """Pick the authoritative tag list out of a create/update payload.

    Precedence:
      1. `tag_names` if explicitly provided (even empty → clear all tags)
      2. `tags` CSV if provided
      3. None → caller should leave existing tags alone
    """
    if payload_tag_names is not None:
        return parse_tag_input(payload_tag_names)
    if payload_tags_csv is not None:
        return parse_tag_input(payload_tags_csv)
    return None


def _serialize_with_tags(
    notes: list[PaperNote], current_user: User, db: Session,
) -> list[PaperNoteRead]:
    """Build PaperNoteRead instances with `tag_list` populated.

    Done in one batched fetch so the list endpoint stays O(1) queries
    for tags regardless of how many notes the user has.
    """
    tag_map = fetch_tags_for_items(
        current_user.id, TAG_ITEM_PAPER_NOTE, [n.id for n in notes], db,
    )
    reads: list[PaperNoteRead] = []
    for note in notes:
        # `reading_minutes` is a derived field set ad-hoc by
        # _attach_note_metadata; ensure it exists so model_validate
        # doesn't fall back to the default for callers that forgot to
        # attribute it (e.g. Zotero importer).
        if not hasattr(note, "reading_minutes"):
            note.reading_minutes = 0
        read = PaperNoteRead.model_validate(note)
        read.tag_list = tag_map.get(note.id, [])
        reads.append(read)
    return reads


def _tags_csv_from_names(names: list[str]) -> str:
    return ", ".join(names)


def _next_task_sort_order(user_id: int, task_date: date, db: Session) -> float:
    max_so = db.scalar(
        select(DailyTask.sort_order)
        .where(DailyTask.user_id == user_id)
        .where(DailyTask.task_date == task_date)
        .order_by(DailyTask.sort_order.desc())
        .limit(1)
    )
    return (max_so or 0.0) + 1.0


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
) -> list[PaperNoteRead]:
    """Return all paper notes for the current user."""
    statement = (
        select(PaperNote)
        .where(PaperNote.user_id == current_user.id)
        .order_by(PaperNote.updated_at.desc())
    )
    notes = _attach_note_metadata(list(db.scalars(statement).all()), current_user, db)
    return _serialize_with_tags(notes, current_user, db)


@router.post("", response_model=PaperNoteRead, status_code=201)
def create_note(
    payload: PaperNoteCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PaperNoteRead:
    """Create a paper note for the current user."""
    _validate_feynman_link(payload.feynman_entry_id, current_user, db)
    _validate_project_link(payload.project_id, current_user, db)

    tag_names = _resolve_tag_names(payload.tag_names, payload.tags) or []
    note = PaperNote(
        user_id=current_user.id,
        title=payload.title,
        authors=payload.authors,
        year=payload.year,
        key_points=payload.key_points,
        questions=payload.questions,
        # Keep the CSV mirror in sync so legacy reads still see something
        # sensible. The new authoritative store is tag_links.
        tags=_tags_csv_from_names(tag_names),
        item_type=payload.item_type,
        url=payload.url,
        doi=payload.doi,
        abstract=payload.abstract,
        source="manual",
        feynman_entry_id=payload.feynman_entry_id,
        project_id=payload.project_id,
        reading_status=payload.reading_status,
    )
    db.add(note)
    db.flush()  # populate note.id so we can pin the XP event to it
    replace_item_tags(current_user.id, TAG_ITEM_PAPER_NOTE, note.id, tag_names, db)
    # Parse `[[Title]]` tokens out of the free-text body so the
    # backlinks panel reflects what the user just wrote. Title and
    # abstract are excluded — links live where the user *thinks*, not
    # where they cite metadata.
    replace_links_for_item(
        current_user.id, LINK_ITEM_PAPER_NOTE, note.id,
        extract_link_tokens(note.key_points, note.questions), db,
    )
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
    note.reading_minutes = 0
    note.insight_count = 0
    note.latest_insight = None
    return _serialize_with_tags([note], current_user, db)[0]


@router.patch("/{note_id}", response_model=PaperNoteRead)
def update_note(
    note_id: int,
    payload: PaperNoteUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PaperNoteRead:
    """Update an existing paper note (must belong to the current user).

    Note: editing a Zotero-synced note only changes the local copy. We
    don't push edits back to Zotero (yet). Re-importing the same item from
    Zotero will overwrite the bibliographic fields but preserve the
    user-written key_points / questions — see :func:`import_zotero_items`.
    """
    note = _get_owned_note(note_id, current_user, db)
    had_reading_notes = _has_reading_notes(note)

    data = payload.model_dump(exclude_unset=True)
    if "feynman_entry_id" in data:
        _validate_feynman_link(data["feynman_entry_id"], current_user, db)
    if "project_id" in data:
        _validate_project_link(data["project_id"], current_user, db)

    # Pull tag fields out before the generic setattr loop — they need
    # the link table, not direct column assignment.
    tag_names = _resolve_tag_names(
        data.pop("tag_names", None) if "tag_names" in data else None,
        data.pop("tags", None) if "tags" in data else None,
    )
    for field_name, field_value in data.items():
        setattr(note, field_name, field_value)
    if tag_names is not None:
        replace_item_tags(current_user.id, TAG_ITEM_PAPER_NOTE, note.id, tag_names, db)
        note.tags = _tags_csv_from_names(tag_names)

    # Re-scan link tokens whenever the body fields could have changed.
    # Cheap and unconditional rather than tracking which subset moved,
    # so callers that PATCH only `key_points` still rebuild correctly.
    replace_links_for_item(
        current_user.id, LINK_ITEM_PAPER_NOTE, note.id,
        extract_link_tokens(note.key_points, note.questions), db,
    )

    if note.source == "zotero" and not had_reading_notes and _has_reading_notes(note):
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
    _attach_note_metadata([note], current_user, db)
    return _serialize_with_tags([note], current_user, db)[0]


@router.post("/{note_id}/add-to-today", response_model=DailyTaskRead, status_code=201)
def add_note_to_today(
    note_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DailyTask:
    """Create one ordinary reading task for today, reusing an open one."""
    note = _get_owned_note(note_id, current_user, db)
    today = date.today()
    existing = db.scalar(
        select(DailyTask)
        .where(DailyTask.user_id == current_user.id)
        .where(DailyTask.task_date == today)
        .where(DailyTask.paper_note_id == note.id)
        .where(DailyTask.is_done.is_(False))
        .order_by(DailyTask.created_at.desc())
    )
    if existing is not None:
        return existing
    task = DailyTask(
        user_id=current_user.id,
        task_date=today,
        planned_date=today,
        text=f"Read: {note.title}",
        is_done=False,
        sort_order=_next_task_sort_order(current_user.id, today, db),
        project_id=note.project_id,
        paper_note_id=note.id,
    )
    if note.reading_status == "inbox":
        note.reading_status = "reading"
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.get("/reading-context/{task_id}", response_model=ReadingContextRead)
def get_reading_context(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ReadingContextRead:
    """Resolve a focused daily task to its paper, if it is a reading task."""
    task = db.get(DailyTask, task_id)
    if task is None or task.user_id != current_user.id or task.paper_note_id is None:
        raise HTTPException(status_code=404, detail="Reading task not found.")
    note = _get_owned_note(task.paper_note_id, current_user, db)
    return ReadingContextRead(note_id=note.id, title=note.title, project_id=note.project_id)


@router.get("/{note_id}/insights", response_model=list[PaperInsightRead])
def list_insights(
    note_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PaperInsight]:
    _get_owned_note(note_id, current_user, db)
    return list(db.scalars(
        select(PaperInsight)
        .where(PaperInsight.user_id == current_user.id)
        .where(PaperInsight.paper_note_id == note_id)
        .order_by(PaperInsight.created_at.desc())
    ).all())


@router.post("/{note_id}/insights", response_model=PaperInsightRead, status_code=201)
def create_insight(
    note_id: int,
    payload: PaperInsightCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PaperInsight:
    note = _get_owned_note(note_id, current_user, db)
    values = {
        "key_idea": payload.key_idea.strip(),
        "question": payload.question.strip(),
        "next_step": payload.next_step.strip(),
    }
    if not any(values.values()):
        raise HTTPException(status_code=400, detail="Add at least one reading insight.")
    insight = PaperInsight(user_id=current_user.id, paper_note_id=note.id, **values)
    if note.reading_status == "inbox":
        note.reading_status = "reading"
    db.add(insight)
    db.commit()
    db.refresh(insight)
    return insight


@router.delete("/{note_id}", status_code=204)
def delete_note(
    note_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Delete a paper note (must belong to the current user)."""
    note = _get_owned_note(note_id, current_user, db)
    # SQLite FK enforcement is disabled in this app, so clear the optional
    # reading-task link explicitly before removing the note.
    db.execute(
        update(DailyTask)
        .where(DailyTask.user_id == current_user.id)
        .where(DailyTask.paper_note_id == note.id)
        .values(paper_note_id=None)
    )
    db.execute(
        delete(PaperInsight)
        .where(PaperInsight.user_id == current_user.id)
        .where(PaperInsight.paper_note_id == note.id)
    )
    delete_links_for_item(TAG_ITEM_PAPER_NOTE, note.id, db)
    # Clean both directions: this note may have linked out to others,
    # and may have been the target of incoming `[[Title]]` refs.
    delete_links_touching_item(LINK_ITEM_PAPER_NOTE, note.id, db)
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
            replace_item_tags(
                current_user.id, TAG_ITEM_PAPER_NOTE, note.id,
                parse_tag_input(item.tags), db,
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
            # Sync the link table to Zotero's tag list. Treat Zotero
            # as authoritative on re-import: a tag removed there is
            # removed here too.
            replace_item_tags(
                current_user.id, TAG_ITEM_PAPER_NOTE, existing.id,
                parse_tag_input(item.tags), db,
            )
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
        notes=_serialize_with_tags(_attach_note_metadata(out, current_user, db), current_user, db),
    )
