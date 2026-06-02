"""Pydantic schemas for projects."""

from datetime import date

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema, UtcDateTime
from app.schemas.paper_note import PaperInsightRead


class ProjectCreate(BaseModel):
    """Payload to create a project."""

    name: str = Field(..., min_length=1, max_length=100)
    color: str = Field(default="", max_length=7, pattern=r"^(#[0-9A-Fa-f]{6})?$")
    research_question: str = ""
    milestone: str = ""
    advisor_meeting_date: date | None = None
    blocker: str = ""


class ProjectUpdate(BaseModel):
    """Payload to partially update a project."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    color: str | None = Field(default=None, max_length=7, pattern=r"^(#[0-9A-Fa-f]{6})?$")
    is_archived: bool | None = None
    research_question: str | None = None
    milestone: str | None = None
    advisor_meeting_date: date | None = None
    blocker: str | None = None


class ProjectRead(BaseSchema):
    """Public representation of a project."""

    id: int
    user_id: int
    name: str
    color: str
    is_archived: bool
    research_question: str = ""
    milestone: str = ""
    advisor_meeting_date: date | None = None
    blocker: str = ""
    created_at: UtcDateTime
    updated_at: UtcDateTime


class ProjectDashboardTask(BaseSchema):
    id: int
    text: str
    planned_date: date | None = None
    due_date: date | None = None


class ProjectDashboardPaper(BaseSchema):
    id: int
    title: str
    reading_status: str
    reading_minutes: int = 0


class ProjectDashboardGap(BaseSchema):
    id: int
    concept: str
    gaps: str


class ProjectDashboardRead(BaseModel):
    project: ProjectRead
    weekly_focus_minutes: int
    open_tasks: list[ProjectDashboardTask]
    reading_queue: list[ProjectDashboardPaper]
    unresolved_gaps: list[ProjectDashboardGap]
    recent_insights: list[PaperInsightRead]
