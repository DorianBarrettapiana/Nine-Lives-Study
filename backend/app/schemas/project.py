"""Pydantic schemas for projects."""

from datetime import date

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema, UtcDateTime
from app.schemas.daily_tracker import DailyTaskRead
from app.schemas.feynman_entry import FeynmanEntryRead
from app.schemas.paper_note import PaperInsightRead, PaperNoteRead


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


class ReflectionMention(BaseModel):
    """One match of a project name in a daily reflection text."""

    log_date: date
    snippet: str


class ProjectTaskChildTime(BaseModel):
    """Direct focus time for one optional step under a parent task."""

    id: int
    text: str
    is_done: bool
    minutes: int


class ProjectTaskTime(BaseModel):
    """Rolled-up focus time for one top-level task and its steps."""

    id: int
    text: str
    is_done: bool
    direct_minutes: int
    total_minutes: int
    children: list[ProjectTaskChildTime]


class ProjectDashboardRead(BaseModel):
    """Aggregated "research thread status" for a single project.

    All numeric windows are computed in UTC days — this is a rough
    progress view, not a precise stats report (Stats tab covers that
    in the caller's local timezone). The dashboard intentionally
    duplicates a couple of fields from the stats endpoint rather than
    forcing the UI to make two calls and stitch results.
    """

    project: ProjectRead
    minutes_7d: int
    minutes_30d: int
    done_tasks_7d: int
    open_tasks_count: int
    last_activity_at: UtcDateTime | None = None
    open_tasks: list[DailyTaskRead]
    task_time_breakdown: list[ProjectTaskTime]
    paper_notes: list[PaperNoteRead]
    feynman_entries: list[FeynmanEntryRead]
    recent_reflections: list[ReflectionMention]
    recent_insights: list[PaperInsightRead]
