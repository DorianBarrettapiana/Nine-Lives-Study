"""Pydantic schemas for paper notes."""

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema, UtcDateTime

PaperReadingStatus = Literal["inbox", "reading", "summarized", "revisit"]


class PaperNoteCreate(BaseModel):
    """Payload used to create a paper note."""

    title: str = Field(..., min_length=1, max_length=300)
    authors: str = Field(default="", max_length=500)
    year: int | None = Field(default=None, ge=0, le=3000)
    key_points: str = ""
    questions: str = ""
    tags: str = Field(default="", max_length=500)
    # Optional reference metadata — surfaced as collapsible "More fields"
    # in the UI so the manual-entry form stays uncluttered for users who
    # only want title + key ideas.
    item_type: str | None = Field(default=None, max_length=40)
    url: str | None = Field(default=None, max_length=500)
    doi: str | None = Field(default=None, max_length=200)
    abstract: str | None = None
    feynman_entry_id: int | None = None
    project_id: int | None = None
    reading_status: PaperReadingStatus = "inbox"


class PaperNoteUpdate(BaseModel):
    """Payload used to update a paper note."""

    title: str | None = Field(default=None, min_length=1, max_length=300)
    authors: str | None = Field(default=None, max_length=500)
    year: int | None = Field(default=None, ge=0, le=3000)
    key_points: str | None = None
    questions: str | None = None
    tags: str | None = Field(default=None, max_length=500)
    item_type: str | None = Field(default=None, max_length=40)
    url: str | None = Field(default=None, max_length=500)
    doi: str | None = Field(default=None, max_length=200)
    abstract: str | None = None
    feynman_entry_id: int | None = None
    project_id: int | None = None
    reading_status: PaperReadingStatus | None = None


class PaperNoteRead(BaseSchema):
    """Public representation of a paper note."""

    id: int
    user_id: int
    title: str
    authors: str
    year: int | None
    key_points: str
    questions: str
    tags: str
    item_type: str | None = None
    url: str | None = None
    doi: str | None = None
    abstract: str | None = None
    # Zotero linkage — null for manually-created notes. The frontend uses
    # `source` for a "Synced from Zotero" badge, and `zotero_key` to deep-link
    # back into the user's Zotero library.
    zotero_key: str | None = None
    zotero_version: int | None = None
    source: str = "manual"
    feynman_entry_id: int | None = None
    project_id: int | None = None
    reading_status: PaperReadingStatus = "inbox"
    reading_minutes: int = 0
    created_at: UtcDateTime
    updated_at: UtcDateTime
