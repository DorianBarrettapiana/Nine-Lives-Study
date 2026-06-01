"""Pydantic schemas for Feynman entries."""

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema, UtcDateTime
from app.schemas.tag import TagSummary


class FeynmanEntryCreate(BaseModel):
    """Payload used to create a Feynman entry."""

    concept: str = Field(..., min_length=1, max_length=300)
    explanation: str = ""
    gaps: str = ""
    analogy: str = ""
    project_id: int | None = None
    tag_names: list[str] | None = None


class FeynmanEntryUpdate(BaseModel):
    """Payload used to update a Feynman entry."""

    concept: str | None = Field(default=None, min_length=1, max_length=300)
    explanation: str | None = None
    gaps: str | None = None
    analogy: str | None = None
    project_id: int | None = None
    tag_names: list[str] | None = None


class FeynmanEntryRead(BaseSchema):
    """Public representation of a Feynman entry."""

    id: int
    user_id: int
    concept: str
    explanation: str
    gaps: str
    analogy: str
    project_id: int | None = None
    tag_list: list[TagSummary] = []
    created_at: UtcDateTime
    updated_at: UtcDateTime
