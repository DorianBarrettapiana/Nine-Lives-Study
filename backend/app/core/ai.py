"""AI summary generation via the Anthropic Claude API.

Single chokepoint for every Claude call the app makes. Each summary kind has:
  - A `gather_*` function that pulls the relevant rows from the DB into a
    JSON-serialisable dict (kept tiny — Claude doesn't need raw IDs).
  - A prompt template (system + user) tailored to the kind.

We use the official `anthropic` SDK with adaptive thinking on
`claude-opus-4-7` (the skill default). Prompts are small (a few KB at most),
so the 4096-token minimum cacheable-prefix threshold means prompt caching
won't fire in practice — we deliberately don't sprinkle `cache_control`
markers that wouldn't kick in. If the prompts grow past ~4K tokens later
(e.g. long-window paper-notes summaries), revisit.

If ANTHROPIC_API_KEY is unset, `is_configured()` returns False; routes
should 503 cleanly so open-source forks without a key keep building.
"""

from __future__ import annotations

import json
import os
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.focus import effective_focus_label
from app.core.streak import compute_streak
from app.core.xp import (
    ENTITY_POMODORO,
    ENTITY_STOPWATCH,
    EVENT_POMODORO,
    EVENT_STOPWATCH,
)
from app.models.daily_tracker import DailyLog, DailyTask
from app.models.feynman_entry import FeynmanEntry
from app.models.milestone import Milestone
from app.models.mood_entry import MoodEntry
from app.models.paper_note import PaperNote
from app.models.pomodoro_session import PomodoroSession
from app.models.project import Project
from app.models.stopwatch_session import StopwatchSession
from app.models.xp_event import XpEvent

# --- SDK initialisation -----------------------------------------------------

# Imported lazily so missing-key environments don't pay import cost. The
# Anthropic client itself is cheap to construct — we still cache it.
_client = None


def _api_key() -> str | None:
    return os.environ.get("ANTHROPIC_API_KEY") or None


def is_configured() -> bool:
    """True iff ANTHROPIC_API_KEY is present in the process environment.

    Routes check this and return 503 when False so the frontend can hide
    AI features gracefully on un-keyed deployments.
    """
    return _api_key() is not None


def _get_client():
    global _client
    if _client is None:
        # Lazy import lets the rest of the app start even when `anthropic`
        # isn't installed in a stripped-down environment.
        import anthropic  # noqa: WPS433  (intentional local import)
        _client = anthropic.Anthropic(api_key=_api_key())
    return _client


SummaryKind = Literal["weekly", "monthly", "stage", "feynman_review", "reflections"]

# Single source of truth for which model we call. Pinned to a major version
# so a Claude minor release doesn't silently change behaviour mid-week.
_MODEL = "claude-opus-4-7"


@dataclass
class SummaryResult:
    content: str
    model: str
    tokens_in: int
    tokens_out: int


# --- Data gatherers ---------------------------------------------------------
#
# Each gatherer returns a small JSON-friendly dict the prompt template can
# embed. Keep them DB-bound and stupid — no formatting, no business logic.


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def gather_weekly(
    user_id: int,
    window_start_utc: datetime,
    db: Session,
    window_end_utc: datetime | None = None,
) -> dict:
    """Pull activity data for the weekly-recap prompt.

    `window_start_utc` is the inclusive lower bound (a Monday 00:00 in the
    user's local TZ, converted to UTC by the route). `window_end_utc` is
    exclusive — defaults to start + 7 days for the classic "completed
    week" Tuesday-slot view; the Friday slot passes "now" to get a
    Mon-through-now pulse instead.
    """
    week_end_utc = window_end_utc if window_end_utc is not None else (
        window_start_utc + timedelta(days=7)
    )
    week_start_utc = window_start_utc

    # Work minutes per day from XP events (the same source the stats view uses,
    # so the numbers reconcile with what the user already sees).
    work_events = db.scalars(
        select(XpEvent)
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type.in_([EVENT_POMODORO, EVENT_STOPWATCH]))
        .where(XpEvent.created_at >= week_start_utc.replace(tzinfo=None))
        .where(XpEvent.created_at < week_end_utc.replace(tzinfo=None))
    ).all()
    minutes_by_day: Counter[str] = Counter()
    for ev in work_events:
        ts = _aware(ev.created_at)
        if ts is None:
            continue
        minutes_by_day[ts.date().isoformat()] += ev.amount

    # Daily tasks planned in the window (carry-over completion counts).
    # Keyed on planned_date; backlog tasks (NULL) are excluded by the range.
    tasks = db.scalars(
        select(DailyTask)
        .where(DailyTask.user_id == user_id)
        .where(DailyTask.planned_date >= week_start_utc.date())
        .where(DailyTask.planned_date < week_end_utc.date())
    ).all()
    tasks_done = sum(1 for t in tasks if t.is_done)
    tasks_total = len(tasks)

    # Mood entries.
    moods = db.scalars(
        select(MoodEntry)
        .where(MoodEntry.user_id == user_id)
        .where(MoodEntry.created_at >= week_start_utc.replace(tzinfo=None))
        .where(MoodEntry.created_at < week_end_utc.replace(tzinfo=None))
    ).all()
    mood_counter = Counter(m.mood for m in moods if m.mood)

    # Daily-log reflections (the textual self-report).
    logs = db.scalars(
        select(DailyLog)
        .where(DailyLog.user_id == user_id)
        .where(DailyLog.log_date >= week_start_utc.date())
        .where(DailyLog.log_date < week_end_utc.date())
    ).all()
    reflections = [
        {"date": log.log_date.isoformat(), "text": (log.reflection or "").strip()}
        for log in logs
        if (log.reflection or "").strip()
    ]

    # Feynman + paper notes created this week (creative output indicator).
    feynman_count = db.scalar(
        select(func.count(FeynmanEntry.id))
        .where(FeynmanEntry.user_id == user_id)
        .where(FeynmanEntry.created_at >= week_start_utc.replace(tzinfo=None))
        .where(FeynmanEntry.created_at < week_end_utc.replace(tzinfo=None))
    )
    paper_notes_count = db.scalar(
        select(func.count(PaperNote.id))
        .where(PaperNote.user_id == user_id)
        .where(PaperNote.created_at >= week_start_utc.replace(tzinfo=None))
        .where(PaperNote.created_at < week_end_utc.replace(tzinfo=None))
    )

    streak_days, _active_today = compute_streak(user_id, tz_offset_minutes=0, db=db)

    # Work minutes grouped by the session's focus snapshot. Legacy sessions
    # without a snapshot fall back to their linked daily task, then to an
    # explicit unlabeled bucket. This also includes temporary descriptions.
    #
    # Same loop also rolls up minutes by the linked task's project. Sessions
    # have no direct project_id — they inherit transitively through
    # linked_task_id → daily_task.project_id (intentional, single source of
    # truth). Sessions whose task has no project, or which have no linked
    # task at all, contribute to the "(no project)" bucket.
    time_per_task: Counter[str] = Counter()
    time_per_project: Counter[str] = Counter()
    papers_touched: Counter[int] = Counter()
    project_name_cache: dict[int, str] = {}

    def _project_name(project_id: int | None) -> str:
        if project_id is None:
            return "(no project)"
        if project_id not in project_name_cache:
            project = db.get(Project, project_id)
            project_name_cache[project_id] = (
                project.name if (project is not None and project.user_id == user_id) else "(unknown)"
            )
        return project_name_cache[project_id]

    for ev in work_events:
        if ev.entity_type == ENTITY_POMODORO:
            sess = db.get(PomodoroSession, ev.entity_id)
        elif ev.entity_type == ENTITY_STOPWATCH:
            sess = db.get(StopwatchSession, ev.entity_id)
        else:
            continue
        if sess is None:
            continue
        # First ~120 chars only: descriptions can be long and bulk up the
        # prompt without adding signal.
        task_label = effective_focus_label(
            sess,
            db,
            unlabeled_label="(unlabeled)",
            max_length=120,
        )
        time_per_task[task_label] += ev.amount

        # Resolve project and reading attribution transitively through the
        # linked task. Sessions intentionally keep a single task FK.
        project_id: int | None = None
        if sess.linked_task_id is not None:
            task = db.get(DailyTask, sess.linked_task_id)
            if task is not None and task.user_id == user_id:
                project_id = task.project_id
                if task.paper_note_id is not None:
                    papers_touched[task.paper_note_id] += ev.amount
        time_per_project[_project_name(project_id)] += ev.amount

    paper_touch_rows = []
    for note_id, minutes in papers_touched.most_common():
        note = db.get(PaperNote, note_id)
        if note is not None and note.user_id == user_id:
            paper_touch_rows.append({
                "title": note.title,
                "reading_status": note.reading_status,
                "focus_minutes": minutes,
                # The note body is the real signal for a research recap —
                # what the user took away and what they're still asking.
                # Truncated so a few long notes don't dominate the prompt.
                "key_points": (note.key_points or "").strip()[:400],
                "open_questions": (note.questions or "").strip()[:400],
            })

    unresolved_gaps = db.scalars(
        select(FeynmanEntry)
        .where(FeynmanEntry.user_id == user_id)
        .where(FeynmanEntry.gaps != "")
        .order_by(FeynmanEntry.updated_at.desc())
        .limit(10)
    ).all()

    # Looming deadlines (next 14 days, not yet done). Capped at 5 entries
    # so the prompt doesn't bloat for users with long task lists. The
    # recap prompt uses these to surface a "what's pressing next week"
    # line, separate from the retrospective.
    today_d = (week_end_utc.date() if window_end_utc is None else datetime.now(timezone.utc).date())
    upcoming_rows = db.scalars(
        select(DailyTask)
        .where(DailyTask.user_id == user_id)
        .where(DailyTask.is_done == False)  # noqa: E712
        .where(DailyTask.due_date.is_not(None))
        .where(DailyTask.due_date <= today_d + timedelta(days=14))
        .order_by(DailyTask.due_date.asc())
        .limit(5)
    ).all()
    upcoming = [
        {
            "text": (t.text or "")[:120],
            "due_date": t.due_date.isoformat() if t.due_date else None,
            "overdue": t.due_date is not None and t.due_date < today_d,
        }
        for t in upcoming_rows
    ]

    return {
        "week_start": week_start_utc.date().isoformat(),
        "week_end": (week_end_utc - timedelta(days=1)).date().isoformat(),
        "total_work_minutes": sum(minutes_by_day.values()),
        "work_minutes_per_day": dict(minutes_by_day),
        # Sorted descending so the highest-investment task is first in the
        # serialized JSON — keeps the prompt's natural narrative order.
        "time_per_task_minutes": dict(time_per_task.most_common()),
        "time_per_project_minutes": dict(time_per_project.most_common()),
        "tasks_done": tasks_done,
        "tasks_total": tasks_total,
        "moods": dict(mood_counter),
        "reflections": reflections,
        "feynman_entries_created": int(feynman_count or 0),
        "paper_notes_created": int(paper_notes_count or 0),
        "papers_touched": paper_touch_rows,
        "unresolved_feynman_gaps": [
            {"concept": entry.concept, "gaps": (entry.gaps or "")[:500]}
            for entry in unresolved_gaps
        ],
        "streak_days": streak_days,
        "upcoming_deadlines": upcoming,
    }


def gather_with_previous_period(
    user_id: int,
    window_start_utc: datetime,
    window_end_utc: datetime,
    db: Session,
) -> dict:
    """Pair a recap window with the same-length immediately preceding one."""
    duration = window_end_utc - window_start_utc
    return {
        "current_period": gather_weekly(user_id, window_start_utc, db, window_end_utc),
        "previous_period": gather_weekly(
            user_id, window_start_utc - duration, db, window_start_utc,
        ),
    }


def gather_near_milestones(
    user_id: int, db: Session, horizon_days: int = 60,
) -> list[dict]:
    """Upcoming milestones (date-anchored targets) within `horizon_days`.

    Distinct from `upcoming_deadlines`, which are day-level tasks. A
    milestone is the *thing the user is working toward* (a chapter due
    date, an abstract deadline) — it's the anchor that lets the recap
    ask "did this week move the needle on what matters". Forward-looking,
    so it's gathered once (not per period) and attached at the top level.
    """
    today = datetime.now(timezone.utc).date()
    rows = db.scalars(
        select(Milestone)
        .where(Milestone.user_id == user_id)
        .where(Milestone.is_archived == False)  # noqa: E712
        .where(Milestone.due_date >= today)
        .where(Milestone.due_date <= today + timedelta(days=horizon_days))
        .order_by(Milestone.due_date.asc())
        .limit(5)
    ).all()
    return [
        {
            "title": m.title,
            "due_date": m.due_date.isoformat(),
            "days_left": (m.due_date - today).days,
        }
        for m in rows
    ]


def gather_feynman_review(user_id: int, entry_id: int, db: Session) -> dict | None:
    entry = db.get(FeynmanEntry, entry_id)
    if entry is None or entry.user_id != user_id:
        return None
    return {
        "concept": entry.concept,
        "explanation": entry.explanation or "",
        "gaps": entry.gaps or "",
        "analogy": entry.analogy or "",
        "written_at": _aware(entry.created_at).isoformat() if entry.created_at else None,
    }


def gather_reflections(user_id: int, since_utc: datetime, db: Session) -> dict:
    logs = db.scalars(
        select(DailyLog)
        .where(DailyLog.user_id == user_id)
        .where(DailyLog.log_date >= since_utc.date())
        .order_by(DailyLog.log_date.desc())
    ).all()
    return {
        "since": since_utc.date().isoformat(),
        "entries": [
            {
                "date": log.log_date.isoformat(),
                "mood": log.mood or "",
                "text": (log.reflection or "").strip(),
            }
            for log in logs
            if (log.reflection or "").strip()
        ],
    }


# --- Prompts ----------------------------------------------------------------
#
# System prompts deliberately establish a tone (PhD-peer, not corporate
# cheerleader) and bound output length so the markdown stays scannable.


# Shared advice that applies to both slots — peer tone, no invention,
# anti-cheerleading. Each slot prompt below appends slot-specific framing.
_SHARED_RECAP_TONE = """\
You are a thoughtful study coach for a PhD student. Tone: peer-to-peer,
never corporate. Acknowledge real effort, flag patterns gently, and
avoid empty validation. If a metric is low, say so — PhD students see
through cheerleading.

KEY DATA — two complementary breakdowns:
- `time_per_project_minutes` is the user's own research-thread buckets
  (e.g. "DiffusionPolicy", "Survey draft"). When 2+ projects show up,
  THIS is the spine of the recap — PhD students live by which thread
  the week went into. Quote project names verbatim.
- `time_per_task_minutes` is the per-task breakdown within those
  threads. Use it for granularity once you've framed the project mix.

If "(no project)" or "(unlabeled)" is a large share, gently note it
so the user can start tagging more work. Never invent project or task
labels — quote them verbatim from the keys.

`upcoming_deadlines` lists tasks the user marked with a due date in
the next two weeks. Any entry with `overdue: true` is already late.
Surface these in a short "what's pressing next" sentence — it's the
single most useful forward-looking item we can give a PhD student.
If the list is empty, don't fabricate urgency.

`upcoming_milestones` (top-level, not per-period) lists the date-anchored
targets the user is working toward — a chapter due date, an abstract
deadline, a defense. Each has `days_left`. This is the ANCHOR of a
research recap: tie the week's work back to whichever milestone is
nearest, e.g. "with the X abstract N days out, this week's time on Y
is/isn't moving that". Quote the milestone title verbatim. If the list
is empty, skip this — never invent a milestone or deadline.

The input wraps the period fields under `current_period` and
`previous_period`. Compare them: mention one meaningful change in focus
time or work mix.

Include a **Papers touched** section when `current_period.papers_touched`
is non-empty. Each entry now carries `key_points` (what the user took
away) and `open_questions` (what they're still asking). Use these to make
the section substantive — quote a real takeaway or an open question
rather than just listing titles and minutes. Treat `open_questions` and
`current_period.unresolved_feynman_gaps` as the user's live research
threads: surface the most concrete one as fuel for the Next step.

ALWAYS finish the recap with these lines in exactly this format (verbatim,
including the asterisks, each on its own line):

**Next step:** <one short, concrete action, max 80 chars>
**Due:** <YYYY-MM-DD>
**Project:** <one verbatim project name from time_per_project_minutes, or (no project)>

These lines are parsed by the frontend to offer a one-click task with a
deadline and project. The Next step must move the RESEARCH forward, not
just "work more". In order of preference, derive it from:
  1. a concrete `open_questions` / `unresolved_feynman_gaps` item — turn
     it into the next question to resolve;
  2. a paper to read/finish, or a section to write, implied by
     `papers_touched` and `reading_status`;
  3. the work needed for the nearest `upcoming_milestones` entry.
Make it imperative and specific (e.g. "Derive the variance bound in
Paper A §3 and write 1 paragraph") rather than vague ("focus more").
Anchor the **Due:** date sensibly against the nearest milestone if one
exists. Avoid generic productivity advice.\
"""

# Friday slot: retrospective on the past 7 days (Sat-Fri) — the most
# recent weekend through today. Past tense; closure framing.
_SYSTEM_WEEKLY_RETROSPECTIVE = _SHARED_RECAP_TONE + """

This is a RETROSPECTIVE on the **past 7 days** (Saturday through this
Friday) — the most recent weekend through today. Use past tense
throughout. The recap should help the user close the loop on the week
that just finished.

Output format: Markdown. ~250 words total. Sections:
- **This week in numbers** (1-2 lines: hours, sessions, streak)
- **Where your time went** (2-3 bullets quoting the largest task labels
  verbatim, with their hour counts)
- **What stood out** (1-2 honest observations, including any dips)
- **One thing to carry into next week** (grounded in the data above)

Then the **Next step:** line (see KEY DATA above).
"""

# Friday slot: mid-week pulse. Looks at current ISO week so far (Mon-now).
# Present tense; momentum framing; the week isn't done so don't write a
# eulogy for it.
_SYSTEM_WEEKLY_PULSE = _SHARED_RECAP_TONE + """

This is a MID-WEEK PULSE on the **current week so far** (Mon through
now). The week isn't over — write in present tense, with a "where are
we, what's left" frame rather than a retrospective.

Output format: Markdown. ~200 words total (shorter than the Tuesday
retrospective — the user is mid-flow and shouldn't lose 15 minutes
reading). Sections:
- **This week so far** (1 line: hours, sessions, streak)
- **What's getting your attention** (2 bullets quoting task labels
  verbatim, with hour counts)
- **What's worth adjusting before Sunday** (1-2 short observations —
  things still actionable in the remaining days)

Then the **Next step:** line (see KEY DATA above). For Friday pulse,
this should be doable Sat-Sun.
"""

_SYSTEM_PROGRESS_RECAP = _SHARED_RECAP_TONE + """

This is a LONGER-HORIZON progress recap for a PhD student preparing for an
advisor conversation. Summarize the current period and compare it with the
immediately preceding period of the same length.

Output format: Markdown. ~400 words total. Sections:
- **Progress in numbers** (hours, task completion, paper notes, Feynman entries)
- **Where the time went** (largest task labels with hours)
- **Papers touched** (titles and reading minutes, if any)
- **What changed from the previous period** (2-3 honest observations)
- **Open loops for the next advisor conversation** (include useful Feynman gaps)

Then the **Next step:** line (see KEY DATA above).
"""

_SYSTEM_FEYNMAN = """\
You are evaluating a Feynman-technique self-explanation. The user wrote
an explanation of a concept, listed their own gaps, and an analogy.

Your job: be a kind but rigorous reader. Find gaps the user *didn't*
list. Suggest where the analogy might mislead. Don't praise the
explanation — engage with it.

Output format: Markdown. ~200 words.
- **What lands** (1 bullet, brief)
- **Gaps you may have missed** (2-3 specific weak spots in the
  explanation itself — quote phrases when useful)
- **Where the analogy strains** (1 bullet)
- **One follow-up question to answer next time** (concrete, narrow)\
"""

_SYSTEM_REFLECTIONS = """\
You are a journaling companion. The user shares their daily reflections
over a period. Surface patterns without judgment.

Output format: Markdown. ~250 words.
- **Recurring themes** (2-3 — quote short phrases verbatim)
- **What seems to lift them** vs **what seems to drain them**
- **One self-care suggestion** grounded in their own words

Never invent emotions or events not present in the text. If the entries
are sparse, say so honestly and suggest one prompt for next time.\
"""


def _summarise(system_prompt: str, user_payload: dict, max_tokens: int) -> SummaryResult:
    """Single Claude call. Adaptive thinking on Opus 4.7 (skill default)."""
    client = _get_client()
    # Embed the gathered data as a single JSON code block. Keeps the prompt
    # boundary obvious to the model and easy to debug from logs.
    user_text = (
        "Here's the data:\n\n"
        f"```json\n{json.dumps(user_payload, indent=2, ensure_ascii=False)}\n```\n\n"
        "Write the summary."
    )
    response = client.messages.create(
        model=_MODEL,
        max_tokens=max_tokens,
        thinking={"type": "adaptive"},
        system=system_prompt,
        messages=[{"role": "user", "content": user_text}],
    )
    # The response may contain a thinking block before the text block —
    # extract only the text we want to surface to the user.
    text_chunks = [b.text for b in response.content if b.type == "text"]
    return SummaryResult(
        content="\n".join(text_chunks).strip(),
        model=response.model,
        tokens_in=response.usage.input_tokens,
        tokens_out=response.usage.output_tokens,
    )


# --- Public entry points ----------------------------------------------------


def summarise_weekly_retrospective(
    user_id: int, window_start_utc: datetime, db: Session,
) -> SummaryResult:
    """Friday slot — recap of the past 7 days (Sat-Fri), i.e. the most
    recent weekend through today. `window_start_utc` is the Saturday that
    starts the window; the recap gathers the 7 days from there and
    compares against the immediately preceding 7-day block."""
    data = gather_with_previous_period(
        user_id,
        window_start_utc,
        window_start_utc + timedelta(days=7),
        db,
    )
    data["window_label"] = "past 7 days (Sat through Fri)"
    data["upcoming_milestones"] = gather_near_milestones(user_id, db)
    return _summarise(_SYSTEM_WEEKLY_RETROSPECTIVE, data, max_tokens=1500)


def summarise_weekly_pulse(
    user_id: int, this_week_start_utc: datetime, db: Session,
) -> SummaryResult:
    """Friday slot — pulse on current ISO week so far (Mon-now)."""
    now_utc = datetime.now(timezone.utc)
    data = gather_with_previous_period(
        user_id,
        this_week_start_utc,
        now_utc,
        db,
    )
    data["window_label"] = "current week so far (Mon-now)"
    # Shorter max_tokens than retrospective — prompt asks for ~200 words
    # vs ~250; cap reflects that.
    return _summarise(_SYSTEM_WEEKLY_PULSE, data, max_tokens=1200)


def summarise_progress_recap(
    user_id: int,
    window_start_utc: datetime,
    window_end_utc: datetime,
    period_label: str,
    db: Session,
) -> SummaryResult:
    data = gather_with_previous_period(user_id, window_start_utc, window_end_utc, db)
    data["window_label"] = period_label
    data["upcoming_milestones"] = gather_near_milestones(user_id, db, horizon_days=120)
    return _summarise(_SYSTEM_PROGRESS_RECAP, data, max_tokens=2400)


def summarise_feynman_review(user_id: int, entry_id: int, db: Session) -> SummaryResult | None:
    data = gather_feynman_review(user_id, entry_id, db)
    if data is None:
        return None
    return _summarise(_SYSTEM_FEYNMAN, data, max_tokens=1200)


def summarise_reflections(user_id: int, since_utc: datetime, db: Session) -> SummaryResult:
    data = gather_reflections(user_id, since_utc, db)
    return _summarise(_SYSTEM_REFLECTIONS, data, max_tokens=1500)


# --- Backplanning suggestions -----------------------------------------------
#
# Used by /milestones/{id}/suggest-children when the user has opted in to AI.
# Differs from the summarisers above in two ways:
#   * Output is a structured JSON list, not prose — we parse it back out.
#   * We bound the work: capped check-points, capped tokens, strict schema
#     validation. On any failure (no key, no opt-in, parse error, bad shape,
#     SDK exception) we return None so the route can fall back to the
#     deterministic rule engine in `app.core.backplanning`.

_SYSTEM_BACKPLAN = """\
You are a PhD productivity coach helping the user backplan one milestone.

Given:
- a parent milestone title and its due date,
- today's date,
- a list of the user's existing milestones (so you don't propose conflicts).

Propose 3 to 6 intermediate check-points that decompose the work into
weekly-or-biweekly chunks. Each check-point is a (title, due_date) pair.

Constraints (HARD — violating any voids the response):
- Every due_date must be strictly between today and the parent due_date,
  inclusive of neither.
- Dates must be in YYYY-MM-DD format.
- Titles must be short, imperative phrases (≤ 60 chars). No emoji,
  no markdown, no quotes.
- Return between 3 and 6 items.
- Output ONLY a JSON object of the shape:
    {"suggestions": [{"title": "...", "due_date": "YYYY-MM-DD"}, ...]}
  No prose before or after. No code fences. No commentary.

Style:
- Order earliest-first.
- Prefer concrete verbs ("Draft", "Run", "Revise") over vague ones
  ("Work on").
- If the parent looks like a paper deadline, follow the canonical
  outline → draft → review → revise → submit arc. For a defense,
  use slides + mock rehearsals. For an application, use draft +
  letters + submit.\
"""


def _parse_backplan_json(raw: str) -> list[dict] | None:
    """Tolerantly pull the suggestions list out of a model response.

    The system prompt asks for bare JSON, but models occasionally wrap
    it in a code fence anyway. Strip those before parsing. Returns None
    on any error so the route falls back to rules.
    """
    text = raw.strip()
    if text.startswith("```"):
        # ```json\n...\n``` → drop the opening fence line and the trailing fence
        nl = text.find("\n")
        if nl != -1:
            text = text[nl + 1 :]
        if text.endswith("```"):
            text = text[: -3]
        text = text.strip()
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    items = parsed.get("suggestions")
    if not isinstance(items, list):
        return None
    return items


def suggest_backplan_via_llm(
    parent_title: str,
    parent_due_iso: str,
    today_iso: str,
    sibling_milestones: list[dict],
) -> list[dict] | None:
    """Ask Claude for 3–6 intermediate check-points; return raw items or None.

    The caller (`app.api.routes.milestones`) is responsible for:
      * gating on `is_configured()` AND the user's `ai_opt_in` flag
      * validating each item's date is strictly between today and
        parent_due (defense-in-depth; the prompt also says so)
      * coercing the items into `MilestoneSuggestion` instances

    Returns None on any failure mode — caller falls back to the rules
    engine, which never fails.
    """
    if not is_configured():
        return None
    payload = {
        "today": today_iso,
        "parent": {"title": parent_title, "due_date": parent_due_iso},
        # Send up to 20 siblings so the model can avoid colliding with
        # existing milestones (e.g. "you already have a check-point on
        # 2026-08-14"). Trimmed for token budget.
        "existing_milestones": sibling_milestones[:20],
    }
    try:
        result = _summarise(_SYSTEM_BACKPLAN, payload, max_tokens=600)
    except Exception:  # noqa: BLE001 — any SDK/network failure → rules
        return None
    return _parse_backplan_json(result.content)


# --- Task breakdown ("just get started") ------------------------------------
#
# Used by /daily/tasks/{id}/suggest-steps when the user opens the break-down
# panel on an intimidating task and asks the model for help. Same shape as the
# backplan path — structured JSON, parsed back, no DB write — but tuned for the
# *activation-energy* problem specific to procrastination: the first step is a
# sub-2-minute physical action, not a "real" chunk of work. Falls back to the
# manual 3-question panel (handled entirely on the frontend) on any failure.

_SYSTEM_TASK_STEPS = """\
You are a PhD productivity coach helping a student who is STUCK or
procrastinating on one task. They've named a task that feels too big,
vague, or intimidating to start. Your job is to dissolve the activation
energy by breaking it into concrete, physical next steps.

You are given:
- the task text,
- optional context (its project, due date) — use it only to make the
  steps specific; never invent a deadline or scope not implied.

Produce 3 to 5 ordered steps. HARD rules (violating any voids the response):
- The FIRST step must be a trivial "just get started" action that takes
  under 2 minutes and requires zero decisions — opening the file, writing
  one sentence, listing three names, pasting the outline. The whole point
  is that it's too small to refuse.
- Each later step is one concrete, physical action (start with a verb:
  "Open", "Write", "List", "Run", "Read", "Sketch"). No vague verbs like
  "work on", "think about", "continue".
- Each step <= 80 chars. No emoji, no markdown, no numbering, no quotes.
- Steps must be doable in one sitting each; if the task is genuinely
  large, the steps cover only getting the FIRST meaningful chunk done.
- Return between 3 and 5 items.
- Output ONLY a JSON object of the shape:
    {"steps": ["...", "...", "..."]}
  No prose before or after. No code fences. No commentary.\
"""


def _parse_task_steps_json(raw: str) -> list[str] | None:
    """Pull the {"steps": [...]} list of strings out of a model response.

    Tolerant of an accidental code fence (same as the backplan parser).
    Returns None on any error so the route falls back to the manual panel.
    """
    text = raw.strip()
    if text.startswith("```"):
        nl = text.find("\n")
        if nl != -1:
            text = text[nl + 1 :]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    items = parsed.get("steps")
    if not isinstance(items, list):
        return None
    steps = [s.strip() for s in items if isinstance(s, str) and s.strip()]
    return steps or None


def suggest_task_steps(task_text: str, context: dict) -> list[str] | None:
    """Ask Claude to break one intimidating task into concrete steps.

    Returns an ordered list of step strings (first = a sub-2-min starter),
    or None on any failure mode (no key, SDK error, unparseable response).
    The caller gates on the user's `ai_opt_in` flag and falls back to the
    manual break-down panel.
    """
    if not is_configured():
        return None
    payload = {"task": task_text, "context": context}
    try:
        result = _summarise(_SYSTEM_TASK_STEPS, payload, max_tokens=400)
    except Exception:  # noqa: BLE001 — any SDK/network failure → manual panel
        return None
    return _parse_task_steps_json(result.content)
