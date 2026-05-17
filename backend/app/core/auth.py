"""Authentication: password hashing, session management, current_user dep."""

import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Cookie, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session as DbSession

from app.core.config import (
    COOKIE_SECURE,
    SESSION_COOKIE_NAME,
    SESSION_LIFETIME_DAYS,
)
from app.core.database import get_db
from app.models.session import Session as SessionModel
from app.models.user import User


# --- Password hashing -------------------------------------------------------


def hash_password(plain: str) -> str:
    """Hash a plaintext password using bcrypt."""
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Verify a plaintext password against a bcrypt hash."""
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# --- Sessions ---------------------------------------------------------------


def _new_session_id() -> str:
    """Cryptographically random opaque token used as the cookie value."""
    return secrets.token_urlsafe(32)


def create_session(user_id: int, db: DbSession) -> SessionModel:
    """Insert a new session row for the given user."""
    now = datetime.now(timezone.utc)
    session = SessionModel(
        id=_new_session_id(),
        user_id=user_id,
        created_at=now,
        expires_at=now + timedelta(days=SESSION_LIFETIME_DAYS),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def set_session_cookie(response: Response, session_id: str) -> None:
    """Attach the session cookie to the response with secure flags."""
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_id,
        max_age=SESSION_LIFETIME_DAYS * 24 * 3600,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    """Delete the session cookie on the client."""
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
    )


def delete_session(session_id: str, db: DbSession) -> None:
    """Delete a session row by ID (used on logout)."""
    session = db.get(SessionModel, session_id)
    if session is not None:
        db.delete(session)
        db.commit()


# --- Current user dependency ------------------------------------------------


def get_current_user(
    db: DbSession = Depends(get_db),
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> User:
    """FastAPI dependency: load the User from the session cookie or 401."""
    if not session_cookie:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated.",
        )

    session = db.get(SessionModel, session_cookie)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid session.",
        )

    expires_at = session.expires_at
    if expires_at.tzinfo is None:
        # SQLite drops the timezone on round-trip; treat as UTC.
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < datetime.now(timezone.utc):
        db.delete(session)
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired.",
        )

    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive.",
        )

    return user
