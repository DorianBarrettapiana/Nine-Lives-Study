"""Friends system routes."""

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.xp import (
    ENTITY_FRIEND_CHEER,
    EVENT_CHEER,
    XP_CHEER_RECEIVED,
    award_xp_event,
)
from app.models.feed_like import FeedLike
from app.models.friend_cheer import FriendCheer
from app.models.friendship import Friendship
from app.models.user import User
from app.models.xp_event import XpEvent
from app.schemas.friendship import (
    DailyMinutes,
    FeedItem,
    FriendEntry,
    FriendRequestEntry,
    FriendStudyStats,
    NotificationItem,
    NotificationsResponse,
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


def _local_midnight_utc(tz_offset_minutes: int) -> datetime:
    """Return today's local-day midnight expressed as a UTC datetime.

    `tz_offset_minutes` follows the JS getTimezoneOffset convention with the
    sign flipped (minutes east of UTC). The result is comparable against
    timestamps stored in the DB (which are UTC-aware or naive UTC).
    """
    tz_delta = timedelta(minutes=tz_offset_minutes)
    local_now = datetime.now(timezone.utc) + tz_delta
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    return local_midnight - tz_delta


# ---------------------------------------------------------------------------
# Friend list & requests
# ---------------------------------------------------------------------------

@router.get("", response_model=list[FriendEntry])
def list_friends(
    tz_offset: int = Query(default=0, ge=-720, le=840),
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
    friends = [user for _, user in rows]

    # Bulk-fetch cheers I sent since today's local midnight so each
    # FriendEntry knows whether the Cheer button should be enabled.
    since = _local_midnight_utc(tz_offset)
    recipient_ids = {f.id for f in friends}
    cheered_recently: set[int] = set()
    if recipient_ids:
        cheered_recently = set(db.scalars(
            select(FriendCheer.recipient_id)
            .where(FriendCheer.sender_id == current_user.id)
            .where(FriendCheer.recipient_id.in_(recipient_ids))
            .where(FriendCheer.created_at >= since)
        ).all())

    return [
        FriendEntry(
            user_id=user.id,
            username=user.username,
            cat_skin=user.cat_skin,
            can_cheer=user.id not in cheered_recently,
        )
        for user in friends
    ]


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
    return [
        FriendRequestEntry(user_id=u.id, username=u.username, cat_skin=u.cat_skin)
        for u in rows
    ]


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

    # Use the xp_events ledger so deleted sessions still count, and one path
    # handles both pomodoro_done and stopwatch_done uniformly (amount = mins).
    work_events = db.scalars(
        select(XpEvent)
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type.in_(["pomodoro_done", "stopwatch_done"]))
    ).all()

    tz_delta = timedelta(minutes=tz_offset)
    since_str = since.isoformat()
    minutes_by_day: dict[str, int] = {}

    for ev in work_events:
        if ev.created_at is None:
            continue
        ts = ev.created_at
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        local_dt = ts.astimezone(timezone.utc) + tz_delta
        day_str = local_dt.strftime("%Y-%m-%d")
        if day_str < since_str:
            continue
        minutes_by_day[day_str] = minutes_by_day.get(day_str, 0) + ev.amount

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


# ---------------------------------------------------------------------------
# Activity feed
# ---------------------------------------------------------------------------

def _friend_ids(user_id: int, db: Session) -> list[int]:
    rows = db.execute(
        select(Friendship)
        .where(Friendship.status == "accepted")
        .where(
            or_(
                Friendship.requester_id == user_id,
                Friendship.addressee_id == user_id,
            )
        )
    ).scalars().all()
    ids: list[int] = []
    for f in rows:
        ids.append(f.addressee_id if f.requester_id == user_id else f.requester_id)
    return ids


@router.get("/feed", response_model=list[FeedItem])
def get_feed(
    limit: int = Query(default=30, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[FeedItem]:
    fids = _friend_ids(current_user.id, db)
    if not fids:
        return []

    events = db.execute(
        select(XpEvent, User.username, User.cat_skin)
        .join(User, User.id == XpEvent.user_id)
        .where(XpEvent.user_id.in_(fids))
        .order_by(XpEvent.created_at.desc())
        .limit(limit)
    ).all()

    event_ids = [e.id for e, _, _ in events]
    like_counts: dict[int, int] = {}
    my_likes: set[int] = set()
    if event_ids:
        count_rows = db.execute(
            select(FeedLike.xp_event_id, func.count(FeedLike.id))
            .where(FeedLike.xp_event_id.in_(event_ids))
            .group_by(FeedLike.xp_event_id)
        ).all()
        like_counts = {eid: cnt for eid, cnt in count_rows}

        my_rows = db.execute(
            select(FeedLike.xp_event_id)
            .where(FeedLike.xp_event_id.in_(event_ids))
            .where(FeedLike.user_id == current_user.id)
        ).scalars().all()
        my_likes = set(my_rows)

    return [
        FeedItem(
            id=ev.id,
            user_id=ev.user_id,
            username=uname,
            cat_skin=skin,
            event_type=ev.event_type,
            amount=ev.amount,
            created_at=ev.created_at,
            like_count=like_counts.get(ev.id, 0),
            liked_by_me=ev.id in my_likes,
        )
        for ev, uname, skin in events
    ]


@router.post("/feed/{event_id}/like", response_model=dict)
def toggle_like(
    event_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    # Only allow liking events that belong to the caller or one of their
    # accepted friends — otherwise any logged-in user could like arbitrary
    # event ids by guessing/enumerating and spam the author's notifications.
    event = db.get(XpEvent, event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found.")
    if event.user_id != current_user.id:
        f = _get_friendship(current_user.id, event.user_id, db)
        if f is None or f.status != "accepted":
            raise HTTPException(status_code=403, detail="Not allowed.")

    existing = db.scalar(
        select(FeedLike)
        .where(FeedLike.user_id == current_user.id)
        .where(FeedLike.xp_event_id == event_id)
    )
    if existing:
        db.delete(existing)
        db.commit()
        return {"liked": False}
    db.add(FeedLike(user_id=current_user.id, xp_event_id=event_id))
    db.commit()
    return {"liked": True}


@router.post("/{user_id}/cheer", response_model=dict)
def cheer_friend(
    user_id: int,
    tz_offset: int = Query(default=0, ge=-720, le=840),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Send a one-shot cheer to a friend.

    Sends +XP_CHEER_RECEIVED XP to the recipient via the standard XP ledger
    and seeds a notification (the recipient sees it in the Friends tab).
    One cheer per (sender, recipient) pair per **local calendar day** — the
    limit resets at the sender's local midnight.
    """
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot cheer yourself.")
    f = _get_friendship(current_user.id, user_id, db)
    if f is None or f.status != "accepted":
        raise HTTPException(status_code=403, detail="Not friends.")

    # Per-pair daily cap: one cheer per local calendar day, resets at midnight.
    since = _local_midnight_utc(tz_offset)
    already = db.scalar(
        select(FriendCheer)
        .where(FriendCheer.sender_id == current_user.id)
        .where(FriendCheer.recipient_id == user_id)
        .where(FriendCheer.created_at >= since)
    )
    if already is not None:
        raise HTTPException(
            status_code=429,
            detail="You already cheered this friend today. Resets at midnight.",
        )

    cheer = FriendCheer(sender_id=current_user.id, recipient_id=user_id)
    db.add(cheer)
    db.flush()  # need cheer.id for the XP entity_id

    award_xp_event(
        user_id=user_id,
        event_type=EVENT_CHEER,
        entity_type=ENTITY_FRIEND_CHEER,
        entity_id=cheer.id,
        amount=XP_CHEER_RECEIVED,
        db=db,
    )

    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------

@router.get("/notifications", response_model=NotificationsResponse)
def get_notifications(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationsResponse:
    """Latest notifications: friend likes on the user's activity + cheers
    received from friends. Both types are returned in a single list, sorted
    by recency.
    """
    cutoff = current_user.notif_read_at

    # --- Likes received -----------------------------------------------------
    like_rows = db.execute(
        select(FeedLike, User.username, User.cat_skin, XpEvent.event_type)
        .join(XpEvent, XpEvent.id == FeedLike.xp_event_id)
        .join(User, User.id == FeedLike.user_id)
        .where(XpEvent.user_id == current_user.id)
        .where(FeedLike.user_id != current_user.id)
        .order_by(FeedLike.created_at.desc())
        .limit(20)
    ).all()

    # --- Cheers received ----------------------------------------------------
    cheer_rows = db.execute(
        select(FriendCheer, User.username, User.cat_skin)
        .join(User, User.id == FriendCheer.sender_id)
        .where(FriendCheer.recipient_id == current_user.id)
        .order_by(FriendCheer.created_at.desc())
        .limit(20)
    ).all()

    items: list[tuple[datetime, NotificationItem]] = []
    for like, uname, skin, etype in like_rows:
        if like.created_at is None:
            continue
        items.append((like.created_at, NotificationItem(
            liker_username=uname,
            liker_cat_skin=skin,
            event_type=etype,
            created_at=like.created_at,
        )))
    for cheer, uname, skin in cheer_rows:
        if cheer.created_at is None:
            continue
        items.append((cheer.created_at, NotificationItem(
            liker_username=uname,
            liker_cat_skin=skin,
            event_type="cheered_you",
            created_at=cheer.created_at,
        )))

    # Sort by recency and keep the top 20 across both kinds.
    items.sort(key=lambda pair: pair[0], reverse=True)
    items = items[:20]

    # Make `cutoff` timezone-aware for safe comparison with possibly-naive
    # timestamps from SQLite.
    cutoff_aware = None
    if cutoff is not None:
        cutoff_aware = cutoff if cutoff.tzinfo else cutoff.replace(tzinfo=timezone.utc)

    if cutoff_aware is None:
        unread = len(items)
    else:
        unread = 0
        for ts, _ in items:
            ts_aware = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
            if ts_aware > cutoff_aware:
                unread += 1

    return NotificationsResponse(unread_count=unread, items=[item for _, item in items])


@router.post("/notifications/read", response_model=dict)
def mark_notifications_read(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    from datetime import datetime, timezone
    current_user.notif_read_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}
