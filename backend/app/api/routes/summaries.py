"""AI summary routes.

Phase 1 ships only the weekly recap with manual (on-demand) generation.
Other kinds + the scheduled-auto path land in Phase 2/3.

Privacy: every Generate call requires `users.ai_opt_in = True`. The
frontend shows a one-time consent modal on first use that PATCHes
/summaries/opt-in before retrying.

Rate-limit: ≤3 manual calls per user per kind per day. The DB upsert on
the (user_id, kind, period_key) unique index further guarantees that
repeating Generate for the *same* week overwrites instead of stacking
rows — so cost is bounded by distinct periods, not click count.
"""

from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import ai
from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.ai_summary import SUMMARY_KINDS, AiSummary
from app.models.user import User
from app.schemas.ai_summary import (
    AiConfigRead,
    AiOptInPayload,
    AiSummaryRead,
    SummaryKind,
)

router = APIRouter(prefix="/summaries", tags=["summaries"])

# Weekly recap has TWO slots: Tuesday and Friday. Together they cap weekly
# Claude spend at 2 * cost-per-call regardless of how many times the user
# clicks Generate — the prior "1/day rolling 24h" cap let a determined user
# rack up 21 calls/week. Each slot writes a distinct period_key
# (`2026-W22-T` vs `2026-W22-F`), so they don't UPSERT-overwrite each other,
# and the DB UNIQUE on (user_id, kind, period_key) makes a second click on
# the same slot a no-op-with-429.
_WEEKLY_SLOTS: dict[int, str] = {
    1: "T",  # Tuesday  → "...-T"
    4: "F",  # Friday   → "...-F"
}
_SLOT_LABEL = {"T": "Tuesday", "F": "Friday"}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _local_monday_utc(tz_offset_minutes: int) -> datetime:
    """ISO-week Monday 00:00 in the caller's local TZ, expressed in UTC.

    Mirrors how stats.py computes today's local day so the recap covers
    "this week" by the user's calendar, not the server's.
    """
    tz_delta = timedelta(minutes=tz_offset_minutes)
    local_now = _utc_now() + tz_delta
    local_monday = (local_now - timedelta(days=local_now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return local_monday - tz_delta


def _local_month_start_utc(tz_offset_minutes: int) -> datetime:
    tz_delta = timedelta(minutes=tz_offset_minutes)
    local_now = _utc_now() + tz_delta
    local_start = local_now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return local_start - tz_delta


def _iso_week_key(week_start_utc: datetime) -> str:
    """`2026-W22`-style key. Stable across timezones since we anchor on
    the UTC representation of the user's local Monday."""
    iso_year, iso_week, _ = week_start_utc.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def _local_weekday(tz_offset_minutes: int) -> int:
    """Day of week in the caller's local TZ. Mon=0 ... Sun=6, matching
    Python's `datetime.weekday()` (which client-side JS code does NOT
    match — JS `getDay()` returns Sun=0)."""
    return (_utc_now() + timedelta(minutes=tz_offset_minutes)).weekday()


# --- Config / opt-in --------------------------------------------------------


@router.get("/config", response_model=AiConfigRead)
def get_config(current_user: User = Depends(get_current_user)) -> AiConfigRead:
    """Tell the frontend whether to show the AI section at all.

    `enabled` reflects server-side ANTHROPIC_API_KEY presence; the user's
    `ai_opt_in` reflects whether they've accepted the data-sharing
    disclosure. Both must be true for /generate to succeed."""
    return AiConfigRead(
        enabled=ai.is_configured(),
        user_opted_in=bool(current_user.ai_opt_in),
    )


@router.post("/opt-in", response_model=AiConfigRead)
def opt_in(
    payload: AiOptInPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AiConfigRead:
    """Flip the per-user consent flag. Idempotent: re-POSTing with the
    same value is a no-op, opting out is allowed."""
    current_user.ai_opt_in = payload.opted_in
    db.commit()
    return AiConfigRead(
        enabled=ai.is_configured(),
        user_opted_in=bool(current_user.ai_opt_in),
    )


# --- Read history -----------------------------------------------------------


@router.get("/{kind}", response_model=list[AiSummaryRead])
def list_summaries(
    kind: SummaryKind,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AiSummary]:
    """All prior summaries of this kind for the current user, newest first.
    Used to render the history list and to surface the latest for the
    current period without an extra round-trip."""
    if kind not in SUMMARY_KINDS:
        raise HTTPException(status_code=400, detail="Unknown summary kind.")
    return list(
        db.scalars(
            select(AiSummary)
            .where(AiSummary.user_id == current_user.id)
            .where(AiSummary.kind == kind)
            .order_by(AiSummary.generated_at.desc())
        ).all()
    )


# --- Generate ---------------------------------------------------------------


def _check_base_preconditions(current_user: User) -> None:
    """Server-level + per-user gates that apply to every summary kind."""
    if not ai.is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI summaries are not configured on this server.",
        )
    if not current_user.ai_opt_in:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Opt-in required before generating AI summaries.",
        )


def _check_period_not_yet_generated(
    user_id: int, kind: str, period_key: str, db: Session,
) -> None:
    """Refuse if a summary already exists for this (kind, period_key).
    Replaces the prior 24h rolling cap — each call bills Claude, so this
    structural per-period check is the only thing keeping cost bounded."""
    existing = db.scalar(
        select(AiSummary.id)
        .where(AiSummary.user_id == user_id)
        .where(AiSummary.kind == kind)
        .where(AiSummary.period_key == period_key)
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Already generated for this period ({period_key}).",
        )


def _upsert(
    user_id: int,
    kind: str,
    period_key: str,
    result: ai.SummaryResult,
    db: Session,
) -> AiSummary:
    """Insert-or-update on (user_id, kind, period_key).

    Re-generating for the same period OVERWRITES the previous row so the
    user always has at most one summary per period — and the prior row's
    cost has already been incurred, so charging again was a deliberate
    user action (clicking Generate again)."""
    existing = db.scalar(
        select(AiSummary)
        .where(AiSummary.user_id == user_id)
        .where(AiSummary.kind == kind)
        .where(AiSummary.period_key == period_key)
    )
    if existing is not None:
        existing.content = result.content
        existing.model = result.model
        existing.tokens_in = result.tokens_in
        existing.tokens_out = result.tokens_out
        existing.generated_at = _utc_now().replace(tzinfo=None)
        row = existing
    else:
        row = AiSummary(
            user_id=user_id,
            kind=kind,
            period_key=period_key,
            content=result.content,
            model=result.model,
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
        )
        db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/weekly/availability", response_model=dict)
def weekly_availability(
    tz_offset: int = Query(default=0, ge=-720, le=840),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Tell the frontend (a) whether Generate is allowed RIGHT NOW for the
    user's local day, and (b) the period_key the current slot would write.

    Lets the UI grey out the button on non-Tue/Fri days, and surface
    "already generated" without a 429 round-trip."""
    weekday = _local_weekday(tz_offset)
    slot = _WEEKLY_SLOTS.get(weekday)
    if slot is None:
        return {
            "can_generate": False,
            "reason": "off_day",
            "next_slot": _SLOT_LABEL.get(_next_slot_letter(weekday)),
        }
    period_key = _period_key_for_slot(slot, tz_offset)
    existing = db.scalar(
        select(AiSummary.id)
        .where(AiSummary.user_id == current_user.id)
        .where(AiSummary.kind == "weekly")
        .where(AiSummary.period_key == period_key)
    )
    if existing is not None:
        return {
            "can_generate": False,
            "reason": "already_generated",
            "period_key": period_key,
        }
    return {
        "can_generate": True,
        "slot": _SLOT_LABEL[slot],
        "period_key": period_key,
    }


def _period_key_for_slot(slot: str, tz_offset_minutes: int) -> str:
    """Period key the given slot would write right now.

    Tuesday's period_key reflects the PREVIOUS week (the one being
    retrospected on). Friday's reflects the CURRENT week (the one being
    pulse-checked). This keeps each slot self-consistent — "Recap for
    2026-W21" on Tuesday is genuinely about W21, not "the recap I made
    in W22 about W21".
    """
    this_monday = _local_monday_utc(tz_offset_minutes)
    # Tuesday → previous week's Monday (the retrospected week).
    # Friday  → current week's Monday (the week being pulse-checked).
    anchor = this_monday - timedelta(days=7) if slot == "T" else this_monday
    return f"{_iso_week_key(anchor)}-{slot}"


def _next_slot_letter(today_weekday: int) -> str:
    """Letter of the next upcoming slot from today's weekday (Mon=0)."""
    # Walk forward 1..7 days; first day that matches a slot wins.
    for offset in range(1, 8):
        candidate = (today_weekday + offset) % 7
        if candidate in _WEEKLY_SLOTS:
            return _WEEKLY_SLOTS[candidate]
    return "T"  # unreachable — both slots are in the dict


@router.post("/weekly/generate", response_model=AiSummaryRead, status_code=201)
def generate_weekly(
    tz_offset: int = Query(default=0, ge=-720, le=840),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AiSummary:
    """Generate THIS week's recap — restricted to Tuesday and Friday slots.

    Each slot writes its own period_key (`2026-W22-T` for Tue, `-F` for Fri)
    so the two recaps coexist instead of overwriting each other. Together
    they hard-cap weekly Claude spend at 2 calls per user per week.

    `tz_offset` is minutes east of UTC (JS getTimezoneOffset convention with
    sign flipped) — needed because "today is Tuesday" depends on the user's
    local calendar, not the server's UTC clock."""
    _check_base_preconditions(current_user)
    weekday = _local_weekday(tz_offset)
    slot = _WEEKLY_SLOTS.get(weekday)
    if slot is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Weekly recap can only be generated on Tuesdays and Fridays.",
        )
    period_key = _period_key_for_slot(slot, tz_offset)
    _check_period_not_yet_generated(current_user.id, "weekly", period_key, db)
    this_monday = _local_monday_utc(tz_offset)
    try:
        if slot == "T":
            # Tuesday: retrospective on last week (Mon-Sun, now closed).
            result = ai.summarise_weekly_retrospective(
                current_user.id, this_monday - timedelta(days=7), db,
            )
        else:  # "F"
            # Friday: pulse on current week so far (Mon-now).
            result = ai.summarise_weekly_pulse(current_user.id, this_monday, db)
    except Exception as exc:  # noqa: BLE001 — surface SDK errors as 502
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI generation failed: {exc}",
        ) from exc
    return _upsert(current_user.id, "weekly", period_key, result, db)


@router.post("/progress/{period}/generate", response_model=AiSummaryRead, status_code=201)
def generate_progress_recap(
    period: Literal["monthly", "stage"],
    days: int = Query(default=90, ge=14, le=365),
    tz_offset: int = Query(default=0, ge=-720, le=840),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AiSummary:
    """Generate an advisor-ready monthly or rolling stage recap."""
    _check_base_preconditions(current_user)
    end = _utc_now()
    if period == "monthly":
        start = _local_month_start_utc(tz_offset)
        period_key = start.strftime("%Y-%m")
        label = f"current calendar month ({period_key})"
    else:
        start = end - timedelta(days=days)
        period_key = f"{start.date().isoformat()}..{end.date().isoformat()}"
        label = f"rolling {days}-day research stage"
    _check_period_not_yet_generated(current_user.id, period, period_key, db)
    try:
        result = ai.summarise_progress_recap(current_user.id, start, end, label, db)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI generation failed: {exc}",
        ) from exc
    return _upsert(current_user.id, period, period_key, result, db)


@router.post("/feynman/{entry_id}/generate", response_model=AiSummaryRead, status_code=201)
def generate_feynman_review(
    entry_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AiSummary:
    """Give immediate, rigorous feedback on one Feynman explanation."""
    _check_base_preconditions(current_user)
    try:
        result = ai.summarise_feynman_review(current_user.id, entry_id, db)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI generation failed: {exc}",
        ) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Feynman entry not found.")
    return _upsert(current_user.id, "feynman_review", f"feynman:{entry_id}", result, db)


@router.post("/paper-notes/generate", response_model=AiSummaryRead, status_code=201)
def generate_paper_note_themes(
    days: int = Query(default=30, ge=1, le=365),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AiSummary:
    """Find recurring themes and questions in the user's recent paper notes."""
    _check_base_preconditions(current_user)
    since = _utc_now() - timedelta(days=days - 1)
    period_key = f"{since.date().isoformat()}..{_utc_now().date().isoformat()}"
    try:
        result = ai.summarise_paper_notes(current_user.id, since, db)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI generation failed: {exc}",
        ) from exc
    return _upsert(current_user.id, "paper_notes", period_key, result, db)
