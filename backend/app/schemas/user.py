"""Pydantic schemas for user data."""

from pydantic import BaseModel, Field


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


class UserRead(BaseModel):
    """Public representation of a user."""

    id: int
    username: str
    language: str
    theme: str
    is_active: bool

    model_config = {"from_attributes": True}