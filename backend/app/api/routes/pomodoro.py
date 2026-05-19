"""Pomodoro session routes (scoped to current user)."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.xp import (
    ENTITY_POMODORO,
    EVENT_POMODORO,
    award_xp_event,
)
from app.models.pomodoro_session import PomodoroSession
from app.models.stopwatch_session import StopwatchSession
from app.models.user import User
from app.schemas.pomodoro_session import (
    PomodoroSessionComplete,
    PomodoroSessionRead,
    PomodoroSessionStart,
)

router = APIRouter(prefix="/pomodoro", tags=["pomodoro"])


def _get_owned_session(session_id: int, current_user: User, db: Session) -> PomodoroSession:
    session = db.get(PomodoroSession, session_id)
    if session is None or session.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pomodoro session not found.")
    return session


@router.get("", response_model=list[PomodoroSessionRead])
def list_sessions(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PomodoroSession]:
    statement = (
        select(PomodoroSession)
        .where(PomodoroSession.user_id == current_user.id)
        .order_by(PomodoroSession.started_at.desc())
    )
    return list(db.scalars(statement).all())


@router.post("", response_model=PomodoroSessionRead, status_code=201)
def start_session(
    payload: PomodoroSessionStart,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PomodoroSession:
    # Mutex with stopwatch: a work pomodoro and an active stopwatch can't
    # run at the same time (a break may, since the user isn't "working").
    if payload.session_type == "work":
        active_stopwatch = db.scalar(
            select(StopwatchSession.id)
            .where(StopwatchSession.user_id == current_user.id)
            .where(StopwatchSession.ended_at.is_(None))
        )
        if active_stopwatch is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A stopwatch session is already active. End it first.",
            )

    session = PomodoroSession(
        user_id=current_user.id,
        session_type=payload.session_type,
        duration_minutes=payload.duration_minutes,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.patch("/{session_id}/complete", response_model=PomodoroSessionRead)
def complete_session(
    session_id: int,
    payload: PomodoroSessionComplete,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PomodoroSession:
    session = _get_owned_session(session_id, current_user, db)
    session.is_completed = True
    session.ended_at = payload.ended_at or datetime.now(timezone.utc)

    # Idempotent on (event_type, entity_id): re-PATCHing /complete on an
    # already-finished session does not re-award XP. XP equals the work
    # duration in minutes (current rule: 1 min work = 1 XP).
    if session.session_type == "work":
        award_xp_event(
            user_id=session.user_id,
            event_type=EVENT_POMODORO,
            entity_type=ENTITY_POMODORO,
            entity_id=session.id,
            amount=session.duration_minutes,
            db=db,
        )

    db.commit()
    db.refresh(session)
    return session


@router.delete("/{session_id}", status_code=204)
def delete_session(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    session = _get_owned_session(session_id, current_user, db)
    db.delete(session)
    db.commit()
