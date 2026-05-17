"""Mood entry routes (scoped to current user)."""

import datetime as dt
from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.xp import award_xp
from app.models.mood_entry import MoodEntry
from app.models.user import User
from app.schemas.mood_entry import MoodEntryCreate, MoodEntryRead

XP_MOOD_LOG = 3

router = APIRouter(prefix="/mood", tags=["mood"])


@router.get("", response_model=list[MoodEntryRead])
def list_mood_entries(
    days: int = Query(default=30, ge=1, le=365),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MoodEntry]:
    since = dt.datetime.now(timezone.utc) - dt.timedelta(days=days)
    stmt = (
        select(MoodEntry)
        .where(MoodEntry.user_id == current_user.id)
        .where(MoodEntry.created_at >= since)
        .order_by(MoodEntry.created_at.desc())
    )
    return list(db.scalars(stmt).all())


@router.post("", response_model=MoodEntryRead, status_code=201)
def create_mood_entry(
    payload: MoodEntryCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MoodEntry:
    entry = MoodEntry(user_id=current_user.id, mood=payload.mood, reflection=payload.reflection)
    db.add(entry)
    award_xp(current_user.id, XP_MOOD_LOG, db)
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/{entry_id}", status_code=204)
def delete_mood_entry(
    entry_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    entry = db.get(MoodEntry, entry_id)
    if entry is None or entry.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mood entry not found.")
    db.delete(entry)
    db.commit()
