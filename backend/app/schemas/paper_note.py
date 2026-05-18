"""Pydantic schemas for paper notes."""

from datetime import datetime

from pydantic import BaseModel, Field


class PaperNoteCreate(BaseModel):
    """Payload used to create a paper note."""

    title: str = Field(..., min_length=1, max_length=300)
    authors: str = Field(default="", max_length=500)
    year: int | None = Field(default=None, ge=0, le=3000)
    key_points: str = ""
    questions: str = ""
    tags: str = Field(default="", max_length=500)


class PaperNoteUpdate(BaseModel):
    """Payload used to update a paper note."""

    title: str | None = Field(default=None, min_length=1, max_length=300)
    authors: str | None = Field(default=None, max_length=500)
    year: int | None = Field(default=None, ge=0, le=3000)
    key_points: str | None = None
    questions: str | None = None
    tags: str | None = Field(default=None, max_length=500)


class PaperNoteRead(BaseModel):
    """Public representation of a paper note."""

    id: int
    user_id: int
    title: str
    authors: str
    year: int | None
    key_points: str
    questions: str
    tags: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
