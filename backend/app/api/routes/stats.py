"""Stats aggregation routes (scoped to current user).

Counts for immutable activity events come from the xp_events ledger so
deletions don't rewrite history. Daily task completion ratios come from
the planner rows so unfinished work remains visible.
"""

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.core.focus import effective_focus_label
from app.core.xp import (
    ENTITY_POMODORO,
    ENTITY_STOPWATCH,
    EVENT_FEYNMAN,
    EVENT_MOOD,
    EVENT_NOTE,
    EVENT_POMODORO,
    EVENT_STOPWATCH,
    EVENT_TASK_DONE,
)
from app.models.daily_tracker import DailyTask
from app.models.feynman_entry import FeynmanEntry
from app.models.mood_entry import MoodEntry
from app.models.paper_note import PaperNote
from app.models.pomodoro_session import PomodoroSession
from app.models.project import Project
from app.models.stopwatch_session import StopwatchSession
from app.models.user import User
from app.models.xp_event import XpEvent
from app.schemas.stats import (
    DailyMoodStat,
    DailyTaskStat,
    DailyWorkStat,
    LabelRelabel,
    LabelRelabelResult,
    ProjectTimeStat,
    UserStatsRead,
    WeeklySummary,
    WeeklySummaryCounts,
    WorkLabelStat,
)

router = APIRouter(prefix="/stats", tags=["stats"])

# Display name for sessions with neither a work_label nor a linked task.
# Kept in sync with the get_stats aggregation below. This synthetic bucket
# can't be renamed — it isn't a real label, just "everything unlabelled".
UNLABELLED_LABEL = "Unlabelled work"


@router.get("", response_model=UserStatsRead)
def get_stats(
    days: int = Query(default=7, ge=1, le=90),
    tz_offset: int = Query(default=0, ge=-720, le=840),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserStatsRead:
    """Return aggregated stats for the current user over the last N days.

    Daily buckets are computed in the caller's local timezone via tz_offset
    (minutes east of UTC). Without this, events near midnight bucket against
    UTC and look "off by a day" to users several hours away from UTC.
    """
    user_id = current_user.id

    tz_delta = timedelta(minutes=tz_offset)
    today_local = (datetime.now(timezone.utc) + tz_delta).date()
    since = today_local - timedelta(days=days - 1)
    since_str = since.isoformat()

    def _local_day(ts) -> str | None:
        if ts is None:
            return None
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return (ts.astimezone(timezone.utc) + tz_delta).strftime("%Y-%m-%d")

    # --- Tasks per planning day: completion ratio includes unfinished work --
    # Keyed on planned_date (authoritative scheduling day). Backlog tasks
    # (planned_date NULL) aren't scheduled for any day, so they're excluded.
    task_rows = db.scalars(
        select(DailyTask)
        .where(DailyTask.user_id == user_id)
        .where(DailyTask.planned_date.is_not(None))
        .where(DailyTask.planned_date >= since)
        .where(DailyTask.planned_date <= today_local)
    ).all()
    task_counts: dict[str, dict[str, int]] = {}
    for task in task_rows:
        day = task.planned_date.isoformat()
        counts = task_counts.setdefault(day, {"total": 0, "done": 0})
        counts["total"] += 1
        if task.is_done:
            counts["done"] += 1
    daily_tasks = [
        DailyTaskStat(date=date.fromisoformat(d), total=c["total"], done=c["done"])
        for d, c in sorted(task_counts.items())
    ]

    # The immutable XP ledger still drives lifetime and weekly done counts.
    task_events = db.scalars(
        select(XpEvent)
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type == EVENT_TASK_DONE)
    ).all()

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
        if day not in latest_mood:
            latest_mood[day] = entry.mood
    daily_moods = [
        DailyMoodStat(date=date.fromisoformat(d), mood=m)
        for d, m in sorted(latest_mood.items())
    ]

    # --- Work minutes per day -----------------------------------------------
    # Computed from the xp_events ledger so that deleting a session does not
    # rewrite history — same invariant as task counts. For pomodoro_done and
    # stopwatch_done events, `amount` IS the work minutes (1 min = 1 XP).
    work_events = db.scalars(
        select(XpEvent)
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type.in_([EVENT_POMODORO, EVENT_STOPWATCH]))
    ).all()
    minutes_by_day: dict[str, int] = {}
    for ev in work_events:
        day = _local_day(ev.created_at)
        if day is None:
            continue
        minutes_by_day[day] = minutes_by_day.get(day, 0) + ev.amount

    daily_work_minutes = [
        DailyWorkStat(date=date.fromisoformat(d), minutes=m)
        for d, m in sorted(minutes_by_day.items())
        if d >= since_str
    ]
    total_work_minutes = sum(minutes_by_day.values())

    # Focus labels answer the more useful question: where did the time go?
    # Keep an explicit unlabeled bucket so users can see why binding work
    # sessions to a task or description improves the report.
    selected_work_events = [
        ev for ev in work_events
        if (_local_day(ev.created_at) or "") >= since_str
    ]
    pomodoro_ids = [
        ev.entity_id for ev in selected_work_events
        if ev.entity_type == ENTITY_POMODORO and ev.entity_id is not None
    ]
    stopwatch_ids = [
        ev.entity_id for ev in selected_work_events
        if ev.entity_type == ENTITY_STOPWATCH and ev.entity_id is not None
    ]
    pomodoro_sessions = {
        session.id: session for session in db.scalars(
            select(PomodoroSession)
        .where(PomodoroSession.id.in_(pomodoro_ids))
        ).all()
    } if pomodoro_ids else {}
    stopwatch_sessions = {
        session.id: session for session in db.scalars(
            select(StopwatchSession)
        .where(StopwatchSession.id.in_(stopwatch_ids))
        ).all()
    } if stopwatch_ids else {}
    minutes_by_label: dict[str, int] = {}
    for ev in selected_work_events:
        if ev.entity_type == ENTITY_POMODORO:
            session = pomodoro_sessions.get(ev.entity_id)
        else:
            session = stopwatch_sessions.get(ev.entity_id)
        label = (
            effective_focus_label(session, db, unlabeled_label=UNLABELLED_LABEL)
            if session is not None else UNLABELLED_LABEL
        )
        minutes_by_label[label] = minutes_by_label.get(label, 0) + ev.amount
    work_labels = [
        WorkLabelStat(label=label, minutes=minutes)
        for label, minutes in sorted(
            minutes_by_label.items(), key=lambda item: (-item[1], item[0].lower()),
        )
    ]

    # --- Time per project (transitive through linked_task_id) ---------------
    # Reuses the already-fetched `pomodoro_sessions` / `stopwatch_sessions`
    # dicts so we don't issue another round-trip per row. A bulk fetch of
    # tasks + projects keeps this O(n) too.
    linked_task_ids = {
        sess.linked_task_id
        for sess in list(pomodoro_sessions.values()) + list(stopwatch_sessions.values())
        if sess.linked_task_id is not None
    }
    tasks_by_id = {
        task.id: task for task in db.scalars(
            select(DailyTask).where(DailyTask.id.in_(linked_task_ids))
        ).all()
    } if linked_task_ids else {}
    project_ids = {
        task.project_id
        for task in tasks_by_id.values()
        if task.project_id is not None
    }
    projects_by_id = {
        p.id: p for p in db.scalars(
            select(Project).where(Project.id.in_(project_ids))
        ).all()
    } if project_ids else {}

    minutes_by_project: dict[int | None, int] = {}
    for ev in selected_work_events:
        if ev.entity_type == ENTITY_POMODORO:
            session = pomodoro_sessions.get(ev.entity_id)
        else:
            session = stopwatch_sessions.get(ev.entity_id)
        project_id: int | None = None
        if session is not None and session.linked_task_id is not None:
            task = tasks_by_id.get(session.linked_task_id)
            if task is not None and task.user_id == user_id:
                project_id = task.project_id
        minutes_by_project[project_id] = minutes_by_project.get(project_id, 0) + ev.amount

    time_per_project = [
        ProjectTimeStat(
            project_id=pid,
            name=(projects_by_id[pid].name if (pid is not None and pid in projects_by_id)
                  else "(no project)"),
            minutes=minutes,
        )
        for pid, minutes in sorted(
            minutes_by_project.items(),
            # Sort: actual projects first (by minutes desc), "(no project)" last
            # so the user's named threads dominate the visual hierarchy.
            key=lambda item: (item[0] is None, -item[1]),
        )
    ]

    # --- Other totals -------------------------------------------------------
    total_tasks_done = db.scalar(
        select(func.count(XpEvent.id))
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type == EVENT_TASK_DONE)
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

    _ = (EVENT_NOTE, EVENT_FEYNMAN, EVENT_MOOD)

    # --- Weekly summary: last 7 days vs prior 7 days (caller's local tz) ----
    this_week_start = today_local - timedelta(days=6)
    prev_week_start = today_local - timedelta(days=13)
    prev_week_end   = today_local - timedelta(days=7)

    def _bucket_count(items, get_ts) -> tuple[int, int]:
        this_n = prev_n = 0
        for item in items:
            day = _local_day(get_ts(item))
            if day is None:
                continue
            if this_week_start.isoformat() <= day <= today_local.isoformat():
                this_n += 1
            elif prev_week_start.isoformat() <= day <= prev_week_end.isoformat():
                prev_n += 1
        return this_n, prev_n

    def _bucket_minutes() -> tuple[int, int]:
        this_m = prev_m = 0
        for ev in work_events:
            day = _local_day(ev.created_at)
            if day is None:
                continue
            if this_week_start.isoformat() <= day <= today_local.isoformat():
                this_m += ev.amount
            elif prev_week_start.isoformat() <= day <= prev_week_end.isoformat():
                prev_m += ev.amount
        return this_m, prev_m

    work_this, work_prev = _bucket_minutes()
    task_this, task_prev = _bucket_count(task_events, lambda e: e.created_at)

    note_rows = db.scalars(
        select(PaperNote.created_at).where(PaperNote.user_id == user_id)
    ).all()
    feynman_rows = db.scalars(
        select(FeynmanEntry.created_at).where(FeynmanEntry.user_id == user_id)
    ).all()
    mood_rows_ts = db.scalars(
        select(MoodEntry.created_at).where(MoodEntry.user_id == user_id)
    ).all()
    notes_this, notes_prev = _bucket_count(note_rows, lambda ts: ts)
    feyn_this, feyn_prev = _bucket_count(feynman_rows, lambda ts: ts)
    mood_this, mood_prev = _bucket_count(mood_rows_ts, lambda ts: ts)

    weekly_summary = WeeklySummary(
        this_week=WeeklySummaryCounts(
            work_minutes=work_this, tasks_done=task_this,
            notes=notes_this, feynman=feyn_this, moods=mood_this,
        ),
        prev_week=WeeklySummaryCounts(
            work_minutes=work_prev, tasks_done=task_prev,
            notes=notes_prev, feynman=feyn_prev, moods=mood_prev,
        ),
    )

    return UserStatsRead(
        days=days,
        daily_tasks=daily_tasks,
        daily_moods=daily_moods,
        daily_work_minutes=daily_work_minutes,
        work_labels=work_labels,
        time_per_project=time_per_project,
        total_tasks_done=total_tasks_done,
        total_work_minutes=total_work_minutes,
        total_notes=total_notes,
        total_feynman=total_feynman,
        total_moods=total_moods,
        weekly_summary=weekly_summary,
    )


@router.post("/labels/relabel", response_model=LabelRelabelResult)
def relabel_focus_label(
    payload: LabelRelabel,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LabelRelabelResult:
    """Rename or merge a focus label across ALL of the user's sessions.

    This is the "self-organize your time records" operation. It rewrites
    `work_label` on every pomodoro/stopwatch session whose *effective*
    label (work_label, or the linked task's text when blank) equals
    `from_label`, setting it to `to_label`.

    - Rename: `to_label` is a brand-new name → those sessions now report
      under the new name everywhere.
    - Merge: `to_label` is an existing label → the two buckets combine and
      their minutes add up, because aggregation keys on the string.

    Sessions that inherited their label from a linked task get the label
    *materialized* onto `work_label`, so the rename sticks even though the
    task text is unchanged. The task hierarchy itself is never touched —
    there is no parent/child ambiguity because we only relabel the
    time-record strings, not the tasks.
    """
    from_label = payload.from_label.strip()
    to_label = payload.to_label.strip()

    if not from_label or not to_label:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Both from_label and to_label must be non-empty.",
        )
    # The synthetic unlabelled bucket isn't a real label; renaming it would
    # silently stamp a name onto every genuinely-unrelated unlabelled block.
    if from_label == UNLABELLED_LABEL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The unlabelled bucket can't be renamed or merged.",
        )
    if from_label == to_label:
        return LabelRelabelResult(
            updated_sessions=0, from_label=from_label, to_label=to_label,
        )

    updated = 0
    for model in (PomodoroSession, StopwatchSession):
        sessions = db.scalars(
            select(model).where(model.user_id == current_user.id)
        ).all()
        for session in sessions:
            label = effective_focus_label(
                session, db, unlabeled_label=UNLABELLED_LABEL,
            )
            if label == from_label:
                session.work_label = to_label[:300]
                updated += 1

    db.commit()
    return LabelRelabelResult(
        updated_sessions=updated, from_label=from_label, to_label=to_label,
    )
