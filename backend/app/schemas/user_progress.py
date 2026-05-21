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
    # User's daily work-time goal in minutes — used by the sidebar progress meter.
    today_work_minutes_goal: int = 120
    # True if today qualifies as a "perfect day":
    #   - at least 1 daily task created and ALL today's tasks done
    #   - mood logged today
    #   - reflection text written today
    #   - at least 1 completed work session (pomodoro or stopwatch)
    is_today_perfect: bool = False

    model_config = {"from_attributes": False}
