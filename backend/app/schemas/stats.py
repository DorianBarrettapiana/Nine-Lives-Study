"""Pydantic schemas for stats aggregates."""

from datetime import date

from pydantic import BaseModel


class DailyTaskStat(BaseModel):
    date: date
    total: int
    done: int


class DailyMoodStat(BaseModel):
    date: date
    mood: str


class DailyWorkStat(BaseModel):
    """Minutes of work (pomodoro_work + stopwatch) on a given local day."""

    date: date
    minutes: int


class WorkLabelStat(BaseModel):
    """Minutes grouped by the focus attached to work sessions."""

    label: str
    minutes: int


class WeeklySummaryCounts(BaseModel):
    work_minutes: int = 0
    tasks_done: int = 0
    notes: int = 0
    feynman: int = 0
    moods: int = 0


class WeeklySummary(BaseModel):
    """Last 7 days vs the prior 7 days, in the caller's local tz."""

    this_week: WeeklySummaryCounts
    prev_week: WeeklySummaryCounts


class UserStatsRead(BaseModel):
    days: int
    daily_tasks: list[DailyTaskStat]
    daily_moods: list[DailyMoodStat]
    daily_work_minutes: list[DailyWorkStat]
    work_labels: list[WorkLabelStat]
    total_tasks_done: int
    total_work_minutes: int
    total_notes: int
    total_feynman: int
    total_moods: int = 0
    weekly_summary: WeeklySummary | None = None
