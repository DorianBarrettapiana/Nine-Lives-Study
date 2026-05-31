"""Mood-history helpers shared by quick logging and the daily tracker."""

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.xp import ENTITY_MOOD, EVENT_MOOD, XP_MOOD_LOG, award_xp_event
from app.models.daily_tracker import DailyLog
from app.models.mood_entry import MoodEntry


def record_mood_entry(
    user_id: int,
    mood: str,
    reflection: str,
    db: Session,
) -> MoodEntry:
    entry = MoodEntry(user_id=user_id, mood=mood, reflection=reflection)
    db.add(entry)
    db.flush()
    award_xp_event(
        user_id=user_id,
        event_type=EVENT_MOOD,
        entity_type=ENTITY_MOOD,
        entity_id=entry.id,
        amount=XP_MOOD_LOG,
        db=db,
    )
    return entry


def sync_daily_log_mood(
    user_id: int,
    mood: str,
    day: date,
    db: Session,
) -> DailyLog:
    log = db.scalar(
        select(DailyLog).where(
            DailyLog.user_id == user_id,
            DailyLog.log_date == day,
        )
    )
    if log is None:
        log = DailyLog(
            user_id=user_id,
            log_date=day,
            mood=mood,
            reflection="",
            main_goal="",
        )
        db.add(log)
    else:
        log.mood = mood
    return log
