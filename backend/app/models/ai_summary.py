"""AI-generated summary cache.

Each row is one summary the AI produced for a user, of a specific kind
(weekly recap, paper notes, etc.) over a specific period. We store the
output so:
  - The weekly scheduler (Phase 3) can dedupe — one row per (user, kind,
    period_key) keeps us from regenerating the same summary on every
    pageload.
  - Users can browse history without re-billing OpenAI.
  - Cost tracking: tokens_in / tokens_out let us report per-user usage.
"""

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


# The set of summary kinds we support. Keep in sync with frontend
# `SummaryKind` + the prompt-table in `app/core/ai.py`.
SUMMARY_KINDS = ("weekly", "monthly", "stage", "feynman_review", "reflections")


class AiSummary(Base):
    __tablename__ = "ai_summaries"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    # One of SUMMARY_KINDS — kept as string for forward compatibility.
    kind: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    # Free-form period identifier. For weekly: ISO week like "2026-W22".
    # For feynman_review / reflections: a date range like
    # "2026-05-22..2026-05-29" or a single id like "feynman:42".
    period_key: Mapped[str] = mapped_column(String(64), nullable=False)
    # Markdown content. Plain string, NOT JSON.
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # Which OpenAI model produced this (e.g. "gpt-4o-mini-2024-07-18") so a
    # later schema/prompt upgrade can selectively re-render.
    model: Mapped[str] = mapped_column(String(64), nullable=False)

    tokens_in: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    generated_at: Mapped[datetime] = mapped_column(
        DateTime(), default=utc_now, nullable=False,
    )

    # One row per (user, kind, period). Re-running for the same period
    # OVERWRITES (route uses UPSERT semantics) so we don't bill twice.
    __table_args__ = (
        UniqueConstraint(
            "user_id", "kind", "period_key", name="uq_ai_summary_user_kind_period",
        ),
    )
