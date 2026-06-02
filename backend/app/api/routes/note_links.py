"""Backlinks / outgoing-links routes.

Per-item write paths (the `[[Title]]` parsing) live in the existing
notes / Feynman routers — those edit `NoteLink` rows whenever the
user saves an item. This router is read-only: given (item_type,
item_id), return who cites me and whom I cite.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.feynman_entry import FeynmanEntry
from app.models.note_link import (
    LINK_ITEM_FEYNMAN_ENTRY,
    LINK_ITEM_PAPER_NOTE,
    NoteLink,
)
from app.models.paper_note import PaperNote
from app.models.user import User
from app.schemas.note_link import (
    BacklinkEntry,
    BacklinksRead,
    LinkedItemRef,
    LinkItemType,
    OutgoingLink,
)

router = APIRouter(prefix="/links", tags=["links"])


def _verify_item_owned(
    item_type: LinkItemType, item_id: int, current_user: User, db: Session,
) -> None:
    """404 if the (type, id) pair doesn't belong to the current user."""
    if item_type == LINK_ITEM_PAPER_NOTE:
        row = db.get(PaperNote, item_id)
        if row is None or row.user_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found.")
    elif item_type == LINK_ITEM_FEYNMAN_ENTRY:
        row = db.get(FeynmanEntry, item_id)
        if row is None or row.user_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found.")
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown item_type.")


def _titles_for(
    user_id: int, item_type: LinkItemType, ids: list[int], db: Session,
) -> dict[int, str]:
    """Bulk-resolve item ids → display title for the backlinks/outgoing renderer."""
    if not ids:
        return {}
    if item_type == LINK_ITEM_PAPER_NOTE:
        rows = db.execute(
            select(PaperNote.id, PaperNote.title)
            .where(PaperNote.user_id == user_id)
            .where(PaperNote.id.in_(ids))
        ).all()
    else:
        rows = db.execute(
            select(FeynmanEntry.id, FeynmanEntry.concept)
            .where(FeynmanEntry.user_id == user_id)
            .where(FeynmanEntry.id.in_(ids))
        ).all()
    return {iid: title for iid, title in rows}


@router.get("", response_model=BacklinksRead)
def get_links(
    item_type: LinkItemType = Query(...),
    item_id: int = Query(..., ge=1),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BacklinksRead:
    """Return both directions of links touching (item_type, item_id)."""
    _verify_item_owned(item_type, item_id, current_user, db)

    incoming_rows = list(db.scalars(
        select(NoteLink)
        .where(NoteLink.user_id == current_user.id)
        .where(NoteLink.dst_type == item_type)
        .where(NoteLink.dst_id == item_id)
    ).all())

    outgoing_rows = list(db.scalars(
        select(NoteLink)
        .where(NoteLink.user_id == current_user.id)
        .where(NoteLink.src_type == item_type)
        .where(NoteLink.src_id == item_id)
    ).all())

    # Bulk-fetch titles for both sides in two queries each, then build refs.
    inc_pn_ids = [r.src_id for r in incoming_rows if r.src_type == LINK_ITEM_PAPER_NOTE]
    inc_fy_ids = [r.src_id for r in incoming_rows if r.src_type == LINK_ITEM_FEYNMAN_ENTRY]
    out_pn_ids = [r.dst_id for r in outgoing_rows if r.dst_type == LINK_ITEM_PAPER_NOTE]
    out_fy_ids = [r.dst_id for r in outgoing_rows if r.dst_type == LINK_ITEM_FEYNMAN_ENTRY]
    pn_titles = {
        **_titles_for(current_user.id, LINK_ITEM_PAPER_NOTE, list(set(inc_pn_ids + out_pn_ids)), db),
    }
    fy_titles = {
        **_titles_for(current_user.id, LINK_ITEM_FEYNMAN_ENTRY, list(set(inc_fy_ids + out_fy_ids)), db),
    }

    def _ref(t: str, i: int) -> LinkedItemRef | None:
        title = (pn_titles if t == LINK_ITEM_PAPER_NOTE else fy_titles).get(i)
        if title is None:
            # Linked target was deleted out from under us — drop the row
            # from the response so the UI doesn't render a tombstone.
            return None
        return LinkedItemRef(item_type=t, item_id=i, title=title)

    backlinks: list[BacklinkEntry] = []
    for row in incoming_rows:
        ref = _ref(row.src_type, row.src_id)
        if ref is None:
            continue
        backlinks.append(BacklinkEntry(source=ref, label=row.label))

    outgoing: list[OutgoingLink] = []
    for row in outgoing_rows:
        ref = _ref(row.dst_type, row.dst_id)
        if ref is None:
            continue
        outgoing.append(OutgoingLink(target=ref, label=row.label))

    # Stable order: alphabetical by title for both panels.
    backlinks.sort(key=lambda b: b.source.title.casefold())
    outgoing.sort(key=lambda o: o.target.title.casefold())
    return BacklinksRead(backlinks=backlinks, outgoing=outgoing)
