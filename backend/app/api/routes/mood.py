"""Mood entry routes."""

import datetime as dt
from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.xp import award_xp
from app.models.mood_entry import MoodEntry
from app.models.user import User
from app.schemas.mood_entry import MoodEntryCreate, MoodEntryRead

XP_MOOD_LOG = 3

router = APIRouter(tags=["mood"])


@router.get("/users/{user_id}/mood", response_model=list[MoodEntryRead])
def list_mood_entries(
    user_id: int,
    days: int = Query(default=30, ge=1, le=365),
    db: Session = Depends(get_db),
) -> list[MoodEntry]:
    """Return mood entries for a user, most recent first, within the last N days."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    since = dt.datetime.now(timezone.utc) - dt.timedelta(days=days)
    stmt = (
        select(MoodEntry)
        .where(MoodEntry.user_id == user_id)
        .where(MoodEntry.created_at >= since)
        .order_by(MoodEntry.created_at.desc())
    )
    return list(db.scalars(stmt).all())


@router.post("/users/{user_id}/mood", response_model=MoodEntryRead, status_code=201)
def create_mood_entry(
    user_id: int,
    payload: MoodEntryCreate,
    db: Session = Depends(get_db),
) -> MoodEntry:
    """Record a mood entry for a user."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    entry = MoodEntry(user_id=user_id, mood=payload.mood, reflection=payload.reflection)
    db.add(entry)
    award_xp(user_id, XP_MOOD_LOG, db)
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/mood/{entry_id}", status_code=204)
def delete_mood_entry(entry_id: int, db: Session = Depends(get_db)) -> None:
    """Delete a mood entry."""
    entry = db.get(MoodEntry, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Mood entry not found.")
    db.delete(entry)
    db.commit()
