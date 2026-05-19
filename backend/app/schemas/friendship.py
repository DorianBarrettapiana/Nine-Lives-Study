"""Pydantic schemas for the friends system."""

from pydantic import BaseModel


class UserSearchResult(BaseModel):
    id: int
    username: str
    cat_skin: str = "tabby"

    model_config = {"from_attributes": True}


class FriendEntry(BaseModel):
    user_id: int
    username: str
    cat_skin: str = "tabby"

    model_config = {"from_attributes": True}


class FriendRequestEntry(BaseModel):
    user_id: int
    username: str
    cat_skin: str = "tabby"

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


class FeedItem(BaseModel):
    id: int
    user_id: int
    username: str
    cat_skin: str = "tabby"
    event_type: str
    amount: int
    created_at: str
    like_count: int
    liked_by_me: bool


class NotificationItem(BaseModel):
    liker_username: str
    liker_cat_skin: str = "tabby"
    event_type: str
    created_at: str


class NotificationsResponse(BaseModel):
    unread_count: int
    items: list[NotificationItem]
