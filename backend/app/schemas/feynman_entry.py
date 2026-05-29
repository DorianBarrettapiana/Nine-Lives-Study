"""Pydantic schemas for Feynman entries."""

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema, UtcDateTime


class FeynmanEntryCreate(BaseModel):
    """Payload used to create a Feynman entry."""

    concept: str = Field(..., min_length=1, max_length=300)
    explanation: str = ""
    gaps: str = ""
    analogy: str = ""


class FeynmanEntryUpdate(BaseModel):
    """Payload used to update a Feynman entry."""

    concept: str | None = Field(default=None, min_length=1, max_length=300)
    explanation: str | None = None
    gaps: str | None = None
    analogy: str | None = None


class FeynmanEntryRead(BaseSchema):
    """Public representation of a Feynman entry."""

    id: int
    user_id: int
    concept: str
    explanation: str
    gaps: str
    analogy: str
    created_at: UtcDateTime
    updated_at: UtcDateTime
