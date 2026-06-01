"""Tag routes (scoped to current user).

Exposes the cross-module tag cloud, item attachment counts, and the
per-tag item drill-down used by the tag-browse view. Per-item tag
editing happens through the existing module endpoints (notes / Feynman /
tasks) by passing `tag_names`, not through this router — that keeps the
write path next to the item's other validation.
"""

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.tags import normalize_tag
from app.models.daily_tracker import DailyTask
from app.models.feynman_entry import FeynmanEntry
from app.models.paper_note import PaperNote
from app.models.tag import (
    TAG_ITEM_DAILY_TASK,
    TAG_ITEM_FEYNMAN_ENTRY,
    TAG_ITEM_PAPER_NOTE,
    Tag,
    TagLink,
)
from app.models.user import User
from app.schemas.daily_tracker import DailyTaskRead
from app.schemas.feynman_entry import FeynmanEntryRead
from app.schemas.paper_note import PaperNoteRead
from app.schemas.tag import TagCreate, TagRead, TagUpdate
from pydantic import BaseModel

router = APIRouter(prefix="/tags", tags=["tags"])


def _get_owned_tag(tag_id: int, current_user: User, db: Session) -> Tag:
    tag = db.get(Tag, tag_id)
    if tag is None or tag.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found.",
        )
    return tag


def _counts_by_tag(user_id: int, db: Session) -> dict[int, dict[str, int]]:
    """Return {tag_id: {item_type: count}} for the user's tags.

    Filters out tag_links whose item_id no longer exists in the source
    table. This keeps the cloud honest after a note/Feynman/task delete
    that for some reason didn't clean its links (defense-in-depth — the
    delete paths DO clean them, but a stale link must never inflate a
    count visible to the user).
    """
    out: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    def _count(item_type: str, model_cls) -> None:
        stmt = (
            select(TagLink.tag_id, func.count(TagLink.id))
            .join(Tag, Tag.id == TagLink.tag_id)
            .join(model_cls, model_cls.id == TagLink.item_id)
            .where(Tag.user_id == user_id)
            .where(model_cls.user_id == user_id)
            .where(TagLink.item_type == item_type)
            .group_by(TagLink.tag_id)
        )
        for tag_id, count in db.execute(stmt).all():
            out[tag_id][item_type] = int(count)

    _count(TAG_ITEM_PAPER_NOTE, PaperNote)
    _count(TAG_ITEM_FEYNMAN_ENTRY, FeynmanEntry)
    _count(TAG_ITEM_DAILY_TASK, DailyTask)
    return out


def _tag_to_read(tag: Tag, counts: dict[str, int]) -> TagRead:
    pn = counts.get(TAG_ITEM_PAPER_NOTE, 0)
    fy = counts.get(TAG_ITEM_FEYNMAN_ENTRY, 0)
    dt = counts.get(TAG_ITEM_DAILY_TASK, 0)
    return TagRead(
        id=tag.id,
        user_id=tag.user_id,
        name=tag.name,
        color=tag.color,
        use_count=pn + fy + dt,
        paper_note_count=pn,
        feynman_entry_count=fy,
        daily_task_count=dt,
        created_at=tag.created_at,
        updated_at=tag.updated_at,
    )


@router.get("", response_model=list[TagRead])
def list_tags(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[TagRead]:
    """List the user's tags with per-module counts.

    Returned sorted by total use_count desc, then name asc. Includes
    zero-use tags (e.g. ones the user just renamed an item away from)
    so they remain editable.
    """
    tags = list(db.scalars(
        select(Tag).where(Tag.user_id == current_user.id)
    ).all())
    counts = _counts_by_tag(current_user.id, db)
    reads = [_tag_to_read(t, counts.get(t.id, {})) for t in tags]
    reads.sort(key=lambda r: (-r.use_count, r.name.casefold()))
    return reads


@router.post("", response_model=TagRead, status_code=201)
def create_tag(
    payload: TagCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TagRead:
    """Create a standalone tag (no item attachment yet).

    Used when the user wants to define a tag (color, casing) before
    attaching it to anything. Most tags are created implicitly when the
    user types a new name into an item form — that path goes through
    `app.core.tags.resolve_or_create_tags`.
    """
    norm = normalize_tag(payload.name)
    if not norm:
        raise HTTPException(status_code=400, detail="Tag name cannot be blank.")
    existing = db.scalar(
        select(Tag)
        .where(Tag.user_id == current_user.id)
        .where(Tag.normalized_name == norm)
    )
    if existing is not None:
        raise HTTPException(status_code=409, detail="Tag already exists.")
    tag = Tag(
        user_id=current_user.id,
        name=payload.name.strip(),
        normalized_name=norm,
        color=payload.color,
    )
    db.add(tag)
    db.commit()
    db.refresh(tag)
    return _tag_to_read(tag, {})


@router.patch("/{tag_id}", response_model=TagRead)
def update_tag(
    tag_id: int,
    payload: TagUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TagRead:
    """Rename or recolor a tag. Rename updates the normalized key too."""
    tag = _get_owned_tag(tag_id, current_user, db)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        name = data["name"].strip()
        norm = normalize_tag(name)
        if not norm:
            raise HTTPException(status_code=400, detail="Tag name cannot be blank.")
        # Conflict only if a *different* tag of the same user already
        # owns the new normalized name.
        clash = db.scalar(
            select(Tag)
            .where(Tag.user_id == current_user.id)
            .where(Tag.normalized_name == norm)
            .where(Tag.id != tag.id)
        )
        if clash is not None:
            raise HTTPException(status_code=409, detail="Another tag already uses that name.")
        tag.name = name
        tag.normalized_name = norm
    if "color" in data and data["color"] is not None:
        tag.color = data["color"]
    db.commit()
    db.refresh(tag)
    counts = _counts_by_tag(current_user.id, db).get(tag.id, {})
    return _tag_to_read(tag, counts)


@router.delete("/{tag_id}", status_code=204)
def delete_tag(
    tag_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Delete a tag and all its links (cascade)."""
    tag = _get_owned_tag(tag_id, current_user, db)
    db.execute(delete(TagLink).where(TagLink.tag_id == tag.id))
    db.delete(tag)
    db.commit()


class TagItemsRead(BaseModel):
    """Drill-down of one tag's referenced items, grouped by type."""

    tag: TagRead
    paper_notes: list[PaperNoteRead]
    feynman_entries: list[FeynmanEntryRead]
    daily_tasks: list[DailyTaskRead]


@router.get("/{tag_id}/items", response_model=TagItemsRead)
def get_tag_items(
    tag_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TagItemsRead:
    """List all items the current user has tagged with this tag."""
    tag = _get_owned_tag(tag_id, current_user, db)

    def _ids(item_type: str) -> list[int]:
        return list(db.scalars(
            select(TagLink.item_id)
            .where(TagLink.tag_id == tag.id)
            .where(TagLink.item_type == item_type)
        ).all())

    note_ids = _ids(TAG_ITEM_PAPER_NOTE)
    feynman_ids = _ids(TAG_ITEM_FEYNMAN_ENTRY)
    task_ids = _ids(TAG_ITEM_DAILY_TASK)

    notes = list(db.scalars(
        select(PaperNote)
        .where(PaperNote.user_id == current_user.id)
        .where(PaperNote.id.in_(note_ids))
        .order_by(PaperNote.updated_at.desc())
    ).all()) if note_ids else []
    for n in notes:
        n.reading_minutes = 0  # cheap default; full attribution happens in /notes

    feynman = list(db.scalars(
        select(FeynmanEntry)
        .where(FeynmanEntry.user_id == current_user.id)
        .where(FeynmanEntry.id.in_(feynman_ids))
        .order_by(FeynmanEntry.updated_at.desc())
    ).all()) if feynman_ids else []

    tasks = list(db.scalars(
        select(DailyTask)
        .where(DailyTask.user_id == current_user.id)
        .where(DailyTask.id.in_(task_ids))
        .order_by(DailyTask.task_date.desc())
    ).all()) if task_ids else []

    counts = _counts_by_tag(current_user.id, db).get(tag.id, {})
    return TagItemsRead(
        tag=_tag_to_read(tag, counts),
        paper_notes=[PaperNoteRead.model_validate(n) for n in notes],
        feynman_entries=[FeynmanEntryRead.model_validate(e) for e in feynman],
        daily_tasks=[DailyTaskRead.model_validate(t) for t in tasks],
    )
