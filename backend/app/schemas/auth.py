"""Pydantic schemas for authentication."""

from pydantic import BaseModel, Field


class RegisterPayload(BaseModel):
    """Payload for POST /auth/register."""

    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=8, max_length=200)
    invite_code: str = Field(..., min_length=1, max_length=200)
    language: str = Field(default="en", max_length=10)
    theme: str = Field(default="dark", max_length=20)


class LoginPayload(BaseModel):
    """Payload for POST /auth/login."""

    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=1, max_length=200)


class PasswordChangePayload(BaseModel):
    """Payload for POST /auth/password."""

    current_password: str = Field(..., min_length=1, max_length=200)
    new_password: str = Field(..., min_length=8, max_length=200)
