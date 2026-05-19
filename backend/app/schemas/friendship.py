"""Pydantic schemas for the friends system."""

from pydantic import BaseModel


class UserSearchResult(BaseModel):
    id: int
    username: str

    model_config = {"from_attributes": True}


class FriendEntry(BaseModel):
    user_id: int
    username: str

    model_config = {"from_attributes": True}


class FriendRequestEntry(BaseModel):
    user_id: int
    username: str

    model_config = {"from_attributes": True}


class DailyMinutes(BaseModel):
    date: str
    minutes: int


class FriendStudyStats(BaseModel):
    user_id: int
    username: str
    days: int
    daily_minutes: list[DailyMinutes]
    total_minutes: int
