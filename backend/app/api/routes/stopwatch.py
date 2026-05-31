"""Stopwatch / "positive timing" routes (scoped to current user).

A user may have at most one active (not-yet-ended) stopwatch session at a
time. They also cannot start a stopwatch while a pomodoro work session is
in progress, and vice versa — this is enforced server-side here and in
`pomodoro.py`.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.xp import (
    ENTITY_STOPWATCH,
    EVENT_STOPWATCH,
    award_xp_event,
)
from app.models.daily_tracker import DailyTask
from app.models.pomodoro_session import PomodoroSession
from app.models.stopwatch_session import StopwatchSession
from app.models.user import User
from app.schemas.stopwatch_session import StopwatchSessionRead, StopwatchSessionStart

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
        work_label=s.work_label,
        task_id=s.task_id,
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


def _resolve_focus(
    task_id: int | None, work_label: str, current_user: User, db: Session,
) -> tuple[int | None, str]:
    label = work_label.strip()
    if task_id is None:
        return None, label
    task = db.get(DailyTask, task_id)
    if task is None or task.user_id != current_user.id:
        raise HTTPException(status_code=400, detail="Daily task not found.")
    return task.id, label or task.text


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
    payload: StopwatchSessionStart = StopwatchSessionStart(),
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
    task_id, work_label = _resolve_focus(payload.task_id, payload.work_label, current_user, db)
    now = _utc_now()
    s = StopwatchSession(
        user_id=current_user.id,
        started_at=now,
        last_started_at=now,
        accumulated_seconds=0,
        task_id=task_id,
        work_label=work_label,
    )
    db.add(s)
    try:
        db.commit()
    except IntegrityError as exc:
        # Partial unique index on (user_id) WHERE ended_at IS NULL fired.
        # A concurrent /start request landed first and beat us through the
        # TOCTOU window. Surface the existing session so the client picks
        # it up instead of seeing a 500. Equivalent to a 409 the client
        # already knows how to handle, but no data loss either way.
        db.rollback()
        existing = _get_active(current_user.id, db)
        if existing is not None:
            return _to_read(existing)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A stopwatch session is already active.",
        ) from exc
    db.refresh(s)
    return _to_read(s)


@router.post("/{session_id}/pause", response_model=StopwatchSessionRead)
def pause(
    session_id: int,
    client_elapsed_seconds: int | None = None,
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
    server_delta = max(0, int((_utc_now() - _ensure_aware(s.last_started_at)).total_seconds()))
    # Cap server-computed delta with the client's claim of the running
    # segment length. Without this cap, network lag between the user's
    # click and the server processing the request inflates accumulated:
    # the user paused, walked away, and the server kept "counting" until
    # the POST finally landed. We take the smaller value (favors the user
    # and never credits more time than they actually saw on screen).
    if client_elapsed_seconds is not None and client_elapsed_seconds >= 0:
        delta_seconds = min(server_delta, client_elapsed_seconds)
    else:
        delta_seconds = server_delta
    s.accumulated_seconds += delta_seconds
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
