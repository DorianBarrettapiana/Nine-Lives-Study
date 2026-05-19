"""Stopwatch / "positive timing" routes (scoped to current user).

A user may have at most one active (not-yet-ended) stopwatch session at a
time. They also cannot start a stopwatch while a pomodoro work session is
in progress, and vice versa — this is enforced server-side here and in
`pomodoro.py`.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.xp import (
    ENTITY_STOPWATCH,
    EVENT_STOPWATCH,
    award_xp_event,
)
from app.models.pomodoro_session import PomodoroSession
from app.models.stopwatch_session import StopwatchSession
from app.models.user import User
from app.schemas.stopwatch_session import StopwatchSessionRead

router = APIRouter(prefix="/stopwatch", tags=["stopwatch"])


# --- Helpers ---------------------------------------------------------------


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _ensure_aware(ts: datetime) -> datetime:
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def _elapsed_seconds(s: StopwatchSession) -> int:
    """Total counted seconds, including the currently running segment."""
    total = s.accumulated_seconds
    if s.last_started_at is not None and s.ended_at is None:
        delta = _utc_now() - _ensure_aware(s.last_started_at)
        total += max(0, int(delta.total_seconds()))
    return total


def _to_read(s: StopwatchSession) -> StopwatchSessionRead:
    return StopwatchSessionRead(
        id=s.id,
        started_at=s.started_at,
        ended_at=s.ended_at,
        accumulated_seconds=s.accumulated_seconds,
        last_started_at=s.last_started_at,
        is_running=s.last_started_at is not None and s.ended_at is None,
        elapsed_seconds=_elapsed_seconds(s),
    )


def _get_active(user_id: int, db: Session) -> StopwatchSession | None:
    return db.scalar(
        select(StopwatchSession)
        .where(StopwatchSession.user_id == user_id)
        .where(StopwatchSession.ended_at.is_(None))
        .order_by(StopwatchSession.started_at.desc())
    )


def _has_active_pomodoro(user_id: int, db: Session) -> bool:
    """An in-progress pomodoro work session blocks the stopwatch."""
    row = db.scalar(
        select(PomodoroSession.id)
        .where(PomodoroSession.user_id == user_id)
        .where(PomodoroSession.is_completed.is_(False))
        .where(PomodoroSession.session_type == "work")
    )
    return row is not None


# --- Routes ----------------------------------------------------------------


@router.get("/active", response_model=StopwatchSessionRead | None)
def get_active(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StopwatchSessionRead | None:
    """Return the user's active stopwatch session, or null if none."""
    s = _get_active(current_user.id, db)
    return _to_read(s) if s is not None else None


@router.post("/start", response_model=StopwatchSessionRead, status_code=201)
def start(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StopwatchSessionRead:
    """Start a new stopwatch session. Fails if one is already active or if
    a pomodoro work session is currently in progress."""
    if _get_active(current_user.id, db) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="A stopwatch session is already active.")
    if _has_active_pomodoro(current_user.id, db):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="A pomodoro is already in progress.")
    now = _utc_now()
    s = StopwatchSession(
        user_id=current_user.id,
        started_at=now,
        last_started_at=now,
        accumulated_seconds=0,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return _to_read(s)


@router.post("/{session_id}/pause", response_model=StopwatchSessionRead)
def pause(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StopwatchSessionRead:
    s = db.get(StopwatchSession, session_id)
    if s is None or s.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Not found.")
    if s.ended_at is not None:
        raise HTTPException(status_code=400, detail="Session already ended.")
    if s.last_started_at is None:
        return _to_read(s)  # already paused — idempotent
    delta = _utc_now() - _ensure_aware(s.last_started_at)
    s.accumulated_seconds += max(0, int(delta.total_seconds()))
    s.last_started_at = None
    db.commit()
    db.refresh(s)
    return _to_read(s)


@router.post("/{session_id}/resume", response_model=StopwatchSessionRead)
def resume(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StopwatchSessionRead:
    s = db.get(StopwatchSession, session_id)
    if s is None or s.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Not found.")
    if s.ended_at is not None:
        raise HTTPException(status_code=400, detail="Session already ended.")
    if s.last_started_at is not None:
        return _to_read(s)  # already running — idempotent
    # A pomodoro started while we were paused must not be ignored.
    if _has_active_pomodoro(current_user.id, db):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="A pomodoro is already in progress.")
    s.last_started_at = _utc_now()
    db.commit()
    db.refresh(s)
    return _to_read(s)


@router.post("/{session_id}/end", response_model=StopwatchSessionRead)
def end(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StopwatchSessionRead:
    """End the session. Awards XP equal to the rounded-down minutes worked."""
    s = db.get(StopwatchSession, session_id)
    if s is None or s.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Not found.")
    if s.ended_at is not None:
        return _to_read(s)  # already ended — idempotent
    now = _utc_now()
    if s.last_started_at is not None:
        delta = now - _ensure_aware(s.last_started_at)
        s.accumulated_seconds += max(0, int(delta.total_seconds()))
        s.last_started_at = None
    s.ended_at = now
    db.commit()
    db.refresh(s)

    minutes = s.accumulated_seconds // 60
    if minutes > 0:
        award_xp_event(
            user_id=current_user.id,
            event_type=EVENT_STOPWATCH,
            entity_type=ENTITY_STOPWATCH,
            entity_id=s.id,
            amount=minutes,
            db=db,
        )
        db.commit()
    return _to_read(s)


@router.delete("/{session_id}", status_code=204)
def delete(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Discard a stopwatch session (active or ended). Stats lose the time."""
    s = db.get(StopwatchSession, session_id)
    if s is None or s.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Not found.")
    db.delete(s)
    db.commit()
