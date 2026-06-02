"""Tag ORM models.

A Tag is a cross-module label scoped to a user. The same `#diffusion` can
sit on a paper note, a Feynman entry, and a daily task; the user sees them
together in the tag-browse view.

Two tables:

* `tags` — one row per (user, normalized-name) pair. `name` keeps the
  original casing the user typed first; `normalized_name` is the
  case/whitespace-folded key used for uniqueness and lookup.
* `tag_links` — polymorphic many-to-many. `item_type` is one of the
  string constants below; `item_id` is the row id in that table. We
  don't use a real FK to keep the link table generic; the route layer
  scopes every query through `user_id` (via the Tag join) and the
  source table's owner column, so a stale link can only point to a
  same-user row or be orphaned (harmless — the GET path filters them).
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


def utc_now() -> datetime:
    """Return the current UTC datetime."""
    return datetime.now(timezone.utc)


# Item type discriminators. Keep these in sync with the Literal in
# app/schemas/tag.py and the resolver in app/core/tags.py.
TAG_ITEM_PAPER_NOTE = "paper_note"
TAG_ITEM_FEYNMAN_ENTRY = "feynman_entry"
TAG_ITEM_DAILY_TASK = "daily_task"


class Tag(Base):
    """A user-scoped label."""

    __tablename__ = "tags"
    __table_args__ = (
        UniqueConstraint("user_id", "normalized_name", name="uq_tags_user_norm"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    # `name` is what the UI shows. `normalized_name` is what uniqueness
    # and lookups key on (lowercased, stripped, internal whitespace
    # collapsed to single spaces).
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    normalized_name: Mapped[str] = mapped_column(String(60), nullable=False, index=True)

    # Optional 7-char hex (e.g. "#4f46e5"). Empty = picker assigns a
    # stable color by hash of the normalized name. Same convention as
    # Project.color.
    color: Mapped[str] = mapped_column(String(7), default="", nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(),
        default=utc_now,
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(),
        default=utc_now,
        onupdate=utc_now,
        nullable=False,
    )


class TagLink(Base):
    """One attachment of a tag to a (item_type, item_id) row."""

    __tablename__ = "tag_links"
    __table_args__ = (
        UniqueConstraint(
            "tag_id", "item_type", "item_id", name="uq_tag_links_tag_item",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    tag_id: Mapped[int] = mapped_column(
        ForeignKey("tags.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    # Discriminator + foreign id. Not a real FK on item_id so the link
    # table can target multiple source tables. The /tags routes always
    # join Tag and filter by Tag.user_id, so cross-user leakage is
    # impossible even if a future module forgets to clean up its links.
    item_type: Mapped[str] = mapped_column(String(30), nullable=False)
    item_id: Mapped[int] = mapped_column(Integer, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(),
        default=utc_now,
        nullable=False,
    )
