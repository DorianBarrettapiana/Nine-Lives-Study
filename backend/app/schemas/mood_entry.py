"""Pydantic schemas for mood entries."""

from pydantic import BaseModel

from app.schemas._base import BaseSchema, UtcDateTime


class MoodEntryCreate(BaseModel):
    mood: str
    reflection: str = ""


class MoodEntryRead(BaseSchema):
    id: int
    user_id: int
    mood: str
    reflection: str
    created_at: UtcDateTime
