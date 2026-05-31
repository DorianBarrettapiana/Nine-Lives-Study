"""Paper note ORM model."""

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def utc_now() -> datetime:
    """Return the current UTC datetime."""
    return datetime.now(timezone.utc)


class PaperNote(Base):
    """Represent a literature note attached to a user."""

    __tablename__ = "paper_notes"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    authors: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)

    key_points: Mapped[str] = mapped_column(Text, default="", nullable=False)
    questions: Mapped[str] = mapped_column(Text, default="", nullable=False)
    tags: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    feynman_entry_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Reference metadata. Populated automatically on Zotero import; editable
    # by the user for manual notes. All optional.
    item_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    doi: Mapped[str | None] = mapped_column(String(200), nullable=True)
    abstract: Mapped[str | None] = mapped_column(Text, nullable=True)

    # --- Zotero linkage (only set for imported notes) -----------------------
    # `zotero_key` is Zotero's per-item opaque key (8 chars, e.g. "ABCD1234").
    # `zotero_version` is Zotero's monotonic per-library version — we keep it
    # so a future "pull updates" feature can skip unchanged items via
    # `If-Modified-Since-Version`. `source` discriminates manual from
    # zotero-imported notes for the UI badge.
    zotero_key: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    zotero_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(String(20), default="manual", nullable=False)

    # Optional research-thread bucket. See app/models/project.py.
    project_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

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
