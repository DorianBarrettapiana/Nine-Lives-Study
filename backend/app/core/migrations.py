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
    ("users", "notif_read_at",                     "TEXT"),
    ("users", "cat_skin",                          "VARCHAR(20) NOT NULL DEFAULT 'tabby'"),
    ("users", "cat_skin_changed_at",               "TIMESTAMP"),
    ("users", "cat_skin_free_changes",             "INTEGER NOT NULL DEFAULT 1"),
    ("users", "daily_goal_minutes",                "INTEGER NOT NULL DEFAULT 120"),
    ("daily_tasks", "sort_order",                  "REAL NOT NULL DEFAULT 0"),
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

        # Pomodoro orphan cleanup + uniqueness guard. Same family of bug as
        # the stopwatch one: previously nothing prevented two concurrent
        # POST /pomodoro requests from both creating an in-progress work
        # session. Each completion awarded XP independently. For each user,
        # mark every duplicate in-progress work session EXCEPT the newest as
        # completed-but-XP-less (ended_at=started_at, is_completed=true).
        # We skip award_xp_event because these are ghost sessions the user
        # never knowingly ran. Step 2 installs the partial unique index so
        # the race can't recur.
        if "pomodoro_sessions" in existing_tables:
            conn.execute(text("""
                UPDATE pomodoro_sessions
                SET is_completed = 1,
                    ended_at = started_at
                WHERE is_completed = 0
                  AND session_type = 'work'
                  AND id NOT IN (
                    SELECT id FROM (
                        SELECT id,
                               ROW_NUMBER() OVER (
                                   PARTITION BY user_id
                                   ORDER BY started_at DESC, id DESC
                               ) AS rn
                        FROM pomodoro_sessions
                        WHERE is_completed = 0 AND session_type = 'work'
                    ) ranked
                    WHERE rn = 1
                  )
            """))
            conn.execute(text("""
                CREATE UNIQUE INDEX IF NOT EXISTS uq_pomodoro_one_active_work_per_user
                ON pomodoro_sessions (user_id)
                WHERE is_completed = 0 AND session_type = 'work'
            """))

        # Stopwatch orphan cleanup + uniqueness guard.
        # Background: POST /stopwatch/start had a TOCTOU race that could
        # leave a user with >1 sessions where ended_at IS NULL. Each ghost
        # kept "running" server-side and inflated today's work-minutes when
        # eventually ended. Step 1: for each user, close every duplicate
        # active session EXCEPT the newest. Closed silently — no XP awarded
        # for ghost time the user never saw on screen. Step 2: install a
        # partial unique index so the race can't recur.
        if "stopwatch_sessions" in existing_tables:
            conn.execute(text("""
                UPDATE stopwatch_sessions
                SET ended_at = COALESCE(last_started_at, started_at),
                    last_started_at = NULL
                WHERE ended_at IS NULL
                  AND id NOT IN (
                    SELECT id FROM (
                        SELECT id,
                               ROW_NUMBER() OVER (
                                   PARTITION BY user_id
                                   ORDER BY started_at DESC, id DESC
                               ) AS rn
                        FROM stopwatch_sessions
                        WHERE ended_at IS NULL
                    ) ranked
                    WHERE rn = 1
                  )
            """))
            conn.execute(text("""
                CREATE UNIQUE INDEX IF NOT EXISTS uq_stopwatch_one_active_per_user
                ON stopwatch_sessions (user_id)
                WHERE ended_at IS NULL
            """))
