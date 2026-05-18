"""Tiny ad-hoc schema migrations.

We don't use Alembic (overkill for this app). Instead, on startup we
add any missing columns to existing tables. Each migration is idempotent:
it checks current schema first and only ALTERs if needed.
"""

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

# Map of (table, column) -> SQL fragment used to add it.
# Each fragment must include a DEFAULT so existing rows get a valid value
# without violating NOT NULL.
_ADD_COLUMNS: list[tuple[str, str, str]] = [
    ("users", "pomodoro_work_minutes",              "INTEGER NOT NULL DEFAULT 25"),
    ("users", "pomodoro_short_break_minutes",       "INTEGER NOT NULL DEFAULT 5"),
    ("users", "pomodoro_long_break_minutes",        "INTEGER NOT NULL DEFAULT 15"),
    ("users", "pomodoro_sessions_before_long_break","INTEGER NOT NULL DEFAULT 4"),
]

# Backfill completed pomodoro work sessions into xp_events so that stats
# (which now query xp_events, not live rows) reflect historical data.
# ON CONFLICT DO NOTHING makes this idempotent: safe to run every startup.
_BACKFILL_POMODORO = text("""
    INSERT INTO xp_events (user_id, event_type, entity_type, entity_id, amount, created_at)
    SELECT
        user_id,
        'pomodoro_done',
        'pomodoro_session',
        id,
        25,
        COALESCE(ended_at, started_at)
    FROM pomodoro_sessions
    WHERE is_completed = 1 AND session_type = 'work'
    ON CONFLICT (user_id, event_type, entity_type, entity_id) DO NOTHING
""")

# Backfill completed daily tasks into xp_events for the same reason.
_BACKFILL_TASKS = text("""
    INSERT INTO xp_events (user_id, event_type, entity_type, entity_id, amount, created_at)
    SELECT
        user_id,
        'task_done',
        'daily_task',
        id,
        10,
        updated_at
    FROM daily_tasks
    WHERE is_done = 1
    ON CONFLICT (user_id, event_type, entity_type, entity_id) DO NOTHING
""")


def run_migrations(engine: Engine) -> None:
    """Apply any missing column additions. Safe to call on every startup."""
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())

    with engine.begin() as conn:
        for table, column, definition in _ADD_COLUMNS:
            if table not in existing_tables:
                # Table doesn't exist yet → create_all will handle it.
                continue
            existing_cols = {c["name"] for c in inspector.get_columns(table)}
            if column in existing_cols:
                continue
            conn.execute(text(f'ALTER TABLE {table} ADD COLUMN {column} {definition}'))

        # Backfill historical data into xp_events if both tables exist.
        # Skipped on fresh installs where xp_events starts empty anyway.
        if "xp_events" in existing_tables:
            if "pomodoro_sessions" in existing_tables:
                conn.execute(_BACKFILL_POMODORO)
            if "daily_tasks" in existing_tables:
                conn.execute(_BACKFILL_TASKS)
