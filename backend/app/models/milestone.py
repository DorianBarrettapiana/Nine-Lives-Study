"""Milestone ORM model.

A Milestone is a date-anchored target: a conference abstract deadline,
a thesis chapter due date, a defense rehearsal. Differs from a daily
task in two ways:

  1. It lives at the week/month timescale, not the day.
  2. It's the *thing the user is working toward*, not a unit of work
     they cross off — milestones are typically not "done" until the
     date arrives.

Optionally scoped to a Project, but can also be free-floating
(defense, school break, personal). Per-user.

We do NOT cascade-delete dependent tasks when a milestone goes; this
PR doesn't yet introduce a task → milestone link. When/if added, we'll
mirror Project's "set FK to NULL on delete" policy so the user's tasks
survive a wound-down milestone.
"""

from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def utc_now() -> datetime:
    """Return the current UTC datetime."""
    return datetime.now(timezone.utc)


class Milestone(Base):
    """A date-anchored target the user is working toward."""

    __tablename__ = "milestones"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    # The "when". Stored as a calendar date — no time-of-day; for a
    # 11:59pm AOE deadline pick the next day, that's accurate enough at
    # this granularity and avoids the "what timezone is this in" trap.
    due_date: Mapped[date] = mapped_column(Date, index=True, nullable=False)

    # Optional research-thread bucket. NULL = "cross-project" (defense,
    # generic life events, etc.). Same ON DELETE SET NULL policy as
    # daily_tasks.project_id — enforced application-side in the
    # /projects DELETE route.
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # Free-text notes / context for the milestone. Optional.
    notes: Mapped[str] = mapped_column(Text, default="", server_default="", nullable=False)

    # Self-referential parent for backplanned check-points. NULL = this
    # is a top-level milestone (the conference, the defense). A non-NULL
    # value points at a sibling row owned by the same user — the
    # /milestones DELETE route cascades manually since SQLite FK
    # enforcement is off in this app, matching the project_id pattern.
    parent_milestone_id: Mapped[int | None] = mapped_column(
        ForeignKey("milestones.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )

    # Archived milestones drop out of the sidebar countdown but stay in
    # the DB and can be unarchived. Same pattern as Project.
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(),
        default=utc_now,
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(),
        default=utc_now,
        onupdate=utc_now,
        nullable=False,
    )
