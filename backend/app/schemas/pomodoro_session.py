"""Pydantic schemas for Pomodoro sessions."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class PomodoroSessionStart(BaseModel):
    """Payload to start a new Pomodoro session."""

    session_type: Literal["work", "break"] = "work"
    # Upper bound matches the per-user work-minutes cap in UserUpdate so a
    # user who configures a long work block (e.g. 90+ min) can actually start it.
    duration_minutes: int = Field(default=25, ge=1, le=240)


class PomodoroSessionComplete(BaseModel):
    """Payload to mark a session as completed."""

    ended_at: datetime | None = None


class PomodoroSessionRead(BaseModel):
    """Public representation of a Pomodoro session."""

    id: int
    user_id: int
    session_type: str
    duration_minutes: int
    is_completed: bool
    started_at: datetime
    ended_at: datetime | None

    model_config = {"from_attributes": True}
