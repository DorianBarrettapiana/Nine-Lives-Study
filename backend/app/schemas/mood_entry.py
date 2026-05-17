"""Pydantic schemas for mood entries."""

from datetime import datetime

from pydantic import BaseModel


class MoodEntryCreate(BaseModel):
    mood: str
    reflection: str = ""


class MoodEntryRead(BaseModel):
    id: int
    user_id: int
    mood: str
    reflection: str
    created_at: datetime

    model_config = {"from_attributes": True}
