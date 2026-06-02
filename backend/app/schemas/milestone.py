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
    # Optional: when present, must point to another milestone owned by
    # the same user. Used by the backplanning bulk-create endpoint to
    # attach check-points to a parent in one round-trip.
    parent_milestone_id: int | None = None


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
    parent_milestone_id: int | None = None


class MilestoneRead(BaseSchema):
    """Public representation of a milestone."""

    id: int
    user_id: int
    title: str
    due_date: date
    project_id: int | None = None
    notes: str
    is_archived: bool
    parent_milestone_id: int | None = None
    created_at: UtcDateTime
    updated_at: UtcDateTime


# ---------------------------------------------------------------------------
# Backplanning
# ---------------------------------------------------------------------------


class MilestoneSuggestion(BaseModel):
    """One suggested intermediate check-point for the user to review.

    Suggestions are deterministic (no LLM): see app.core.backplanning
    for the rule set. The user can edit / drop any item before saving.
    """

    title: str = Field(..., max_length=200)
    due_date: date
    # Free-form tag of which template fired (e.g. "abstract", "defense",
    # "generic"). The UI can group by this or just ignore it.
    template_hint: str = ""


class MilestoneSuggestionsRead(BaseModel):
    """Response payload for GET /milestones/{id}/suggest-children."""

    suggestions: list[MilestoneSuggestion]
    template: str  # which template matched the parent title
    weeks_remaining: int


class BackplanChildren(BaseModel):
    """Bulk-create payload for POST /milestones/{id}/children."""

    children: list[MilestoneSuggestion] = Field(..., min_length=1, max_length=20)
