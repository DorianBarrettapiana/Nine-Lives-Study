"""Pydantic schemas for tags."""

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema, UtcDateTime

# Keep in sync with the discriminator constants in app/models/tag.py.
TagItemType = Literal["paper_note", "feynman_entry", "daily_task"]


class TagCreate(BaseModel):
    """Payload to create a tag."""

    name: str = Field(..., min_length=1, max_length=60)
    color: str = Field(default="", max_length=7, pattern=r"^(#[0-9A-Fa-f]{6})?$")


class TagUpdate(BaseModel):
    """Payload to rename / recolor a tag."""

    name: str | None = Field(default=None, min_length=1, max_length=60)
    color: str | None = Field(default=None, max_length=7, pattern=r"^(#[0-9A-Fa-f]{6})?$")


class TagSummary(BaseSchema):
    """Compact tag representation embedded on tagged items."""

    id: int
    name: str
    color: str


class TagRead(BaseSchema):
    """Public representation of a tag with per-type usage counts."""

    id: int
    user_id: int
    name: str
    color: str
    # Total references across all item types. Convenient for sorting the
    # tag cloud without summing on the client.
    use_count: int = 0
    paper_note_count: int = 0
    feynman_entry_count: int = 0
    daily_task_count: int = 0
    created_at: UtcDateTime
    updated_at: UtcDateTime
