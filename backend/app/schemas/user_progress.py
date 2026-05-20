"""Pydantic schemas for user XP progress."""

from pydantic import BaseModel


class UserProgressRead(BaseModel):
    """Public representation of a user's XP and level."""

    user_id: int
    xp: int
    level: int
    xp_in_level: int
    xp_to_next_level: int

    # Consecutive days (in caller's local tz) with at least one completed
    # work pomodoro. Today counts only if a work session is completed today;
    # but the streak isn't broken until the *end* of the next day with no
    # activity (so users have a grace day to come back without seeing 0).
    streak_days: int = 0
    # True if the user already has a completed work session for today.
    streak_active_today: bool = False

    # Minutes of work (pomodoro + stopwatch) completed today, in the caller's
    # local timezone. Shown on the pomodoro and stopwatch cards.
    today_work_minutes: int = 0

    model_config = {"from_attributes": False}
