"""Authentication routes: register, login, logout, me, password change."""

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import (
    clear_session_cookie,
    create_session,
    delete_session,
    get_current_user,
    hash_password,
    set_session_cookie,
    verify_password,
)
from app.core.cat_skin import user_read_with_skin_status
from app.core.config import INVITE_CODE, SESSION_COOKIE_NAME
from app.core.database import get_db
from app.models.user import User
from app.schemas.auth import LoginPayload, PasswordChangePayload, RegisterPayload
from app.schemas.user import UserRead

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserRead, status_code=201)
def register(
    payload: RegisterPayload,
    response: Response,
    db: Session = Depends(get_db),
) -> UserRead:
    """Create a new user account and start a session.

    Registration is gated by INVITE_CODE. If the env var is empty,
    registration is disabled.
    """
    if not INVITE_CODE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Registration is disabled.",
        )
    if payload.invite_code != INVITE_CODE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid invite code.",
        )

    existing = db.scalar(select(User).where(User.username == payload.username))
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already exists.",
        )

    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        language=payload.language,
        theme=payload.theme,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    session = create_session(user.id, db)
    set_session_cookie(response, session.id)
    return user_read_with_skin_status(user, db)


@router.post("/login", response_model=UserRead)
def login(
    payload: LoginPayload,
    response: Response,
    db: Session = Depends(get_db),
) -> UserRead:
    """Authenticate and set the session cookie."""
    user = db.scalar(select(User).where(User.username == payload.username))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account disabled.",
        )

    session = create_session(user.id, db)
    set_session_cookie(response, session.id)
    return user_read_with_skin_status(user, db)


@router.post("/logout", status_code=204)
def logout(
    response: Response,
    db: Session = Depends(get_db),
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> None:
    """Invalidate the current session and clear the cookie.

    Idempotent: succeeds even if the cookie is missing or expired.
    """
    if session_cookie:
        delete_session(session_cookie, db)
    clear_session_cookie(response)


@router.get("/me", response_model=UserRead)
def me(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserRead:
    """Return the currently authenticated user."""
    return user_read_with_skin_status(current_user, db)


@router.post("/password", status_code=204)
def change_password(
    payload: PasswordChangePayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Change the current user's password."""
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Current password is incorrect.",
        )
    current_user.password_hash = hash_password(payload.new_password)
    db.commit()
