"""User routes (self-only)."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session as DbSession

from app.core.auth import clear_session_cookie, get_current_user
from app.core.cat_skin import (
    CAT_SKIN_REQUIRED_MINUTES,
    can_change_cat_skin,
    user_read_with_skin_status,
)
from app.core.database import get_db
from app.models.session import Session as SessionModel
from app.models.user import User
from app.schemas.friendship import UserSearchResult
from app.schemas.user import UserRead, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me", response_model=UserRead)
def get_me(
    current_user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
) -> UserRead:
    """Return the current user (alias of /auth/me, kept for convenience)."""
    return user_read_with_skin_status(current_user, db)


@router.patch("/me", response_model=UserRead)
def update_me(
    payload: UserUpdate,
    current_user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
) -> UserRead:
    """Partially update the current user's profile (language, theme, ...).

    Cat-skin changes are rate-limited: after the first explicit pick, the
    user must accumulate 30h of completed pomodoro work before changing again.
    """
    data = payload.model_dump(exclude_unset=True)

    # Special handling for cat_skin: enforce the 30h pomodoro lock.
    if "cat_skin" in data and data["cat_skin"] != current_user.cat_skin:
        allowed, accumulated, used_free = can_change_cat_skin(current_user, db)
        if not allowed:
            remaining = CAT_SKIN_REQUIRED_MINUTES - accumulated
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Cat skin is locked. Complete {remaining} more pomodoro "
                    f"minutes ({accumulated}/{CAT_SKIN_REQUIRED_MINUTES}) "
                    "before changing again."
                ),
            )
        current_user.cat_skin_changed_at = datetime.now(timezone.utc)
        if used_free:
            current_user.cat_skin_free_changes -= 1

    for field_name, field_value in data.items():
        setattr(current_user, field_name, field_value)
    db.commit()
    db.refresh(current_user)
    return user_read_with_skin_status(current_user, db)


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


@router.get("/search", response_model=list[UserSearchResult])
def search_users(
    q: str = Query(min_length=1, max_length=100),
    current_user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
) -> list[User]:
    return db.scalars(
        select(User)
        .where(User.username.ilike(f"%{q}%"))
        .where(User.id != current_user.id)
        .where(User.is_active == True)  # noqa: E712
        .limit(10)
    ).all()
