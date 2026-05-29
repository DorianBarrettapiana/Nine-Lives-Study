"""Pydantic schemas for stopwatch sessions."""

from app.schemas._base import BaseSchema, UtcDateTime


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
