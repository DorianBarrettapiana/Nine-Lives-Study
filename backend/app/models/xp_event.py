"""XpEvent ORM model — append-only ledger of XP-granting events.

Each row represents one award. A UNIQUE constraint on
(user_id, event_type, entity_type, entity_id) makes the table the source
of truth for idempotency: attempting to insert a second event for the
same (type, entity) is a no-op.

Stats queries that previously counted live rows (DailyTask is_done,
PomodoroSession is_completed) now count distinct events here, so
deleting a task does not retroactively rewrite history.
"""

from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class XpEvent(Base):
    __tablename__ = "xp_events"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "event_type", "entity_type", "entity_id",
            name="uq_xp_event_user_type_entity",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Examples:
    #   event_type    entity_type      entity_id  amount
    #   "task_done"   "daily_task"     42         10
    #   "pomodoro"    "pomodoro"       7          25
    #   "daily_log"   "daily_log"      11         5
    #   "feynman"     "feynman_entry"  3          15
    #   "note"        "paper_note"     12         10
    #   "mood"        "mood_entry"     8          3
    event_type:  Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False)
    entity_id:   Mapped[int] = mapped_column(Integer, nullable=False)
    amount:      Mapped[int] = mapped_column(Integer, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
        index=True,
    )
