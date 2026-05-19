"""Pydantic schemas for stopwatch sessions."""

from datetime import datetime

from pydantic import BaseModel


class StopwatchSessionRead(BaseModel):
    """A stopwatch session — running, paused, or ended."""

    id: int
    started_at: datetime
    ended_at: datetime | None
    accumulated_seconds: int
    # ISO timestamp of the current run segment (NULL when paused/ended).
    last_started_at: datetime | None
    # Convenience: whether the session is currently counting (not paused).
    is_running: bool
    # Convenience: total elapsed seconds (counted + current segment if running).
    elapsed_seconds: int

    model_config = {"from_attributes": True}
