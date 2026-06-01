"""Tag normalization, resolution, and link-replacement helpers.

These are shared between the /tags routes and the per-module routes
(paper notes, Feynman, daily tasks) that accept a `tag_names` list on
create/update. Keeping the logic in one place means the normalization
rule, the "create on demand" semantics, and the cross-module link
replacement all behave identically wherever the user types a tag.
"""

from __future__ import annotations

import re

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.tag import Tag, TagLink
from app.schemas.tag import TagSummary

_WS = re.compile(r"\s+")
# Allowed item_type discriminators; keep in sync with app/models/tag.py.
_ALLOWED_ITEM_TYPES = {"paper_note", "feynman_entry", "daily_task"}


def normalize_tag(name: str) -> str:
    """Return the casefolded, whitespace-collapsed lookup key for a tag.

    Empty / whitespace-only input returns "" — callers should treat
    that as "no tag, skip" rather than creating a zero-name row.
    """
    return _WS.sub(" ", name.strip()).casefold()


def parse_tag_input(raw: object) -> list[str]:
    """Coerce a tag list payload into clean display names.

    Accepts either a list of strings (preferred) or a comma-separated
    string (legacy / convenience). Returns a list of stripped, unique-
    by-normalized-form names, preserving the order of first appearance
    and using the first-seen casing as the display form.
    """
    if raw is None:
        return []
    items: list[str] = []
    if isinstance(raw, str):
        items = [chunk for chunk in raw.split(",")]
    elif isinstance(raw, list):
        items = [str(chunk) for chunk in raw]
    else:
        return []

    seen: set[str] = set()
    out: list[str] = []
    for chunk in items:
        display = _WS.sub(" ", chunk.strip())
        if not display:
            continue
        key = display.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(display)
    return out


def resolve_or_create_tags(
    user_id: int, names: list[str], db: Session,
) -> list[Tag]:
    """Return the user's Tag rows matching `names`, creating any missing.

    Preserves the order of `names`. Names that normalize to the same key
    deduplicate. Uses one bulk SELECT + at most one INSERT per missing
    tag; safe to call inside a route's existing transaction (no
    intermediate commit).
    """
    if not names:
        return []
    by_key: dict[str, str] = {}  # normalized -> display name
    order: list[str] = []
    for display in names:
        key = normalize_tag(display)
        if not key or key in by_key:
            continue
        by_key[key] = display
        order.append(key)

    existing = list(db.scalars(
        select(Tag)
        .where(Tag.user_id == user_id)
        .where(Tag.normalized_name.in_(list(by_key.keys())))
    ).all())
    by_norm: dict[str, Tag] = {t.normalized_name: t for t in existing}

    for key in order:
        if key in by_norm:
            continue
        tag = Tag(
            user_id=user_id,
            name=by_key[key],
            normalized_name=key,
            color="",
        )
        db.add(tag)
        db.flush()
        by_norm[key] = tag

    return [by_norm[k] for k in order]


def replace_item_tags(
    user_id: int,
    item_type: str,
    item_id: int,
    names: list[str],
    db: Session,
) -> list[Tag]:
    """Set the tags attached to one item to exactly `names`.

    Deletes any existing links not in the new set, creates any missing.
    Returns the final ordered list of Tag rows. The caller is responsible
    for committing the surrounding transaction.
    """
    if item_type not in _ALLOWED_ITEM_TYPES:
        raise ValueError(f"Unknown tag item_type: {item_type!r}")

    tags = resolve_or_create_tags(user_id, names, db)
    keep_ids = {t.id for t in tags}

    # Drop links for this item that are no longer in the new set.
    # Scope by joining through Tag.user_id so a forged item_id can't
    # delete another user's link rows.
    stale_subq = (
        select(TagLink.id)
        .join(Tag, Tag.id == TagLink.tag_id)
        .where(Tag.user_id == user_id)
        .where(TagLink.item_type == item_type)
        .where(TagLink.item_id == item_id)
    )
    if keep_ids:
        stale_subq = stale_subq.where(TagLink.tag_id.notin_(keep_ids))
    db.execute(delete(TagLink).where(TagLink.id.in_(stale_subq.scalar_subquery())))

    if not tags:
        return []

    # Insert any links that don't yet exist. Bulk-fetch the current
    # tag_ids attached to this item to skip already-present rows.
    present = set(db.scalars(
        select(TagLink.tag_id)
        .where(TagLink.item_type == item_type)
        .where(TagLink.item_id == item_id)
        .where(TagLink.tag_id.in_(keep_ids))
    ).all())
    for tag in tags:
        if tag.id in present:
            continue
        db.add(TagLink(tag_id=tag.id, item_type=item_type, item_id=item_id))
    db.flush()
    return tags


def fetch_tags_for_items(
    user_id: int,
    item_type: str,
    item_ids: list[int],
    db: Session,
) -> dict[int, list[TagSummary]]:
    """Return {item_id: [TagSummary, ...]} for a batch of items.

    Order within each list is by Tag.name (case-insensitive) for stable
    rendering. Items with no tags get an empty list (not omitted) so the
    caller can simply `.get(id, [])`.
    """
    if not item_ids:
        return {}
    rows = db.execute(
        select(TagLink.item_id, Tag)
        .join(Tag, Tag.id == TagLink.tag_id)
        .where(Tag.user_id == user_id)
        .where(TagLink.item_type == item_type)
        .where(TagLink.item_id.in_(item_ids))
        .order_by(Tag.normalized_name.asc())
    ).all()
    out: dict[int, list[TagSummary]] = {iid: [] for iid in item_ids}
    for iid, tag in rows:
        out.setdefault(iid, []).append(
            TagSummary(id=tag.id, name=tag.name, color=tag.color)
        )
    return out


def delete_links_for_item(
    item_type: str, item_id: int, db: Session,
) -> None:
    """Remove all tag_links pointing at one item. Call before deleting it.

    Does NOT delete the Tag rows themselves — a tag with zero links
    survives as an empty label the user can re-attach. The /tags DELETE
    route is the place to drop unused tags.
    """
    db.execute(
        delete(TagLink)
        .where(TagLink.item_type == item_type)
        .where(TagLink.item_id == item_id)
    )
