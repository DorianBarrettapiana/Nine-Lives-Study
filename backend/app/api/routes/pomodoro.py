"""Pomodoro session routes."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.xp import XP_POMODORO_COMPLETE, award_xp
from app.models.pomodoro_session import PomodoroSession
from app.models.user import User
from app.schemas.pomodoro_session import (
    PomodoroSessionComplete,
    PomodoroSessionRead,
    PomodoroSessionStart,
)

router = APIRouter(tags=["pomodoro"])


def ensure_user_exists(user_id: int, db: Session) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    return user


@router.get("/users/{user_id}/pomodoro", response_model=list[PomodoroSessionRead])
def list_user_sessions(
    user_id: int,
    db: Session = Depends(get_db),
) -> list[PomodoroSession]:
    """Return all Pomodoro sessions for a user, most recent first."""
    ensure_user_exists(user_id, db)
    statement = (
        select(PomodoroSession)
        .where(PomodoroSession.user_id == user_id)
        .order_by(PomodoroSession.started_at.desc())
    )
    return list(db.scalars(statement).all())


@router.post("/users/{user_id}/pomodoro", response_model=PomodoroSessionRead, status_code=201)
def start_session(
    user_id: int,
    payload: PomodoroSessionStart,
    db: Session = Depends(get_db),
) -> PomodoroSession:
    """Start a new Pomodoro session for a user."""
    ensure_user_exists(user_id, db)

    session = PomodoroSession(
        user_id=user_id,
        session_type=payload.session_type,
        duration_minutes=payload.duration_minutes,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.patch("/pomodoro/{session_id}/complete", response_model=PomodoroSessionRead)
def complete_session(
    session_id: int,
    payload: PomodoroSessionComplete,
    db: Session = Depends(get_db),
) -> PomodoroSession:
    """Mark a Pomodoro session as completed."""
    session = db.get(PomodoroSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Pomodoro session not found.")

    session.is_completed = True
    session.ended_at = payload.ended_at or datetime.now(timezone.utc)

    if session.session_type == "work":
        award_xp(session.user_id, XP_POMODORO_COMPLETE, db)

    db.commit()
    db.refresh(session)
    return session


@router.delete("/pomodoro/{session_id}", status_code=204)
def delete_session(session_id: int, db: Session = Depends(get_db)) -> None:
    """Delete a Pomodoro session."""
    session = db.get(PomodoroSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Pomodoro session not found.")
    db.delete(session)
    db.commit()
