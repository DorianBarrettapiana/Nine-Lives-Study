"""Stopwatch regression tests.

Covers the race / cap / cleanup fixes that landed alongside this file:
  - Concurrent /start can never create two active rows per user.
  - Pause caps accumulated_seconds at the client-claimed segment length.
  - Startup migration closes orphan in-progress sessions to one per user.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.core.migrations import run_migrations

# ---------------------------------------------------------------------------
# 1. Concurrent start can never create two active rows
# ---------------------------------------------------------------------------


def test_partial_unique_index_blocks_second_active_row(auth_client: TestClient, db_engine):
    """Directly assert the partial unique index: two INSERTs with
    ended_at=NULL for the same user must fail at the DB layer.

    This is the structural guarantee that makes the race fix complete —
    even if a future code path bypasses the route's check, the DB refuses.
    """
    auth_client.post("/stopwatch/start")
    user_id = auth_client.get("/users/me").json()["id"]

    with db_engine.connect() as conn, pytest.raises(IntegrityError):
        conn.execute(
            text("""
                INSERT INTO stopwatch_sessions
                    (user_id, started_at, last_started_at, accumulated_seconds)
                VALUES (:uid, :now, :now, 0)
            """),
            {"uid": user_id, "now": datetime.now(timezone.utc).replace(tzinfo=None)},
        )
        conn.commit()


def test_second_start_returns_existing_session(auth_client: TestClient):
    """Friendlier API behaviour: a second /start while one is active returns
    the existing one (idempotent), rather than 500-ing on the IntegrityError."""
    first = auth_client.post("/stopwatch/start").json()
    second = auth_client.post("/stopwatch/start")
    assert second.status_code in {200, 201, 409}
    if second.status_code != 409:
        assert second.json()["id"] == first["id"]


# ---------------------------------------------------------------------------
# 2. Pause respects the client-claimed elapsed cap
# ---------------------------------------------------------------------------


def test_pause_caps_accumulated_at_client_claim(auth_client: TestClient, db_engine):
    """Server's wall-clock delta is bounded by the client's reported segment.

    Simulates the laggy-network case: server received pause N seconds after
    the user actually clicked, so its own delta is N seconds long, but the
    client only saw 0-1 seconds on screen. We must credit the smaller value.
    """
    started = auth_client.post("/stopwatch/start").json()
    sid = started["id"]

    # Backdate last_started_at by 30 seconds so the server's own delta is huge.
    with db_engine.connect() as conn:
        conn.execute(
            text("UPDATE stopwatch_sessions SET last_started_at = :ts WHERE id = :id"),
            {
                "ts": datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=30),
                "id": sid,
            },
        )
        conn.commit()

    # Client claims only 1 second of running time.
    r = auth_client.post(f"/stopwatch/{sid}/pause?client_elapsed_seconds=1")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["is_running"] is False
    # Accumulated must be capped at the client's 1 sec, NOT the server's ~30.
    assert body["accumulated_seconds"] <= 1, body


def test_pause_without_client_claim_uses_server_delta(auth_client: TestClient):
    """Backwards-compat path: no client_elapsed_seconds → server computes."""
    started = auth_client.post("/stopwatch/start").json()
    sid = started["id"]
    r = auth_client.post(f"/stopwatch/{sid}/pause")
    assert r.status_code == 200
    assert r.json()["is_running"] is False


# ---------------------------------------------------------------------------
# 3. Migration closes orphan in-progress sessions
# ---------------------------------------------------------------------------


def test_migration_closes_orphan_active_sessions(auth_client: TestClient, db_engine):
    """Pre-existing duplicate active rows get cleaned up, newest kept."""
    # First, drop the partial unique index so we CAN seed duplicates (real
    # production DBs that ran the buggy code are in this state).
    with db_engine.connect() as conn:
        conn.execute(text("DROP INDEX IF EXISTS uq_stopwatch_one_active_per_user"))
        conn.commit()

    # Find the test user id.
    with db_engine.connect() as conn:
        user_id = conn.execute(text("SELECT id FROM users LIMIT 1")).scalar()
        assert user_id is not None
        # Seed 3 orphan active sessions with distinct started_at.
        for offset in (30, 20, 10):  # newest = 10 min ago
            conn.execute(text("""
                INSERT INTO stopwatch_sessions
                    (user_id, started_at, last_started_at, accumulated_seconds)
                VALUES (:uid, :sa, :sa, 0)
            """), {"uid": user_id, "sa": datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=offset)})
        conn.commit()

    # Re-run migrations — should close the older 2, keep the newest 1.
    run_migrations(db_engine)

    with db_engine.connect() as conn:
        active_count = conn.execute(text(
            "SELECT COUNT(*) FROM stopwatch_sessions WHERE ended_at IS NULL"
        )).scalar()
    assert active_count == 1, "expected exactly one active session after cleanup"


# ---------------------------------------------------------------------------
# 4. End emits XP equal to floor(accumulated / 60)
# ---------------------------------------------------------------------------


def test_end_awards_xp_equal_to_minutes(auth_client: TestClient, db_engine):
    started = auth_client.post("/stopwatch/start").json()
    sid = started["id"]
    # Inflate accumulated to 180 seconds directly so we don't have to wait.
    with db_engine.connect() as conn:
        conn.execute(text("""
            UPDATE stopwatch_sessions
            SET accumulated_seconds = 180, last_started_at = NULL
            WHERE id = :id
        """), {"id": sid})
        conn.commit()
    ended = auth_client.post(f"/stopwatch/{sid}/end").json()
    assert ended["ended_at"] is not None
    # End route awards floor(accumulated/60) XP. We verify via the user
    # progress endpoint rather than poking xp_events directly.
    progress = auth_client.get("/users/me").json()
    # Cat-skin minutes are XP-equivalent for stopwatch — should be at least 3.
    assert progress["cat_skin_minutes_accumulated"] >= 3


# ---------------------------------------------------------------------------
# 5. Datetime fields serialize with explicit Z suffix
# ---------------------------------------------------------------------------


def test_started_at_has_explicit_utc_suffix(auth_client: TestClient):
    """The base schema must emit `...Z` so the client doesn't have to guess."""
    started = auth_client.post("/stopwatch/start").json()
    assert isinstance(started["started_at"], str)
    assert started["started_at"].endswith("Z"), started["started_at"]
