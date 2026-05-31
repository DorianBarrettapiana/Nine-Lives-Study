"""Tests for PR1 of the Today/Daily-tracker unification:

- Task gains `planned_date` (mirrors `task_date` via dual-write) + `due_date`.
- DailyLog gains `main_goal_task_id`.
- New `/daily/tasks/upcoming` endpoint.
- Migration: backfills `planned_date` from `task_date` and copies historical
  daily_logs.mood into mood_entries (idempotent).
"""

from datetime import date, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models.daily_tracker import DailyLog, DailyTask
from app.models.mood_entry import MoodEntry

# ---------------------------------------------------------------------------
# Dual-write semantics on /daily/tasks
# ---------------------------------------------------------------------------


def test_create_task_with_task_date_mirrors_planned_date(auth_client: TestClient):
    """Old clients still send `task_date` only; server fills planned_date."""
    r = auth_client.post(
        "/daily/tasks",
        json={"text": "t", "task_date": "2026-06-05"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["task_date"] == "2026-06-05"
    assert body["planned_date"] == "2026-06-05"


def test_create_task_with_planned_date_mirrors_task_date(auth_client: TestClient):
    """New clients can send `planned_date`; server fills task_date for compat."""
    r = auth_client.post(
        "/daily/tasks",
        json={"text": "t", "planned_date": "2026-06-10"},
    )
    assert r.status_code == 201
    body = r.json()
    assert body["task_date"] == "2026-06-10"
    assert body["planned_date"] == "2026-06-10"


def test_create_task_with_due_date(auth_client: TestClient):
    r = auth_client.post(
        "/daily/tasks",
        json={"text": "deadline thing", "due_date": "2026-06-20"},
    )
    assert r.status_code == 201
    body = r.json()
    assert body["due_date"] == "2026-06-20"
    # task_date defaulted to today, due_date stands alone
    assert body["planned_date"] == date.today().isoformat()


def test_patch_planned_date_updates_task_date(auth_client: TestClient):
    """Editing planned_date must keep task_date in sync — otherwise the
    legacy 'tasks for day X' query goes stale."""
    tid = auth_client.post("/daily/tasks", json={"text": "t"}).json()["id"]
    r = auth_client.patch(f"/daily/tasks/{tid}", json={"planned_date": "2026-07-01"})
    assert r.status_code == 200
    body = r.json()
    assert body["planned_date"] == "2026-07-01"
    assert body["task_date"] == "2026-07-01"


# ---------------------------------------------------------------------------
# /daily/tasks/upcoming
# ---------------------------------------------------------------------------


def test_upcoming_returns_only_dated_undone_within_horizon(auth_client: TestClient):
    today = date.today()
    # Should appear (due tomorrow, not done)
    t1 = auth_client.post(
        "/daily/tasks",
        json={"text": "soon", "due_date": (today + timedelta(days=1)).isoformat()},
    ).json()
    # Should be filtered (no due_date)
    auth_client.post("/daily/tasks", json={"text": "no deadline"})
    # Should be filtered (beyond default 14-day horizon)
    auth_client.post(
        "/daily/tasks",
        json={"text": "far future", "due_date": (today + timedelta(days=60)).isoformat()},
    )
    # Should be filtered (already done)
    t_done = auth_client.post(
        "/daily/tasks",
        json={"text": "done one", "due_date": (today + timedelta(days=3)).isoformat()},
    ).json()
    auth_client.patch(f"/daily/tasks/{t_done['id']}", json={"is_done": True})

    r = auth_client.get("/daily/tasks/upcoming")
    assert r.status_code == 200
    ids = [t["id"] for t in r.json()]
    assert ids == [t1["id"]]


def test_upcoming_includes_overdue_by_default(auth_client: TestClient):
    today = date.today()
    overdue = auth_client.post(
        "/daily/tasks",
        json={"text": "missed", "due_date": (today - timedelta(days=5)).isoformat()},
    ).json()
    r = auth_client.get("/daily/tasks/upcoming")
    assert overdue["id"] in [t["id"] for t in r.json()]


def test_upcoming_can_exclude_overdue(auth_client: TestClient):
    today = date.today()
    auth_client.post(
        "/daily/tasks",
        json={"text": "missed", "due_date": (today - timedelta(days=5)).isoformat()},
    )
    upcoming = auth_client.post(
        "/daily/tasks",
        json={"text": "tomorrow", "due_date": (today + timedelta(days=1)).isoformat()},
    ).json()
    r = auth_client.get("/daily/tasks/upcoming?include_overdue=false")
    ids = [t["id"] for t in r.json()]
    assert upcoming["id"] in ids
    assert all(t["due_date"] >= today.isoformat() for t in r.json())


def test_upcoming_sorted_by_due_date_ascending(auth_client: TestClient):
    today = date.today()
    late = auth_client.post(
        "/daily/tasks", json={"text": "late", "due_date": (today + timedelta(days=10)).isoformat()},
    ).json()
    early = auth_client.post(
        "/daily/tasks", json={"text": "early", "due_date": (today + timedelta(days=2)).isoformat()},
    ).json()
    ids = [t["id"] for t in auth_client.get("/daily/tasks/upcoming").json()]
    assert ids.index(early["id"]) < ids.index(late["id"])


def test_upcoming_cross_user_isolation(
    auth_client: TestClient, second_auth_client: TestClient,
):
    today = date.today()
    second_auth_client.post(
        "/daily/tasks",
        json={"text": "intruder", "due_date": (today + timedelta(days=2)).isoformat()},
    )
    r = auth_client.get("/daily/tasks/upcoming")
    assert r.json() == []


# ---------------------------------------------------------------------------
# main_goal_task_id on /daily/log
# ---------------------------------------------------------------------------


def test_log_accepts_main_goal_task_id(auth_client: TestClient):
    tid = auth_client.post("/daily/tasks", json={"text": "primary"}).json()["id"]
    r = auth_client.put(
        "/daily/log",
        json={"mood": "🙂", "reflection": "", "main_goal_task_id": tid},
    )
    assert r.status_code == 200, r.text
    assert r.json()["main_goal_task_id"] == tid


def test_log_rejects_unknown_main_goal_task(auth_client: TestClient):
    r = auth_client.put(
        "/daily/log",
        json={"mood": "🙂", "reflection": "", "main_goal_task_id": 99999},
    )
    assert r.status_code == 400


def test_log_rejects_other_users_main_goal_task(
    auth_client: TestClient, second_auth_client: TestClient,
):
    foreign = second_auth_client.post("/daily/tasks", json={"text": "theirs"}).json()["id"]
    r = auth_client.put(
        "/daily/log",
        json={"mood": "🙂", "reflection": "", "main_goal_task_id": foreign},
    )
    assert r.status_code == 400


def test_log_main_goal_task_unassign_with_zero(auth_client: TestClient):
    """The PUT-style endpoint uses 0 as the sentinel for "unassign" because
    treating bare-omission as "unassign" would silently clear the field
    on every save."""
    tid = auth_client.post("/daily/tasks", json={"text": "x"}).json()["id"]
    auth_client.put("/daily/log", json={"mood": "🙂", "reflection": "", "main_goal_task_id": tid})
    r = auth_client.put("/daily/log", json={"mood": "🙂", "reflection": "", "main_goal_task_id": 0})
    assert r.status_code == 200
    assert r.json()["main_goal_task_id"] is None


# ---------------------------------------------------------------------------
# Migration backfills
# ---------------------------------------------------------------------------


def test_migration_backfills_planned_date_from_task_date(
    auth_client: TestClient, db_engine,
):
    """Insert a row with NULL planned_date directly, then re-run migrations
    to confirm the backfill repairs it. Mirrors how production-pre-PR rows
    will look on first deploy."""
    from app.core.migrations import run_migrations

    user_id = 1  # auth_client registers as the first user
    with Session(db_engine) as s:
        s.execute(text("""
            INSERT INTO daily_tasks (user_id, task_date, planned_date, text,
                                     is_done, sort_order, created_at, updated_at)
            VALUES (:uid, '2026-05-01', NULL, 'legacy', 0, 1.0,
                    '2026-05-01 00:00:00', '2026-05-01 00:00:00')
        """), {"uid": user_id})
        s.commit()

    run_migrations(db_engine)

    with Session(db_engine) as s:
        row = s.scalars(
            select(DailyTask).where(DailyTask.text == "legacy")
        ).first()
        assert row is not None
        assert row.planned_date == date(2026, 5, 1)


def test_migration_backfills_mood_into_mood_entries(
    auth_client: TestClient, db_engine,
):
    """Legacy daily_logs with non-empty mood get a synthetic mood_entries
    row (one per day, idempotent across re-runs)."""
    from app.core.migrations import run_migrations

    user_id = 1
    log = DailyLog(
        user_id=user_id,
        log_date=date(2026, 4, 10),
        main_goal="",
        mood="🔥",
        reflection="",
    )
    with Session(db_engine) as s:
        s.add(log)
        s.commit()

    # Run twice — the second invocation must be a no-op.
    run_migrations(db_engine)
    run_migrations(db_engine)

    with Session(db_engine) as s:
        rows = list(s.scalars(
            select(MoodEntry).where(MoodEntry.user_id == user_id),
        ).all())
        assert len(rows) == 1
        assert rows[0].mood == "🔥"
        assert rows[0].created_at.date() == date(2026, 4, 10)
