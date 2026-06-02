"""Pydantic schemas for the daily tracker."""

from datetime import date

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema, UtcDateTime
from app.schemas.tag import TagSummary


class DailyTaskCreate(BaseModel):
    """Payload used to create a daily task."""

    text: str = Field(..., min_length=1, max_length=500)
    task_date: date | None = None
    # PR1 unification fields. Either `task_date` or `planned_date` may be
    # passed; the route mirrors them into both columns so old clients keep
    # working while new clients can use the more accurate "planned" name.
    planned_date: date | None = None
    due_date: date | None = None
    project_id: int | None = None
    paper_note_id: int | None = None
    tag_names: list[str] | None = None
    # Backlog flag: when True the task is created with no planned_date (it
    # doesn't show up in any day's Today list until scheduled). Used by the
    # "add a task from a project" flow. Ignored if planned_date/task_date is
    # also supplied — an explicit date always wins.
    unplanned: bool = False


class DailyTaskUpdate(BaseModel):
    """Payload used to update a daily task."""

    text: str | None = Field(default=None, min_length=1, max_length=500)
    is_done: bool | None = None
    # User-controlled position within the day's list. The PATCH endpoint
    # accepts a float so the frontend can compute "between neighbors" via
    # the midpoint trick without ever touching other rows.
    sort_order: float | None = None
    # Re-assign or unassign the task's project. `None` in the payload (i.e.
    # field omitted) means "leave unchanged"; explicit JSON null means
    # "unassign". Pydantic's exclude_unset distinguishes these two cases
    # in the route handler.
    project_id: int | None = None
    planned_date: date | None = None
    due_date: date | None = None
    tag_names: list[str] | None = None


class DailyTaskRead(BaseSchema):
    """Public representation of a daily task."""

    id: int
    user_id: int
    task_date: date
    # Mirrors task_date for legacy rows; new rows can set this independently.
    planned_date: date | None = None
    due_date: date | None = None
    text: str
    is_done: bool
    sort_order: float = 0
    project_id: int | None = None
    paper_note_id: int | None = None
    tag_list: list[TagSummary] = []
    created_at: UtcDateTime
    updated_at: UtcDateTime


class DailyLogUpsert(BaseModel):
    """Payload used to create or update a daily log."""

    log_date: date | None = None
    main_goal: str | None = Field(default=None, max_length=500)
    # Preferred over `main_goal` text — points at the user's own task.
    # Validated server-side. None = leave unchanged on update; explicit
    # JSON null in payload = unassign (PUT semantics here treat absence
    # the same as None, since this endpoint is upsert-style).
    main_goal_task_id: int | None = None
    mood: str = Field(default="", max_length=20)
    reflection: str = ""


class DailyLogRead(BaseSchema):
    """Public representation of a daily log."""

    id: int
    user_id: int
    log_date: date
    main_goal: str
    main_goal_task_id: int | None = None
    mood: str
    reflection: str
    created_at: UtcDateTime
    updated_at: UtcDateTime


class DailyStateRead(BaseModel):
    """Daily tracker state for one user and one date."""

    date: date
    tasks: list[DailyTaskRead]
    log: DailyLogRead | None
    done_count: int
    total_count: int
    completion_percent: int
