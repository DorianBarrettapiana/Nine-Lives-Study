"""Note-link ORM model — polymorphic `[[Title]]` references between items.

One row per resolved `[[Some Title]]` in a write surface (paper note's
key_points / questions / abstract; Feynman's explanation / gaps /
analogy). Stored as (src_type, src_id, dst_type, dst_id) so the same
table answers both forward ("what does this note cite?") and reverse
("what cites me?") in one index.

The resolver in app.core.links scans the text on save, matches against
the user's own PaperNote.title and FeynmanEntry.concept (case-folded
exact), then upserts the link set so re-saves don't drift.

Scoping is enforced via Tag-style join: every query filters by
`user_id` on both sides, so a stale link from a since-deleted item
can't leak across users. Delete paths drop rows where either end
matches; see `app.core.links.delete_links_for_item`.
"""

from datetime import datetime, timezone

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# Discriminator constants. Mirror the strings in app/core/links.py and
# the Literal in app/schemas/note_link.py — single source of truth.
LINK_ITEM_PAPER_NOTE = "paper_note"
LINK_ITEM_FEYNMAN_ENTRY = "feynman_entry"


def utc_now() -> datetime:
    """Return the current UTC datetime."""
    return datetime.now(timezone.utc)


class NoteLink(Base):
    """One `[[Title]]` reference from a source item to a target item."""

    __tablename__ = "note_links"
    __table_args__ = (
        # One link per (src item, dst item) — re-saving the same text
        # is a no-op rather than duplicating rows. The resolver uses
        # this constraint to dedupe `[[X]] [[X]]` in the same body.
        UniqueConstraint(
            "src_type", "src_id", "dst_type", "dst_id",
            name="uq_note_links_src_dst",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    # Owner — denormalized for fast user-scoped queries; both ends of
    # the link must belong to the same user (enforced by the resolver).
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    # Source: the item whose text contained the `[[...]]` token.
    src_type: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    src_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)

    # Destination: the item the title matched. Indexed so the backlinks
    # query (the whole reason this table exists) is one B-tree seek.
    dst_type: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    dst_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)

    # The literal text inside the brackets, preserved for display.
    # We resolve case-insensitively but show what the user actually
    # typed in the backlink snippet column.
    label: Mapped[str] = mapped_column(String(300), default="", nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(),
        default=utc_now,
        nullable=False,
    )
