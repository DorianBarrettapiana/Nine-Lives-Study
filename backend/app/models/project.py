"""Project ORM model.

A Project is a user-defined research thread — e.g. "DiffusionPolicy",
"Survey draft", "Defense prep". Daily tasks, paper notes, and Feynman
entries can optionally belong to one project. Work sessions inherit
their project from their linked daily task (no separate column on the
session row — keeps a single source of truth).

Per-user scoped (no sharing yet). Hard-deletion sets dependent FKs to
NULL via ON DELETE SET NULL: the user's tasks/notes don't vanish when
they delete a project; they just become unassigned.
"""

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def utc_now() -> datetime:
    """Return the current UTC datetime."""
    return datetime.now(timezone.utc)


class Project(Base):
    """A user-defined research thread / project bucket."""

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # Optional 7-char hex (e.g. "#4f46e5") for the project chip in the UI.
    # Empty string = picker assigns a stable color by hash of the name.
    color: Mapped[str] = mapped_column(String(7), default="", nullable=False)
    # Archived projects stay in the DB and on existing tasks/notes but are
    # hidden from the active picker. Lets the user wind down a thread
    # without losing history.
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
