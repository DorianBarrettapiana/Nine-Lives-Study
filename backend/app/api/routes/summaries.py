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

from datetime import date, datetime, timedelta, timezone
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

# Weekly recap: Friday only. We dropped Tuesday after collecting user
# feedback that one ritual day per week is enough — twice was hitting
# fatigue and inflating the Claude bill. Friday now produces a
# retrospective on the just-closed week (Mon-Sun) rather than the prior
# "pulse on the current week so far" semantics, which matches the
# "Generate last week recap" button label users expect.
#
# Each user can still only generate once per ISO week per kind, because
# the unique (user_id, kind, period_key) constraint is the structural
# cost cap. Pre-existing `-T` rows from before this change stay in the
# DB so the user's history doesn't regress.
_WEEKLY_SLOTS: dict[int, str] = {
    4: "F",  # Friday → "...-F"
}
_SLOT_LABEL = {"F": "Friday"}

# Monthly recap is restricted to the LAST 3 DAYS of the month so users
# write a retrospective at month-end, not mid-month. We use "last 3
# calendar days" instead of literally "29-31" so February still has 3
# eligible days regardless of leap year. The DB unique constraint on
# (kind, period_key) where period_key = "YYYY-MM" already caps to one
# per month — this restriction adds an end-of-month *window*.
_MONTHLY_WINDOW_DAYS = 3

# Stage (rolling) recap is once per 90 days per user. Unlike weekly /
# monthly, its period_key changes every call (it embeds today's date),
# so the unique constraint can't enforce the cooldown. We do it
# application-side by looking for any recent "stage" row.
_STAGE_COOLDOWN_DAYS = 90


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


@router.get("/monthly/availability", response_model=dict)
def monthly_availability(
    tz_offset: int = Query(default=0, ge=-720, le=840),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Whether the Monthly Generate button should be enabled right now."""
    if not _is_in_monthly_window(tz_offset):
        return {
            "can_generate": False,
            "reason": "off_window",
            "next_available": _monthly_next_open_iso(tz_offset),
            "window_days": _MONTHLY_WINDOW_DAYS,
        }
    start = _local_month_start_utc(tz_offset)
    period_key = start.strftime("%Y-%m")
    existing = db.scalar(
        select(AiSummary.id)
        .where(AiSummary.user_id == current_user.id)
        .where(AiSummary.kind == "monthly")
        .where(AiSummary.period_key == period_key)
    )
    if existing is not None:
        return {
            "can_generate": False,
            "reason": "already_generated",
            "period_key": period_key,
        }
    return {"can_generate": True, "period_key": period_key}


@router.get("/stage/availability", response_model=dict)
def stage_availability(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Whether the Stage Generate button should be enabled right now."""
    cooldown_until = _stage_cooldown_until(current_user.id, db)
    if cooldown_until is not None:
        return {
            "can_generate": False,
            "reason": "cooldown",
            "next_available": cooldown_until.date().isoformat(),
            "cooldown_days": _STAGE_COOLDOWN_DAYS,
        }
    return {"can_generate": True, "cooldown_days": _STAGE_COOLDOWN_DAYS}


def _period_key_for_slot(slot: str, tz_offset_minutes: int) -> str:
    """Period key the given slot would write right now.

    The (only) Friday slot summarises the past 7 days (Sat-Fri): the
    most recent weekend through today. We anchor the key on the current
    week's Monday so "Recap for 2026-W22" lines up with the week the
    user is actually in, not the calendar-previous one.

    The legacy `"T"` slot is retained for back-compat with any code
    that still passes that letter; it shares the same current-week
    anchor (so a Tue UI hitting an unmigrated frontend would still
    produce a sensible period_key, though the Tuesday slot is now
    rejected at the route layer).
    """
    this_monday = _local_monday_utc(tz_offset_minutes)
    anchor = this_monday  # current week (the Sat-Fri recap ends this Fri)
    return f"{_iso_week_key(anchor)}-{slot}"


def _next_slot_letter(today_weekday: int) -> str:
    """Letter of the next upcoming slot from today's weekday (Mon=0)."""
    # Walk forward 1..7 days; first day that matches a slot wins.
    for offset in range(1, 8):
        candidate = (today_weekday + offset) % 7
        if candidate in _WEEKLY_SLOTS:
            return _WEEKLY_SLOTS[candidate]
    return "F"  # unreachable — Friday is in the dict


def _days_in_month(year: int, month: int) -> int:
    """Number of calendar days in (year, month). Used by the monthly
    end-of-month window — handles Feb / leap years without us hard-
    coding the month → days table."""
    if month == 12:
        return 31
    next_month_start = date(year, month + 1, 1)
    return (next_month_start - date(year, month, 1)).days


def _is_in_monthly_window(tz_offset_minutes: int) -> bool:
    """True iff today (in caller's local TZ) is one of the last
    `_MONTHLY_WINDOW_DAYS` days of its calendar month.

    We use "last N days of the month" instead of literally "29/30/31"
    so February has a usable window (26-28 non-leap, 27-29 leap).
    """
    local_now = (_utc_now() + timedelta(minutes=tz_offset_minutes)).date()
    last_day = _days_in_month(local_now.year, local_now.month)
    return local_now.day > last_day - _MONTHLY_WINDOW_DAYS


def _monthly_next_open_iso(tz_offset_minutes: int) -> str:
    """ISO date of the next day the monthly window opens (for UI hint)."""
    local_now = (_utc_now() + timedelta(minutes=tz_offset_minutes)).date()
    last_day = _days_in_month(local_now.year, local_now.month)
    threshold = last_day - _MONTHLY_WINDOW_DAYS  # first eligible = threshold+1
    if local_now.day <= threshold:
        return date(local_now.year, local_now.month, threshold + 1).isoformat()
    # We're already in the window; "next" really means "next month's window".
    if local_now.month == 12:
        next_y, next_m = local_now.year + 1, 1
    else:
        next_y, next_m = local_now.year, local_now.month + 1
    next_last = _days_in_month(next_y, next_m)
    return date(next_y, next_m, next_last - _MONTHLY_WINDOW_DAYS + 1).isoformat()


def _stage_cooldown_until(user_id: int, db: Session) -> datetime | None:
    """If the user generated a stage recap in the last 90 days, return
    when the cooldown ends (UTC datetime). Otherwise None.

    Looks at `generated_at` on the most recent `stage` row — period_key
    can't carry the cooldown because it embeds the rolling window's
    start/end dates and so changes every call.
    """
    latest = db.scalar(
        select(AiSummary.generated_at)
        .where(AiSummary.user_id == user_id)
        .where(AiSummary.kind == "stage")
        .order_by(AiSummary.generated_at.desc())
        .limit(1)
    )
    if latest is None:
        return None
    latest_utc = latest if latest.tzinfo else latest.replace(tzinfo=timezone.utc)
    cooldown_end = latest_utc + timedelta(days=_STAGE_COOLDOWN_DAYS)
    if cooldown_end <= _utc_now():
        return None
    return cooldown_end


@router.post("/weekly/generate", response_model=AiSummaryRead, status_code=201)
def generate_weekly(
    tz_offset: int = Query(default=0, ge=-720, le=840),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AiSummary:
    """Generate the previous week's retrospective — Friday only.

    Caps weekly Claude spend at one call per user per ISO week through
    the unique (user_id, kind, period_key) DB index. `tz_offset` is
    minutes east of UTC (JS getTimezoneOffset convention with sign
    flipped) — "today is Friday" is the user's local calendar, not the
    server's UTC clock."""
    _check_base_preconditions(current_user)
    weekday = _local_weekday(tz_offset)
    slot = _WEEKLY_SLOTS.get(weekday)
    if slot is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Weekly recap can only be generated on Fridays.",
        )
    period_key = _period_key_for_slot(slot, tz_offset)
    _check_period_not_yet_generated(current_user.id, "weekly", period_key, db)
    this_monday = _local_monday_utc(tz_offset)
    try:
        # Friday: retrospective on the past 7 days (Sat-Fri) — last
        # weekend through today — rather than the prior Mon-Sun week.
        # Saturday is two days before this week's Monday; the retrospective
        # gathers a 7-day window from there, i.e. Sat-Sun-Mon-...-Fri.
        result = ai.summarise_weekly_retrospective(
            current_user.id, this_monday - timedelta(days=2), db,
        )
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
    """Generate an advisor-ready monthly or rolling stage recap.

    Monthly: only callable in the last 3 days of a calendar month (so
    the user writes month-end retrospectives). The DB UNIQUE on
    (kind, period_key=YYYY-MM) still caps to one per month.

    Stage: callable at most once per 90 days per user; the cooldown is
    enforced by looking at the latest stored stage row's `generated_at`.
    """
    _check_base_preconditions(current_user)
    end = _utc_now()
    if period == "monthly":
        if not _is_in_monthly_window(tz_offset):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Monthly recap can only be generated in the last "
                    f"{_MONTHLY_WINDOW_DAYS} days of the month. "
                    f"Next available: {_monthly_next_open_iso(tz_offset)}."
                ),
            )
        start = _local_month_start_utc(tz_offset)
        period_key = start.strftime("%Y-%m")
        label = f"current calendar month ({period_key})"
    else:
        cooldown_until = _stage_cooldown_until(current_user.id, db)
        if cooldown_until is not None:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    f"Stage recap can only be generated once every "
                    f"{_STAGE_COOLDOWN_DAYS} days. "
                    f"Next available: {cooldown_until.date().isoformat()}."
                ),
            )
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
