"""Shared focus-label resolution for timer reporting and AI recaps."""

from typing import Protocol

from sqlalchemy.orm import Session

from app.models.daily_tracker import DailyTask


class FocusSession(Protocol):
    work_label: str
    linked_task_id: int | None


def effective_focus_label(
    session: FocusSession,
    db: Session,
    *,
    unlabeled_label: str,
    max_length: int | None = None,
) -> str:
    label = (session.work_label or "").strip()
    if not label and session.linked_task_id is not None:
        task = db.get(DailyTask, session.linked_task_id)
        if task is not None:
            label = (task.text or "").strip()

    label = label or unlabeled_label
    return label[:max_length] if max_length is not None else label
