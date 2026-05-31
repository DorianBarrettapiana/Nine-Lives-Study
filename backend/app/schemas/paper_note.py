"""Pydantic schemas for paper notes."""

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema, UtcDateTime


class PaperNoteCreate(BaseModel):
    """Payload used to create a paper note."""

    title: str = Field(..., min_length=1, max_length=300)
    authors: str = Field(default="", max_length=500)
    year: int | None = Field(default=None, ge=0, le=3000)
    key_points: str = ""
    questions: str = ""
    tags: str = Field(default="", max_length=500)
    doi: str = Field(default="", max_length=300)
    url: str = Field(default="", max_length=1000)
    feynman_entry_id: int | None = None


class PaperNoteUpdate(BaseModel):
    """Payload used to update a paper note."""

    title: str | None = Field(default=None, min_length=1, max_length=300)
    authors: str | None = Field(default=None, max_length=500)
    year: int | None = Field(default=None, ge=0, le=3000)
    key_points: str | None = None
    questions: str | None = None
    tags: str | None = Field(default=None, max_length=500)
    doi: str | None = Field(default=None, max_length=300)
    url: str | None = Field(default=None, max_length=1000)
    feynman_entry_id: int | None = None


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
    doi: str
    url: str
    feynman_entry_id: int | None
    created_at: UtcDateTime
    updated_at: UtcDateTime
