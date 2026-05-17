"""User XP / level routes."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.user import User
from app.models.user_progress import XP_PER_LEVEL, UserProgress
from app.schemas.user_progress import UserProgressRead

router = APIRouter(tags=["xp"])


@router.get("/users/{user_id}/xp", response_model=UserProgressRead)
def get_user_xp(user_id: int, db: Session = Depends(get_db)) -> UserProgressRead:
    """Return XP, level, and progress to next level for a user."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    progress = db.get(UserProgress, user_id)
    if progress is None:
        progress = UserProgress(user_id=user_id, xp=0, level=1)
        db.add(progress)
        db.commit()
        db.refresh(progress)

    xp_in_level = progress.xp % XP_PER_LEVEL
    xp_to_next = XP_PER_LEVEL - xp_in_level

    return UserProgressRead(
        user_id=progress.user_id,
        xp=progress.xp,
        level=progress.level,
        xp_in_level=xp_in_level,
        xp_to_next_level=xp_to_next,
    )
