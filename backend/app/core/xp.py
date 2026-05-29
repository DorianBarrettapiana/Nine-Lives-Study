"""XP award logic.

Public API: ``award_xp_event(user_id, event_type, entity_type, entity_id, amount, db)``
is the only function routes should use. It guarantees idempotency: calling
it twice for the same (user, event_type, entity_type, entity_id) is a no-op,
so toggling a task done/undone/done, re-saving a daily log, or re-PATCHing
``/pomodoro/{id}/complete`` cannot farm XP.
"""

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.user_progress import UserProgress, level_from_xp
from app.models.xp_event import XpEvent

# --- XP amounts (single source of truth) ------------------------------------
#
# Current rule (May 2026):
#   1 minute of work time (pomodoro OR stopwatch) = 1 XP
#   1 paper note  = 10 XP
#   1 Feynman     = 10 XP
#   Everything else (tasks / mood / daily log / cheers received) = 0 XP
#
# Pomodoro XP is awarded as `duration_minutes`, not a flat number.
# Stopwatch XP is awarded as `total minutes worked`.

XP_TASK_COMPLETE = 0     # was 10 — now "其他行为不计入"
XP_DAILY_LOG_SAVE = 0    # was 5
XP_FEYNMAN_CREATE = 10   # was 15
XP_NOTE_CREATE = 10
XP_MOOD_LOG = 0          # was 3
XP_CHEER_RECEIVED = 0    # was 1

# Legacy constant — kept so existing imports don't break. Pomodoro routes
# now award `session.duration_minutes` directly.
XP_POMODORO_COMPLETE = 25

# --- Event type / entity type constants -------------------------------------

EVENT_TASK_DONE   = "task_done"
EVENT_POMODORO    = "pomodoro_done"
EVENT_STOPWATCH   = "stopwatch_done"
EVENT_DAILY_LOG   = "daily_log_saved"
EVENT_FEYNMAN     = "feynman_created"
EVENT_NOTE        = "note_created"
EVENT_MOOD        = "mood_logged"
EVENT_CHEER       = "cheer_received"

ENTITY_DAILY_TASK   = "daily_task"
ENTITY_POMODORO     = "pomodoro_session"
ENTITY_STOPWATCH    = "stopwatch_session"
ENTITY_DAILY_LOG    = "daily_log"
ENTITY_FEYNMAN      = "feynman_entry"
ENTITY_NOTE         = "paper_note"
ENTITY_MOOD         = "mood_entry"
ENTITY_FRIEND_CHEER = "friend_cheer"


def _get_or_create_progress(user_id: int, db: Session) -> UserProgress:
    progress = db.get(UserProgress, user_id)
    if progress is None:
        progress = UserProgress(user_id=user_id, xp=0, level=1)
        db.add(progress)
        db.flush()
    return progress


def award_xp_event(
    user_id: int,
    event_type: str,
    entity_type: str,
    entity_id: int,
    amount: int,
    db: Session,
) -> bool:
    """Record an XP-granting event and credit the user, idempotently.

    Returns True if the event was newly recorded (and XP credited), False if
    it was a duplicate (same user_id/event_type/entity_type/entity_id) and
    therefore ignored.
    """
    # Fast-path: check before inserting to avoid an INSERT/rollback round-trip
    # on the common "already awarded" case.
    existing = db.scalar(
        select(XpEvent.id)
        .where(XpEvent.user_id == user_id)
        .where(XpEvent.event_type == event_type)
        .where(XpEvent.entity_type == entity_type)
        .where(XpEvent.entity_id == entity_id)
    )
    if existing is not None:
        return False

    event = XpEvent(
        user_id=user_id,
        event_type=event_type,
        entity_type=entity_type,
        entity_id=entity_id,
        amount=amount,
    )
    db.add(event)
    progress = _get_or_create_progress(user_id, db)
    progress.xp += amount
    progress.level, _, _ = level_from_xp(progress.xp)

    try:
        db.flush()
    except IntegrityError as exc:
        # Race condition: someone inserted the same event concurrently
        # (UNIQUE on user_id+event_type+entity_type+entity_id). Roll back
        # this attempt; the prior insert already credited XP. We only want
        # to swallow that specific case — NOT NULL / FK / check-constraint
        # failures are real bugs and must surface.
        msg = str(exc.orig).lower() if exc.orig is not None else str(exc).lower()
        is_unique_violation = (
            "unique" in msg
            or "duplicate" in msg
            or getattr(exc.orig, "sqlite_errorname", "") == "SQLITE_CONSTRAINT_UNIQUE"
        )
        db.rollback()
        if not is_unique_violation:
            raise
        return False
    return True


# --- Backwards-compatible wrapper -------------------------------------------
# Kept so any in-flight code paths still build; new code MUST use
# award_xp_event with proper idempotency keys. The wrapper raises rather
# than silently double-awarding, so callers are forced to migrate.

def award_xp(*_args, **_kwargs):  # pragma: no cover
    raise RuntimeError(
        "award_xp() has been removed. Use award_xp_event(user_id, event_type, "
        "entity_type, entity_id, amount, db) for idempotent XP awards."
    )
