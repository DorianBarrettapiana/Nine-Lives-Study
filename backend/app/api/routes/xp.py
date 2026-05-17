"""User XP / level routes (scoped to current user)."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.models.user_progress import XP_PER_LEVEL, UserProgress
from app.schemas.user_progress import UserProgressRead

router = APIRouter(prefix="/xp", tags=["xp"])


@router.get("", response_model=UserProgressRead)
def get_xp(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserProgressRead:
    """Return XP, level, and progress to next level for the current user."""
    progress = db.get(UserProgress, current_user.id)
    if progress is None:
        progress = UserProgress(user_id=current_user.id, xp=0, level=1)
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
