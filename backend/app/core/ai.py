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

from app.core.streak import compute_streak
from app.core.xp import EVENT_POMODORO, EVENT_STOPWATCH
from app.models.daily_tracker import DailyLog, DailyTask
from app.models.feynman_entry import FeynmanEntry
from app.models.mood_entry import MoodEntry
from app.models.paper_note import PaperNote
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


def gather_weekly(user_id: int, week_start_utc: datetime, db: Session) -> dict:
    """Pull a week's worth of activity for the weekly-recap prompt.

    `week_start_utc` is the inclusive lower bound (typically a Monday 00:00
    in the user's local TZ, converted to UTC by the route).
    """
    week_end_utc = week_start_utc + timedelta(days=7)

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

    return {
        "week_start": week_start_utc.date().isoformat(),
        "week_end": (week_end_utc - timedelta(days=1)).date().isoformat(),
        "total_work_minutes": sum(minutes_by_day.values()),
        "work_minutes_per_day": dict(minutes_by_day),
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


_SYSTEM_WEEKLY = """\
You are a thoughtful study coach for a PhD student. The user shares one
week of activity data and you produce a short, warm, honest recap they
can both share with their advisor and reflect on themselves.

Tone: peer-to-peer, never corporate. Acknowledge real effort, flag
patterns gently, and avoid empty validation. If a metric is low, say so —
PhD students see through cheerleading.

Output format: Markdown. ~250 words total. Use these sections:
- **This week in numbers** (1-2 lines: hours, sessions, streak)
- **What stood out** (2-3 bullets — patterns, not raw stats)
- **Worth noticing** (1-2 honest observations, including any dips)
- **One thing to try next week** (a single concrete suggestion grounded
  in the data, not generic advice)

Never invent data. If the input shows zero work or zero reflections,
say that plainly and ask one curious question instead of padding.\
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


def summarise_weekly(user_id: int, week_start_utc: datetime, db: Session) -> SummaryResult:
    data = gather_weekly(user_id, week_start_utc, db)
    return _summarise(_SYSTEM_WEEKLY, data, max_tokens=1500)


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
