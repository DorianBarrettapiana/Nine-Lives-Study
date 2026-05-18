"""User routes (self-only)."""

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import delete
from sqlalchemy.orm import Session as DbSession

from app.core.auth import clear_session_cookie, get_current_user
from app.core.database import get_db
from app.models.session import Session as SessionModel
from app.models.user import User
from app.schemas.user import UserRead, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me", response_model=UserRead)
def get_me(current_user: User = Depends(get_current_user)) -> User:
    """Return the current user (alias of /auth/me, kept for convenience)."""
    return current_user


@router.patch("/me", response_model=UserRead)
def update_me(
    payload: UserUpdate,
    current_user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
) -> User:
    """Partially update the current user's profile (language, theme, ...)."""
    data = payload.model_dump(exclude_unset=True)
    for field_name, field_value in data.items():
        setattr(current_user, field_name, field_value)
    db.commit()
    db.refresh(current_user)
    return current_user


@router.delete("/me", status_code=204)
def delete_me(
    response: Response,
    current_user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
) -> Response:
    """Delete the current user's account and all their data (cascade)."""
    # Drop all sessions for this user first so the cookie is invalidated.
    db.execute(delete(SessionModel).where(SessionModel.user_id == current_user.id))
    db.delete(current_user)
    db.commit()
    clear_session_cookie(response)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
