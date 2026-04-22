"""User routes."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.user import User
from app.schemas.user import UserCreate, UserRead

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserRead])
def list_users(db: Session = Depends(get_db)) -> list[User]:
    """Return all users."""
    statement = select(User).order_by(User.id)
    return list(db.scalars(statement).all())


@router.post("", response_model=UserRead, status_code=201)
def create_user(payload: UserCreate, db: Session = Depends(get_db)) -> User:
    """Create a new user if the username is not already taken."""
    existing = db.scalar(select(User).where(User.username == payload.username))
    if existing is not None:
        raise HTTPException(status_code=409, detail="Username already exists.")

    user = User(
        username=payload.username,
        language=payload.language,
        theme=payload.theme,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user