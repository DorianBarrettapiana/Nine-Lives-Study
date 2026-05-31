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

from sqlalchemy import select
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
from app.models.mood_entry import MoodEntry
from app.models.paper_note import PaperNote
from app.models.pomodoro_session import PomodoroSession
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


SummaryKind = Literal["weekly", "paper_notes", "feynman_review", "reflections"]

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

    # Daily tasks completed in the window (carry-over completion counts).
    tasks = db.scalars(
        select(DailyTask)
        .where(DailyTask.user_id == user_id)
        .where(DailyTask.task_date >= week_start_utc.date())
        .where(DailyTask.task_date < week_end_utc.date())
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
        select(FeynmanEntry.id)
        .where(FeynmanEntry.user_id == user_id)
        .where(FeynmanEntry.created_at >= week_start_utc.replace(tzinfo=None))
        .where(FeynmanEntry.created_at < week_end_utc.replace(tzinfo=None))
    )
    paper_notes_count = db.scalar(
        select(PaperNote.id)
        .where(PaperNote.user_id == user_id)
        .where(PaperNote.created_at >= week_start_utc.replace(tzinfo=None))
        .where(PaperNote.created_at < week_end_utc.replace(tzinfo=None))
    )

    streak_days, _active_today = compute_streak(user_id, tz_offset_minutes=0, db=db)

    # Work minutes grouped by the session's focus snapshot. Legacy sessions
    # without a snapshot fall back to their linked daily task, then to an
    # explicit unlabeled bucket. This also includes temporary descriptions.
    time_per_task: Counter[str] = Counter()
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

    return {
        "week_start": week_start_utc.date().isoformat(),
        "week_end": (week_end_utc - timedelta(days=1)).date().isoformat(),
        "total_work_minutes": sum(minutes_by_day.values()),
        "work_minutes_per_day": dict(minutes_by_day),
        # Sorted descending so the highest-investment task is first in the
        # serialized JSON — keeps the prompt's natural narrative order.
        "time_per_task_minutes": dict(time_per_task.most_common()),
        "tasks_done": tasks_done,
        "tasks_total": tasks_total,
        "moods": dict(mood_counter),
        "reflections": reflections,
        "feynman_entries_created": 1 if feynman_count else 0,  # presence-only
        "paper_notes_created": 1 if paper_notes_count else 0,
        "streak_days": streak_days,
    }


def gather_paper_notes(user_id: int, since_utc: datetime, db: Session) -> dict:
    notes = db.scalars(
        select(PaperNote)
        .where(PaperNote.user_id == user_id)
        .where(PaperNote.created_at >= since_utc.replace(tzinfo=None))
        .order_by(PaperNote.created_at.desc())
    ).all()
    return {
        "since": since_utc.date().isoformat(),
        "count": len(notes),
        "notes": [
            {
                "title": n.title,
                "authors": n.authors,
                "year": n.year,
                "tags": n.tags,
                "key_points": (n.key_points or "")[:2000],  # bound per-note size
                "questions": (n.questions or "")[:1000],
            }
            for n in notes
        ],
    }


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

KEY DATA: `time_per_task_minutes` is a map of `{task_text: minutes}`
showing how work time split across the user's own daily-task labels.
Use this as the spine of every observation — it's the difference between
"you worked 12 hours" (useless) and "5h on chapter 2 vs 4h on lit
review" (actionable). If "(unlabeled)" is a large share, gently note it
so the user can start tagging more sessions. Never invent task labels —
quote them verbatim from `time_per_task_minutes` keys.

ALWAYS finish the recap with one line in exactly this format (verbatim,
including the asterisks, on its own line):

**Next step:** <one short, concrete action, max 80 chars>

This line is parsed by the frontend to offer a one-click "add to today's
tasks" button — so make it imperative and specific (e.g. "Re-read paper
A's section 3 and note 2 questions") rather than vague ("focus more").\
"""

# Tuesday slot: retrospective. Looks at the previous ISO week (Mon-Sun,
# already complete). Past tense; closure framing.
_SYSTEM_WEEKLY_RETROSPECTIVE = _SHARED_RECAP_TONE + """

This is a RETROSPECTIVE on the **previous full week** (Mon-Sun, now
closed). Use past tense throughout. The recap should help the user close
the loop on what just finished.

Output format: Markdown. ~250 words total. Sections:
- **Last week in numbers** (1-2 lines: hours, sessions, streak)
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

_SYSTEM_PAPER_NOTES = """\
You are a research-reading coach. The user shares the paper notes they've
written over a period. Find the throughlines.

Output format: Markdown. ~300 words.
- **Themes** (2-4 clusters with the paper titles under each)
- **Open questions** (the recurring unknowns across notes)
- **One paper to revisit** (the single one most worth re-reading, and why)

Cite paper titles verbatim from the input. Don't invent connections that
aren't supported by the notes' actual text.\
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
    user_id: int, last_week_start_utc: datetime, db: Session,
) -> SummaryResult:
    """Tuesday slot — recap of the previous full ISO week (Mon-Sun, closed)."""
    data = gather_weekly(
        user_id,
        last_week_start_utc,
        db,
        window_end_utc=last_week_start_utc + timedelta(days=7),
    )
    data["window_label"] = "previous full week (Mon-Sun)"
    return _summarise(_SYSTEM_WEEKLY_RETROSPECTIVE, data, max_tokens=1500)


def summarise_weekly_pulse(
    user_id: int, this_week_start_utc: datetime, db: Session,
) -> SummaryResult:
    """Friday slot — pulse on current ISO week so far (Mon-now)."""
    now_utc = datetime.now(timezone.utc)
    data = gather_weekly(
        user_id,
        this_week_start_utc,
        db,
        window_end_utc=now_utc,
    )
    data["window_label"] = "current week so far (Mon-now)"
    # Shorter max_tokens than retrospective — prompt asks for ~200 words
    # vs ~250; cap reflects that.
    return _summarise(_SYSTEM_WEEKLY_PULSE, data, max_tokens=1200)


def summarise_paper_notes(user_id: int, since_utc: datetime, db: Session) -> SummaryResult:
    data = gather_paper_notes(user_id, since_utc, db)
    return _summarise(_SYSTEM_PAPER_NOTES, data, max_tokens=2000)


def summarise_feynman_review(user_id: int, entry_id: int, db: Session) -> SummaryResult | None:
    data = gather_feynman_review(user_id, entry_id, db)
    if data is None:
        return None
    return _summarise(_SYSTEM_FEYNMAN, data, max_tokens=1200)


def summarise_reflections(user_id: int, since_utc: datetime, db: Session) -> SummaryResult:
    data = gather_reflections(user_id, since_utc, db)
    return _summarise(_SYSTEM_REFLECTIONS, data, max_tokens=1500)
