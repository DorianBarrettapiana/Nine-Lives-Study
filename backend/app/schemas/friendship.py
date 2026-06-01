"""Pydantic schemas for the friends system."""

from pydantic import BaseModel

from app.schemas._base import BaseSchema, UtcDateTime


class UserSearchResult(BaseSchema):
    id: int
    username: str
    cat_skin: str = "tabby"


class FriendEntry(BaseSchema):
    user_id: int
    username: str
    cat_skin: str = "tabby"
    # True if the current user has NOT cheered this friend in the last 24h
    # — i.e. the Cheer button is currently available.
    can_cheer: bool = True


class FriendRequestEntry(BaseSchema):
    user_id: int
    username: str
    cat_skin: str = "tabby"


class DailyMinutes(BaseModel):
    date: str
    minutes: int


class FriendStudyStats(BaseModel):
    user_id: int
    username: str
    days: int
    daily_minutes: list[DailyMinutes]
    total_minutes: int


class FeedItem(BaseSchema):
    id: int
    user_id: int
    username: str
    cat_skin: str = "tabby"
    event_type: str
    amount: int
    # Routes pass the raw `datetime` from the DB; BaseSchema serializes it
    # as explicit-UTC ISO so the client doesn't need a tz fallback.
    created_at: "UtcDateTime"  # forward-ref to keep import block minimal
    like_count: int
    liked_by_me: bool
    # Populated only when the event is a work session (task_done /
    # pomodoro_done) AND the owner has share_project enabled. Friends
    # then see `... in <project name>` in the feed line; otherwise this
    # is None and the project is hidden.
    project_name: str | None = None


class NotificationItem(BaseSchema):
    liker_username: str
    liker_cat_skin: str = "tabby"
    event_type: str
    created_at: "UtcDateTime"


class NotificationsResponse(BaseModel):
    unread_count: int
    items: list[NotificationItem]
