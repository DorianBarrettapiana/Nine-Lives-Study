"""Stats aggregation routes (scoped to current user).

Counts come from the ``xp_events`` ledger, not from live rows, so deleting
a task / pomodoro / mood entry does NOT retroactively rewrite history.
"""

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.xp import (
    EVENT_FEYNMAN,
    EVENT_MOOD,
    EVENT_NOTE,
    EVENT_POMODORO,
    EVENT_TASK_DONE,
)
from app.models.feynman_entry import FeynmanEntry
from app.models.mood_entry import MoodEntry
from app.models.paper_note import PaperNote
from app.models.user import User
from app.models.xp_event import XpEvent
from app.schemas.stats import (
    DailyMoodStat,
    DailyPomodoroStat,
    DailyTaskStat,
    UserStatsRead,
    WeeklySummary,
    WeeklySummaryCounts,
)

router = APIRouter(prefix="/stats", tags=["stats"])


@router.get("", response_model=UserStatsRead)
def get_stats(
    days: int = Query(default=7, ge=1, le=90),
    tz_offset: int = Query(default=0, ge=-720, le=840),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserStatsRead:
    """Return aggregated stats for the current user over the last N days.

    Daily buckets are computed in the caller's local timezone via tz_offset
    (minutes east of UTC, same convention as friend stats). Without this,
    events near midnight bucket against UTC and look "off by a day" to users
    several hours away from UTC.
    """
    user_id = current_user.id

    tz_delta = timedelta(minutes=tz_offset)
    # "today" in the caller's local timezone — used to bound the N-day window.
    today_local = (datetime.now(timezone.utc) + tz_delta).date()
    since = today_local - timedelta(days=days - 1)
    since_str = since.isoformat()

    def _local_day(ts) -> str | None:
        if ts is None:
            return None
        # ts may be naive (SQLite) or tz-aware — coerce both to UTC then shift.
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return (ts.astimezone(timezone.utc) + tz_delta).strftime("%Y-%m-%d")

    # --- Tasks per day (XP_TASK_DONE events grouped by local day) -----------
    task_events = db.scalars(
        select(XpEvent)
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type == EVENT_TASK_DONE)
    ).all()
    task_counts: dict[str, int] = {}
    for ev in task_events:
        day = _local_day(ev.created_at)
        if day is None or day < since_str:
            continue
        task_counts[day] = task_counts.get(day, 0) + 1
    daily_tasks = [
        DailyTaskStat(date=date.fromisoformat(d), total=c, done=c)
        for d, c in sorted(task_counts.items())
    ]

    # --- Mood per day: latest emoji recorded that local day -----------------
    mood_rows = db.scalars(
        select(MoodEntry)
        .where(MoodEntry.user_id == user_id)
        .order_by(MoodEntry.created_at.desc())
    ).all()
    latest_mood: dict[str, str] = {}
    for entry in mood_rows:
        day = _local_day(entry.created_at)
        if day is None or day < since_str:
            continue
        # rows are desc by created_at → first one wins per day
        if day not in latest_mood:
            latest_mood[day] = entry.mood
    daily_moods = [
        DailyMoodStat(date=date.fromisoformat(d), mood=m)
        for d, m in sorted(latest_mood.items())
    ]

    # --- Pomodoros per day (XP_POMODORO events) -----------------------------
    pomo_events = db.scalars(
        select(XpEvent)
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type == EVENT_POMODORO)
    ).all()
    pomo_counts: dict[str, int] = {}
    for ev in pomo_events:
        day = _local_day(ev.created_at)
        if day is None or day < since_str:
            continue
        pomo_counts[day] = pomo_counts.get(day, 0) + 1
    daily_pomodoros = [
        DailyPomodoroStat(date=date.fromisoformat(d), count=c)
        for d, c in sorted(pomo_counts.items())
    ]

    # --- Totals (all-time, from xp_events for activity-based counters; the
    #     "current rows" counts for notes / feynman / mood reflect what the
    #     user can still see in their UI, which is more useful than history) -
    total_tasks_done = db.scalar(
        select(func.count(XpEvent.id))
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type == EVENT_TASK_DONE)
    ) or 0

    total_pomodoros = db.scalar(
        select(func.count(XpEvent.id))
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type == EVENT_POMODORO)
    ) or 0

    total_notes = db.scalar(
        select(func.count(PaperNote.id)).where(PaperNote.user_id == user_id)
    ) or 0

    total_feynman = db.scalar(
        select(func.count(FeynmanEntry.id)).where(FeynmanEntry.user_id == user_id)
    ) or 0

    total_moods = db.scalar(
        select(func.count(MoodEntry.id)).where(MoodEntry.user_id == user_id)
    ) or 0

    # Silence unused-import linter without breaking type hint inference
    _ = (EVENT_NOTE, EVENT_FEYNMAN, EVENT_MOOD)

    # --- Weekly summary: last 7 days vs prior 7 days (caller's local tz) ----
    # Uses the same _local_day bucketing as the daily series above so deltas
    # and the daily charts always agree.
    this_week_start = today_local - timedelta(days=6)   # inclusive
    prev_week_start = today_local - timedelta(days=13)  # inclusive
    prev_week_end   = today_local - timedelta(days=7)   # inclusive

    def _bucket(events_or_entries, get_ts) -> tuple[int, int]:
        this_n = prev_n = 0
        for item in events_or_entries:
            day = _local_day(get_ts(item))
            if day is None:
                continue
            if this_week_start.isoformat() <= day <= today_local.isoformat():
                this_n += 1
            elif prev_week_start.isoformat() <= day <= prev_week_end.isoformat():
                prev_n += 1
        return this_n, prev_n

    pomo_this, pomo_prev = _bucket(pomo_events, lambda e: e.created_at)
    task_this, task_prev = _bucket(task_events, lambda e: e.created_at)

    # Notes / Feynman / Moods are live rows (not xp_events) — fetch their
    # created_at timestamps once and bucket the same way.
    note_rows = db.scalars(
        select(PaperNote.created_at).where(PaperNote.user_id == user_id)
    ).all()
    feynman_rows = db.scalars(
        select(FeynmanEntry.created_at).where(FeynmanEntry.user_id == user_id)
    ).all()
    mood_rows_ts = db.scalars(
        select(MoodEntry.created_at).where(MoodEntry.user_id == user_id)
    ).all()

    notes_this, notes_prev = _bucket(note_rows, lambda ts: ts)
    feyn_this, feyn_prev = _bucket(feynman_rows, lambda ts: ts)
    mood_this, mood_prev = _bucket(mood_rows_ts, lambda ts: ts)

    weekly_summary = WeeklySummary(
        this_week=WeeklySummaryCounts(
            pomodoros=pomo_this, tasks_done=task_this,
            notes=notes_this, feynman=feyn_this, moods=mood_this,
        ),
        prev_week=WeeklySummaryCounts(
            pomodoros=pomo_prev, tasks_done=task_prev,
            notes=notes_prev, feynman=feyn_prev, moods=mood_prev,
        ),
    )

    return UserStatsRead(
        days=days,
        daily_tasks=daily_tasks,
        daily_moods=daily_moods,
        daily_pomodoros=daily_pomodoros,
        total_tasks_done=total_tasks_done,
        total_pomodoros=total_pomodoros,
        total_notes=total_notes,
        total_feynman=total_feynman,
        total_moods=total_moods,
        weekly_summary=weekly_summary,
    )
