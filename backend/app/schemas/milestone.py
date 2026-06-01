"""Pydantic schemas for milestones."""

from datetime import date

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema, UtcDateTime


class MilestoneCreate(BaseModel):
    """Payload used to create a milestone."""

    title: str = Field(..., min_length=1, max_length=200)
    due_date: date
    project_id: int | None = None
    notes: str = ""


class MilestoneUpdate(BaseModel):
    """Payload used to partially update a milestone.

    Treat `project_id` like the daily_task variant: omitted means
    "leave unchanged", explicit JSON null means "unassign from project".
    """

    title: str | None = Field(default=None, min_length=1, max_length=200)
    due_date: date | None = None
    project_id: int | None = None
    notes: str | None = None
    is_archived: bool | None = None


class MilestoneRead(BaseSchema):
    """Public representation of a milestone."""

    id: int
    user_id: int
    title: str
    due_date: date
    project_id: int | None = None
    notes: str
    is_archived: bool
    created_at: UtcDateTime
    updated_at: UtcDateTime
