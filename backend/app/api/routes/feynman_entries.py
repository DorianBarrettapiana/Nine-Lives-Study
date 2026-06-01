"""Feynman entry routes (scoped to current user)."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.tags import (
    delete_links_for_item,
    fetch_tags_for_items,
    parse_tag_input,
    replace_item_tags,
)
from app.core.xp import ENTITY_FEYNMAN, EVENT_FEYNMAN, XP_FEYNMAN_CREATE, award_xp_event
from app.models.feynman_entry import FeynmanEntry
from app.models.project import Project
from app.models.tag import TAG_ITEM_FEYNMAN_ENTRY
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


def _validate_project_id(project_id: int | None, current_user: User, db: Session) -> None:
    if project_id is None:
        return
    project = db.get(Project, project_id)
    if project is None or project.user_id != current_user.id:
        raise HTTPException(status_code=400, detail="Unknown project.")


def _serialize_with_tags(
    entries: list[FeynmanEntry], current_user: User, db: Session,
) -> list[FeynmanEntryRead]:
    """Build FeynmanEntryRead instances with tag_list populated in one query."""
    tag_map = fetch_tags_for_items(
        current_user.id, TAG_ITEM_FEYNMAN_ENTRY, [e.id for e in entries], db,
    )
    reads: list[FeynmanEntryRead] = []
    for entry in entries:
        read = FeynmanEntryRead.model_validate(entry)
        read.tag_list = tag_map.get(entry.id, [])
        reads.append(read)
    return reads


@router.get("", response_model=list[FeynmanEntryRead])
def list_feynman_entries(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[FeynmanEntryRead]:
    statement = (
        select(FeynmanEntry)
        .where(FeynmanEntry.user_id == current_user.id)
        .order_by(FeynmanEntry.updated_at.desc())
    )
    entries = list(db.scalars(statement).all())
    return _serialize_with_tags(entries, current_user, db)


@router.post("", response_model=FeynmanEntryRead, status_code=201)
def create_feynman_entry(
    payload: FeynmanEntryCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FeynmanEntryRead:
    _validate_project_id(payload.project_id, current_user, db)
    entry = FeynmanEntry(
        user_id=current_user.id,
        concept=payload.concept,
        explanation=payload.explanation,
        gaps=payload.gaps,
        analogy=payload.analogy,
        project_id=payload.project_id,
    )
    db.add(entry)
    db.flush()
    replace_item_tags(
        current_user.id, TAG_ITEM_FEYNMAN_ENTRY, entry.id,
        parse_tag_input(payload.tag_names) if payload.tag_names is not None else [],
        db,
    )
    award_xp_event(
        user_id=current_user.id,
        event_type=EVENT_FEYNMAN,
        entity_type=ENTITY_FEYNMAN,
        entity_id=entry.id,
        amount=XP_FEYNMAN_CREATE,
        db=db,
    )
    db.commit()
    db.refresh(entry)
    return _serialize_with_tags([entry], current_user, db)[0]


@router.patch("/{entry_id}", response_model=FeynmanEntryRead)
def update_feynman_entry(
    entry_id: int,
    payload: FeynmanEntryUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FeynmanEntryRead:
    entry = _get_owned_entry(entry_id, current_user, db)
    data = payload.model_dump(exclude_unset=True)
    if "project_id" in data:
        _validate_project_id(data["project_id"], current_user, db)
    # Tag list lives in the link table; pull it out of the generic
    # setattr loop. Absent → no change; present (even empty) → replace.
    has_tag_field = "tag_names" in data
    tag_payload = data.pop("tag_names", None)
    for field_name, field_value in data.items():
        setattr(entry, field_name, field_value)
    if has_tag_field:
        replace_item_tags(
            current_user.id, TAG_ITEM_FEYNMAN_ENTRY, entry.id,
            parse_tag_input(tag_payload) if tag_payload is not None else [],
            db,
        )
    db.commit()
    db.refresh(entry)
    return _serialize_with_tags([entry], current_user, db)[0]


@router.delete("/{entry_id}", status_code=204)
def delete_feynman_entry(
    entry_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    entry = _get_owned_entry(entry_id, current_user, db)
    delete_links_for_item(TAG_ITEM_FEYNMAN_ENTRY, entry.id, db)
    db.delete(entry)
    db.commit()
