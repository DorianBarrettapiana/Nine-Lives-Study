"""Pydantic schemas for projects."""

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema, UtcDateTime


class ProjectCreate(BaseModel):
    """Payload to create a project."""

    name: str = Field(..., min_length=1, max_length=100)
    color: str = Field(default="", max_length=7, pattern=r"^(#[0-9A-Fa-f]{6})?$")


class ProjectUpdate(BaseModel):
    """Payload to partially update a project."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    color: str | None = Field(default=None, max_length=7, pattern=r"^(#[0-9A-Fa-f]{6})?$")
    is_archived: bool | None = None


class ProjectRead(BaseSchema):
    """Public representation of a project."""

    id: int
    user_id: int
    name: str
    color: str
    is_archived: bool
    created_at: UtcDateTime
    updated_at: UtcDateTime
