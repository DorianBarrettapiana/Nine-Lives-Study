"""Daily-pomodoro streak computation.

A "streak" is the number of consecutive days (in the caller's local tz)
ending at today (or yesterday, see grace rule) where the user completed
at least one work pomodoro session.

Grace rule: a streak with last activity = *yesterday* is still counted at
its current value until the end of today. Without this, users would see
their streak collapse to 0 at midnight every day until they did their
first pomodoro of the day, which would feel unfair and punitive.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.pomodoro_session import PomodoroSession


def compute_streak(user_id: int, tz_offset_minutes: int, db: Session) -> tuple[int, bool]:
    """Return (streak_days, active_today) for the given user.

    `tz_offset_minutes` is minutes east of UTC (matches the JS getTimezoneOffset
    convention with sign flipped).
    """
    tz_delta = timedelta(minutes=tz_offset_minutes)

    rows = db.scalars(
        select(PomodoroSession.started_at)
        .where(PomodoroSession.user_id == user_id)
        .where(PomodoroSession.is_completed.is_(True))
        .where(PomodoroSession.session_type == "work")
    ).all()

    # Distinct set of local-day strings on which the user completed a work session.
    active_days: set[str] = set()
    for ts in rows:
        if ts is None:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        local = ts.astimezone(timezone.utc) + tz_delta
        active_days.add(local.strftime("%Y-%m-%d"))

    if not active_days:
        return 0, False

    today_local = (datetime.now(timezone.utc) + tz_delta).date()
    today_str = today_local.isoformat()
    yesterday_str = (today_local - timedelta(days=1)).isoformat()

    active_today = today_str in active_days

    # Pick the anchor day: today if active, else yesterday (grace), else 0.
    if active_today:
        anchor = today_local
    elif yesterday_str in active_days:
        anchor = today_local - timedelta(days=1)
    else:
        return 0, False

    # Walk backwards from anchor while every consecutive day is active.
    streak = 0
    cursor = anchor
    while cursor.isoformat() in active_days:
        streak += 1
        cursor -= timedelta(days=1)

    return streak, active_today
