"""Pydantic schemas for user data."""

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas._base import BaseSchema

# Keep in sync with frontend/src/views/avatar.ts CAT_SKINS.
CatSkin = Literal[
    "tabby", "black", "white", "gray", "calico", "siamese",
    "tortie", "ragdoll", "cow",
]


class UserCreate(BaseModel):
    """Payload used to create a new user."""

    username: str = Field(..., min_length=1, max_length=100)
    language: str = Field(default="en", max_length=10)
    theme: str = Field(default="dark", max_length=20)


class UserUpdate(BaseModel):
    """Payload used to partially update a user."""

    language: str | None = Field(default=None, max_length=10)
    theme: str | None = Field(default=None, max_length=20)
    is_active: bool | None = None

    # Pomodoro settings
    pomodoro_work_minutes: int | None = Field(default=None, ge=1, le=240)
    pomodoro_short_break_minutes: int | None = Field(default=None, ge=1, le=60)
    pomodoro_long_break_minutes: int | None = Field(default=None, ge=1, le=60)
    pomodoro_sessions_before_long_break: int | None = Field(default=None, ge=1, le=10)

    cat_skin: CatSkin | None = None

    # Daily work-time goal, 15 min – 12 h.
    daily_goal_minutes: int | None = Field(default=None, ge=15, le=720)
    motto: str | None = Field(default=None, max_length=140)
    share_study_time: bool | None = None
    share_activity: bool | None = None
    share_project: bool | None = None


class UserRead(BaseSchema):
    """Public representation of a user."""

    id: int
    username: str
    language: str
    theme: str
    is_active: bool

    pomodoro_work_minutes: int
    pomodoro_short_break_minutes: int
    pomodoro_long_break_minutes: int
    pomodoro_sessions_before_long_break: int

    cat_skin: str
    # Minutes of accumulated study time (pomodoro + stopwatch) since the
    # last skin change. The 30h lock unlocks when this hits required.
    cat_skin_minutes_accumulated: int = 0
    cat_skin_minutes_required: int = 1800
    # Free skin-change coupons (default 1; refilled by rules later).
    cat_skin_free_changes: int = 0

    # Daily work-time goal — surfaced so the picker UI can read/write it.
    daily_goal_minutes: int = 120
    motto: str = ""
    share_study_time: bool = True
    share_activity: bool = True
    share_project: bool = False
