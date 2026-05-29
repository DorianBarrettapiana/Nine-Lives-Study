"""Pydantic schemas for the daily tracker."""

from datetime import date

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema, UtcDateTime


class DailyTaskCreate(BaseModel):
    """Payload used to create a daily task."""

    text: str = Field(..., min_length=1, max_length=500)
    task_date: date | None = None


class DailyTaskUpdate(BaseModel):
    """Payload used to update a daily task."""

    text: str | None = Field(default=None, min_length=1, max_length=500)
    is_done: bool | None = None
    # User-controlled position within the day's list. The PATCH endpoint
    # accepts a float so the frontend can compute "between neighbors" via
    # the midpoint trick without ever touching other rows.
    sort_order: float | None = None


class DailyTaskRead(BaseSchema):
    """Public representation of a daily task."""

    id: int
    user_id: int
    task_date: date
    text: str
    is_done: bool
    sort_order: float = 0
    created_at: UtcDateTime
    updated_at: UtcDateTime


class DailyLogUpsert(BaseModel):
    """Payload used to create or update a daily log."""

    log_date: date | None = None
    mood: str = Field(default="", max_length=20)
    reflection: str = ""


class DailyLogRead(BaseSchema):
    """Public representation of a daily log."""

    id: int
    user_id: int
    log_date: date
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
