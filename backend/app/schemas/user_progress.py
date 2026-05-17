"""Pydantic schemas for user XP progress."""

from pydantic import BaseModel


class UserProgressRead(BaseModel):
    """Public representation of a user's XP and level."""

    user_id: int
    xp: int
    level: int
    xp_in_level: int
    xp_to_next_level: int

    model_config = {"from_attributes": False}
