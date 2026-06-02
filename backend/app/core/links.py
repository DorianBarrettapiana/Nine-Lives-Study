"""`[[Title]]` link parsing + per-item resolution.

Two responsibilities:

1. **Extract** — pull `[[...]]` tokens out of the free-text fields on
   paper notes and Feynman entries. Tokens that don't resolve are
   simply dropped — we don't store dangling links; the user can come
   back later, type the target title, and the next save attaches.

2. **Replace** — for one source item (e.g. one paper note), reconcile
   the persisted `NoteLink` rows to exactly match the current set of
   resolved tokens in its body. Drop stale, insert new, leave the rest.

Resolution is case-folded + whitespace-collapsed exact-match against
the user's own PaperNote.title and FeynmanEntry.concept. If a token
matches both, paper note wins (cited paper is the more common case
in PhD writing; user can disambiguate by renaming).

The route layer drives this — see `update_links_for_paper_note` /
`update_links_for_feynman_entry` and the parallel deletion helper.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.models.feynman_entry import FeynmanEntry
from app.models.note_link import (
    LINK_ITEM_FEYNMAN_ENTRY,
    LINK_ITEM_PAPER_NOTE,
    NoteLink,
)
from app.models.paper_note import PaperNote

_TOKEN_RE = re.compile(r"\[\[([^\]\n]{1,300})\]\]")
_WS = re.compile(r"\s+")
_ALLOWED_TYPES = {LINK_ITEM_PAPER_NOTE, LINK_ITEM_FEYNMAN_ENTRY}


def _normalize(title: str) -> str:
    """Casefold + collapse internal whitespace. Same rule used for tags."""
    return _WS.sub(" ", title.strip()).casefold()


def extract_link_tokens(*texts: str | None) -> list[str]:
    """Return the unique `[[...]]` labels from the concatenated texts.

    Order preserves first-seen-wins; dedupe is by normalized form so
    `[[Diffusion]]` and `[[diffusion]]` count as one link.
    """
    seen: set[str] = set()
    out: list[str] = []
    for text in texts:
        if not text:
            continue
        for match in _TOKEN_RE.finditer(text):
            raw = match.group(1).strip()
            if not raw:
                continue
            key = _normalize(raw)
            if key in seen:
                continue
            seen.add(key)
            out.append(raw)
    return out


def _resolve_titles(
    user_id: int, labels: Iterable[str], db: Session,
) -> dict[str, tuple[str, int]]:
    """Best-match each label to a (dst_type, dst_id) within the user's items.

    PaperNote takes priority over FeynmanEntry on a collision. Unmatched
    labels are absent from the returned dict.
    """
    norm_labels = list({_normalize(lb) for lb in labels if _normalize(lb)})
    if not norm_labels:
        return {}

    # SQLite doesn't expose CASEFOLD; lower() is close enough for the
    # ASCII labels we expect from research-thread naming. The resolver
    # also normalizes the candidate column on the Python side as a
    # belt-and-braces measure for unicode.
    notes = db.scalars(
        select(PaperNote)
        .where(PaperNote.user_id == user_id)
        .where(or_(*[
            PaperNote.title.ilike(lb) for lb in norm_labels
        ]))
    ).all()
    feynman = db.scalars(
        select(FeynmanEntry)
        .where(FeynmanEntry.user_id == user_id)
        .where(or_(*[
            FeynmanEntry.concept.ilike(lb) for lb in norm_labels
        ]))
    ).all()

    out: dict[str, tuple[str, int]] = {}
    # Feynman first, then PaperNote — note overwrites collision so
    # PaperNote wins the tie (last-write semantics on this small dict).
    for e in feynman:
        key = _normalize(e.concept)
        if key:
            out[key] = (LINK_ITEM_FEYNMAN_ENTRY, e.id)
    for n in notes:
        key = _normalize(n.title)
        if key:
            out[key] = (LINK_ITEM_PAPER_NOTE, n.id)
    return out


def replace_links_for_item(
    user_id: int,
    src_type: str,
    src_id: int,
    raw_labels: list[str],
    db: Session,
) -> int:
    """Reconcile `note_links` for one source item to match raw_labels.

    Returns the count of links currently stored after the operation.
    Tokens that don't resolve to a user-owned item are silently dropped
    (no dangling link rows). Self-links (item linking to itself) are
    also dropped — they add noise to the backlinks panel.
    """
    if src_type not in _ALLOWED_TYPES:
        raise ValueError(f"Unknown link src_type: {src_type!r}")

    resolved = _resolve_titles(user_id, raw_labels, db)

    # Build the desired set of (dst_type, dst_id, label) triples. Use
    # the first raw_label that resolved to each target as the display
    # label so re-saves don't churn the column.
    desired: dict[tuple[str, int], str] = {}
    for label in raw_labels:
        key = _normalize(label)
        if key not in resolved:
            continue
        dst = resolved[key]
        if dst == (src_type, src_id):
            continue  # drop self-links
        desired.setdefault(dst, label)

    # Drop anything currently stored that's no longer desired.
    stmt = select(NoteLink).where(
        NoteLink.user_id == user_id,
        NoteLink.src_type == src_type,
        NoteLink.src_id == src_id,
    )
    existing = list(db.scalars(stmt).all())
    existing_by_dst = {(row.dst_type, row.dst_id): row for row in existing}

    for dst, row in existing_by_dst.items():
        if dst not in desired:
            db.delete(row)
        else:
            # Refresh label in case the user changed casing — cheap.
            row.label = desired[dst]

    for dst, label in desired.items():
        if dst in existing_by_dst:
            continue
        db.add(NoteLink(
            user_id=user_id,
            src_type=src_type,
            src_id=src_id,
            dst_type=dst[0],
            dst_id=dst[1],
            label=label,
        ))
    db.flush()
    return len(desired)


def delete_links_touching_item(
    item_type: str, item_id: int, db: Session,
) -> None:
    """Drop every link row where this item is the source OR target.

    Called from the item's DELETE route. Both sides cleaned so the
    backlinks panel on a surviving counterpart doesn't show a phantom
    entry pointing at a tombstone.
    """
    db.execute(
        delete(NoteLink).where(
            or_(
                (NoteLink.src_type == item_type) & (NoteLink.src_id == item_id),
                (NoteLink.dst_type == item_type) & (NoteLink.dst_id == item_id),
            )
        )
    )
