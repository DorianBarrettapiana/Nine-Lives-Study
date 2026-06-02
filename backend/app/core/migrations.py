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
    ("users", "share_study_time",                  "BOOLEAN NOT NULL DEFAULT 1"),
    ("users", "share_activity",                    "BOOLEAN NOT NULL DEFAULT 1"),
    ("users", "share_project",                     "BOOLEAN NOT NULL DEFAULT 0"),
    ("daily_logs", "main_goal",                    "VARCHAR(500) NOT NULL DEFAULT ''"),
    ("pomodoro_sessions", "work_label",            "VARCHAR(300) NOT NULL DEFAULT ''"),
    ("stopwatch_sessions", "work_label",           "VARCHAR(300) NOT NULL DEFAULT ''"),
    ("paper_notes", "feynman_entry_id",            "INTEGER"),
    ("users", "ai_opt_in",                         "BOOLEAN NOT NULL DEFAULT 0"),
    ("users", "zotero_user_id",                    "VARCHAR(50)"),
    ("users", "zotero_api_key_enc",                "VARCHAR(500)"),
    # Zotero-synced paper notes: see app/models/paper_note.py for semantics.
    ("paper_notes", "zotero_key",                  "VARCHAR(20)"),
    ("paper_notes", "zotero_version",              "INTEGER"),
    ("paper_notes", "item_type",                   "VARCHAR(40)"),
    ("paper_notes", "url",                         "VARCHAR(500)"),
    ("paper_notes", "doi",                         "VARCHAR(200)"),
    ("paper_notes", "abstract",                    "TEXT"),
    ("paper_notes", "source",                      "VARCHAR(20) NOT NULL DEFAULT 'manual'"),
    ("paper_notes", "reading_status",              "VARCHAR(20) NOT NULL DEFAULT 'inbox'"),
    ("daily_tasks", "sort_order",                  "REAL NOT NULL DEFAULT 0"),
    ("daily_tasks", "paper_note_id",               "INTEGER"),
    # Task-session linking: open-ended work sessions and pomodoros can both
    # be tagged with the daily task being worked on. NULL = no link.
    # ON DELETE SET NULL is set in the model definition; SQLite enforces it
    # when foreign_keys pragma is on (we don't currently turn it on, so the
    # task being deleted just leaves a dangling id — harmless, the gather_*
    # functions LEFT JOIN and treat missing rows as "(unlabeled)").
    ("stopwatch_sessions", "linked_task_id",       "INTEGER"),
    ("pomodoro_sessions", "linked_task_id",        "INTEGER"),
    # Project linkage (research-thread top-level grouping). ON DELETE
    # SET NULL behaviour is documented in app/models/project.py; SQLite
    # enforces it only when foreign_keys pragma is on (we currently
    # don't), so the /projects DELETE route explicitly sets these to
    # NULL before removing the row. Sessions inherit project transitively
    # via linked_task_id → daily_task.project_id; no column on the
    # session tables, to keep one source of truth.
    ("daily_tasks",     "project_id",              "INTEGER"),
    ("paper_notes",     "project_id",              "INTEGER"),
    ("feynman_entries", "project_id",              "INTEGER"),
    # PR1 of the Today/Daily-tracker unification — see app/models/
    # daily_tracker.py for semantics. All nullable; routes dual-write.
    ("daily_tasks",     "planned_date",            "DATE"),
    ("daily_tasks",     "due_date",                "DATE"),
    ("daily_logs",      "main_goal_task_id",       "INTEGER"),
    # Self-FK for backplanned check-points; NULL on existing rows means
    # "top-level milestone", which is what every legacy row already was.
    ("milestones",      "parent_milestone_id",     "INTEGER"),
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


def _backfill_paper_note_tag_csv(conn) -> None:
    """Lift `paper_notes.tags` CSV into (tags, tag_links).

    Reads every (user_id, id, tags) row, splits the CSV, and writes
    INSERT OR IGNORE for both target tables so re-runs are safe. We
    don't clear the CSV column afterwards — the route layer keeps
    writing both during the migration window, and a future cleanup
    PR can drop the column once we trust the new path.
    """
    import re as _re

    rows = conn.execute(text(
        "SELECT id, user_id, tags FROM paper_notes "
        "WHERE tags IS NOT NULL AND tags != ''"
    )).fetchall()
    ws = _re.compile(r"\s+")
    for note_id, user_id, csv in rows:
        seen: set[str] = set()
        for chunk in csv.split(","):
            display = ws.sub(" ", chunk.strip())
            if not display:
                continue
            norm = display.casefold()
            if norm in seen:
                continue
            seen.add(norm)

            conn.execute(
                text(
                    "INSERT OR IGNORE INTO tags "
                    "(user_id, name, normalized_name, color, created_at, updated_at) "
                    "VALUES (:uid, :name, :norm, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ),
                {"uid": user_id, "name": display, "norm": norm},
            )
            tag_id = conn.execute(
                text(
                    "SELECT id FROM tags WHERE user_id = :uid AND normalized_name = :norm"
                ),
                {"uid": user_id, "norm": norm},
            ).scalar()
            if tag_id is None:
                continue
            conn.execute(
                text(
                    "INSERT OR IGNORE INTO tag_links "
                    "(tag_id, item_type, item_id, created_at) "
                    "VALUES (:tid, 'paper_note', :iid, CURRENT_TIMESTAMP)"
                ),
                {"tid": tag_id, "iid": note_id},
            )


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

        # PR1 unification backfills. Both are idempotent — safe to re-run.
        if "daily_tasks" in existing_tables:
            # Set planned_date = task_date for any row that doesn't have
            # it yet. After this, every legacy task is visible to "today"
            # queries written against planned_date.
            conn.execute(text("""
                UPDATE daily_tasks
                SET planned_date = task_date
                WHERE planned_date IS NULL
            """))
        if "daily_logs" in existing_tables and "mood_entries" in existing_tables:
            # Collapse the historical daily_logs.mood column into the
            # mood_entries stream. One entry per (user, day). We synthesise
            # a created_at of `log_date 12:00 UTC` to keep the row stable
            # across re-runs (so the WHERE NOT EXISTS guard works) without
            # colliding with same-day real-time mood entries the user may
            # have logged on top.
            conn.execute(text("""
                INSERT INTO mood_entries (user_id, mood, reflection, created_at)
                SELECT user_id, mood, '',
                       datetime(log_date || ' 12:00:00')
                FROM daily_logs d
                WHERE mood IS NOT NULL AND mood != ''
                  AND NOT EXISTS (
                      SELECT 1 FROM mood_entries m
                      WHERE m.user_id = d.user_id
                        AND m.mood = d.mood
                        AND m.created_at = datetime(d.log_date || ' 12:00:00')
                  )
            """))

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

        # Tag backfill: lift the legacy comma-separated `paper_notes.tags`
        # column into real (tags, tag_links) rows so the cross-module tag
        # cloud sees them. Both target tables are created by
        # Base.metadata.create_all before run_migrations runs, so they're
        # already in `existing_tables` — no need to re-inspect mid-
        # transaction (which would open a separate StaticPool connection
        # and confuse SQLite about the in-flight tx state).
        if (
            "paper_notes" in existing_tables
            and "tags" in existing_tables
            and "tag_links" in existing_tables
        ):
            _backfill_paper_note_tag_csv(conn)

        # Zotero dedupe guard: one PaperNote per (user, Zotero item key).
        # Re-importing the same item updates the existing row in place
        # rather than duplicating it. NULL keys (manual notes) are not
        # subject to the constraint — SQLite treats NULLs as distinct in
        # unique indexes by default.
        if "paper_notes" in existing_tables:
            conn.execute(text("""
                CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_notes_user_zotero_key
                ON paper_notes (user_id, zotero_key)
                WHERE zotero_key IS NOT NULL
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
