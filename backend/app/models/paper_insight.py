"""Structured insight captured after a focused paper-reading session."""

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class PaperInsight(Base):
    """A small reading outcome: idea, question, and concrete follow-up."""

    __tablename__ = "paper_insights"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    paper_note_id: Mapped[int] = mapped_column(
        ForeignKey("paper_notes.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    key_idea: Mapped[str] = mapped_column(Text, default="", nullable=False)
    question: Mapped[str] = mapped_column(Text, default="", nullable=False)
    next_step: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(), default=utc_now, nullable=False)
