"""Pydantic schemas for user data."""

from typing import Literal

from pydantic import BaseModel, Field

# Keep in sync with frontend/src/views/avatar.ts SKIN_IDS.
CatSkin = Literal["tabby", "black", "white", "gray", "calico", "siamese"]


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


class UserRead(BaseModel):
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

    model_config = {"from_attributes": True}
