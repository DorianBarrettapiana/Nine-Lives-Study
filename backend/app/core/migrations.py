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
