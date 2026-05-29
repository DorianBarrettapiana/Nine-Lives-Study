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

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
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

# Daily cap per (user, kind). Each call to Claude bills regardless of whether
# the row UPSERT-overwrites — so this cap is the only thing standing between a
# trigger-happy user and a runaway bill. 1/day matches normal use (Sunday
# ritual + the occasional ad-hoc reflection); raising it back to 3 was
# previously a misjudgment that turned a $5 budget into a 2-3 week ceiling.
_MANUAL_DAILY_CAP = 1


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


def _iso_week_key(week_start_utc: datetime) -> str:
    """`2026-W22`-style key. Stable across timezones since we anchor on
    the UTC representation of the user's local Monday."""
    iso_year, iso_week, _ = week_start_utc.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


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


def _check_preconditions(current_user: User, kind: str, db: Session) -> None:
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
    # Daily-cap: count distinct (period_key) generated today for this kind.
    # We count rows generated in the last 24h instead of by calendar day so
    # a user clicking at 23:59 doesn't get a fresh quota one minute later.
    since = _utc_now() - timedelta(hours=24)
    n_recent = db.scalar(
        select(func.count(AiSummary.id))
        .where(AiSummary.user_id == current_user.id)
        .where(AiSummary.kind == kind)
        .where(AiSummary.generated_at >= since.replace(tzinfo=None))
    ) or 0
    if n_recent >= _MANUAL_DAILY_CAP:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Daily generate limit reached ({_MANUAL_DAILY_CAP}/day).",
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


@router.post("/weekly/generate", response_model=AiSummaryRead, status_code=201)
def generate_weekly(
    tz_offset: int = Query(default=0, ge=-720, le=840),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AiSummary:
    """Generate (or regenerate) THIS week's recap for the current user.

    The week is anchored on the caller's local Monday, so a user in CEST
    asking on a Sunday evening gets last week's Monday-Sunday window
    instead of a half-empty "this week so far" view from UTC's
    perspective. `tz_offset` is minutes east of UTC (JS getTimezoneOffset
    convention with sign flipped)."""
    _check_preconditions(current_user, "weekly", db)
    week_start = _local_monday_utc(tz_offset)
    period_key = _iso_week_key(week_start)
    try:
        result = ai.summarise_weekly(current_user.id, week_start, db)
    except Exception as exc:  # noqa: BLE001 — surface SDK errors as 502
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI generation failed: {exc}",
        ) from exc
    return _upsert(current_user.id, "weekly", period_key, result, db)
