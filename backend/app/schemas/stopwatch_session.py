"""Pydantic schemas for stopwatch sessions."""

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema, UtcDateTime


class StopwatchSessionStart(BaseModel):
    """Optional focus attached when starting a stopwatch."""

    work_label: str = Field(default="", max_length=300)
    linked_task_id: int | None = None


class StopwatchSessionRead(BaseSchema):
    """A stopwatch session — running, paused, or ended."""

    id: int
    started_at: UtcDateTime
    ended_at: UtcDateTime | None
    accumulated_seconds: int
    # ISO timestamp of the current run segment (NULL when paused/ended).
    last_started_at: UtcDateTime | None
    # Convenience: whether the session is currently counting (not paused).
    is_running: bool
    # Convenience: total elapsed seconds (counted + current segment if running).
    elapsed_seconds: int
    work_label: str
    # Optional link to the daily task being worked on. Can be set at Start
    # or PATCHed mid-session (stopwatch is open-ended; users often realize
    # what they're doing only after a bit).
    linked_task_id: int | None = None
