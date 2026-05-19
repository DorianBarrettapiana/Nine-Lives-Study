"""Friends system routes."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.friendship import Friendship
from app.models.pomodoro_session import PomodoroSession
from app.models.user import User
from app.schemas.friendship import (
    DailyMinutes,
    FriendEntry,
    FriendRequestEntry,
    FriendStudyStats,
)

router = APIRouter(prefix="/friends", tags=["friends"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _friendship_filter(user_a: int, user_b: int):
    return or_(
        and_(Friendship.requester_id == user_a, Friendship.addressee_id == user_b),
        and_(Friendship.requester_id == user_b, Friendship.addressee_id == user_a),
    )


def _get_friendship(user_a: int, user_b: int, db: Session) -> Friendship | None:
    return db.scalar(
        select(Friendship).where(_friendship_filter(user_a, user_b))
    )


def _require_accepted_friendship(me: int, other: int, db: Session) -> None:
    f = _get_friendship(me, other, db)
    if f is None or f.status != "accepted":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not friends.")


# ---------------------------------------------------------------------------
# Friend list & requests
# ---------------------------------------------------------------------------

@router.get("", response_model=list[FriendEntry])
def list_friends(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[FriendEntry]:
    rows = db.execute(
        select(Friendship, User)
        .join(
            User,
            or_(
                and_(Friendship.requester_id == current_user.id, User.id == Friendship.addressee_id),
                and_(Friendship.addressee_id == current_user.id, User.id == Friendship.requester_id),
            ),
        )
        .where(Friendship.status == "accepted")
        .where(
            or_(
                Friendship.requester_id == current_user.id,
                Friendship.addressee_id == current_user.id,
            )
        )
    ).all()
    return [FriendEntry(user_id=user.id, username=user.username) for _, user in rows]


@router.get("/requests", response_model=list[FriendRequestEntry])
def list_incoming_requests(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[FriendRequestEntry]:
    rows = db.execute(
        select(User)
        .join(Friendship, Friendship.requester_id == User.id)
        .where(Friendship.addressee_id == current_user.id)
        .where(Friendship.status == "pending")
    ).scalars().all()
    return [FriendRequestEntry(user_id=u.id, username=u.username) for u in rows]


# ---------------------------------------------------------------------------
# Send / accept / remove
# ---------------------------------------------------------------------------

class SendRequestPayload(BaseModel):
    username: str


@router.post("", status_code=201, response_model=dict)
def send_friend_request(
    payload: SendRequestPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    target = db.scalar(select(User).where(User.username == payload.username))
    if target is None or not target.is_active:
        raise HTTPException(status_code=404, detail="User not found.")
    if target.id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot add yourself.")

    existing = _get_friendship(current_user.id, target.id, db)
    if existing is not None:
        if existing.status == "accepted":
            raise HTTPException(status_code=400, detail="Already friends.")
        # If they sent a request to us → auto-accept
        if existing.requester_id == target.id and existing.addressee_id == current_user.id:
            existing.status = "accepted"
            db.commit()
            return {"status": "accepted"}
        raise HTTPException(status_code=400, detail="Request already sent.")

    db.add(Friendship(requester_id=current_user.id, addressee_id=target.id))
    db.commit()
    return {"status": "pending"}


@router.post("/{user_id}/accept", response_model=dict)
def accept_request(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    f = db.scalar(
        select(Friendship)
        .where(Friendship.requester_id == user_id)
        .where(Friendship.addressee_id == current_user.id)
        .where(Friendship.status == "pending")
    )
    if f is None:
        raise HTTPException(status_code=404, detail="Request not found.")
    f.status = "accepted"
    db.commit()
    return {"status": "accepted"}


@router.delete("/{user_id}", status_code=204)
def remove_friend(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    f = _get_friendship(current_user.id, user_id, db)
    if f is None:
        raise HTTPException(status_code=404, detail="Not found.")
    db.delete(f)
    db.commit()


# ---------------------------------------------------------------------------
# Friend study stats
# ---------------------------------------------------------------------------

@router.get("/{user_id}/study-stats", response_model=FriendStudyStats)
def get_friend_study_stats(
    user_id: int,
    days: int = Query(default=7, ge=1, le=90),
    tz_offset: int = Query(default=0, ge=-720, le=840),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FriendStudyStats:
    _require_accepted_friendship(current_user.id, user_id, db)

    friend = db.get(User, user_id)
    if friend is None or not friend.is_active:
        raise HTTPException(status_code=404, detail="User not found.")

    since = date.today() - timedelta(days=days - 1)

    since_str = since.isoformat()
    sessions = db.execute(
        select(PomodoroSession)
        .where(PomodoroSession.user_id == user_id)
        .where(PomodoroSession.is_completed == True)  # noqa: E712
        .where(PomodoroSession.session_type == "work")
        .where(PomodoroSession.started_at >= since_str)
    ).scalars().all()

    tz_delta = timedelta(minutes=tz_offset)
    minutes_by_day: dict[str, int] = {}
    for s in sessions:
        local_dt = (s.started_at + tz_delta) if s.started_at else None
        day_str = local_dt.strftime("%Y-%m-%d") if local_dt else since.isoformat()
        minutes_by_day[day_str] = minutes_by_day.get(day_str, 0) + s.duration_minutes

    daily_minutes = [
        DailyMinutes(
            date=(since + timedelta(days=i)).isoformat(),
            minutes=minutes_by_day.get((since + timedelta(days=i)).isoformat(), 0),
        )
        for i in range(days)
    ]
    total_minutes = sum(minutes_by_day.values())

    return FriendStudyStats(
        user_id=user_id,
        username=friend.username,
        days=days,
        daily_minutes=daily_minutes,
        total_minutes=total_minutes,
    )
