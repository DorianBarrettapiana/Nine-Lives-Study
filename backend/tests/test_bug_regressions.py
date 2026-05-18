"""Regression tests for bugs reported by the user on 2026-05-18.

These tests are EXPECTED TO FAIL on the current implementation. They drive
the upcoming bug fixes; when the fixes land, all of them must turn green.
Mark them as expected-to-fail (xfail) for now so the CI stays green while
we work on the fixes.
"""

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Bug 1: XP can be farmed by toggling a task done/undone repeatedly.
# Expected behavior: each task grants XP at most once over its lifetime,
# regardless of how many times it's toggled.
# ---------------------------------------------------------------------------


@pytest.mark.xfail(reason="Bug: toggling a task done/undone/done re-awards XP each time.")
def test_xp_not_farmable_via_task_toggle(auth_client: TestClient):
    task_id = auth_client.post("/daily/tasks", json={"text": "X"}).json()["id"]
    xp_baseline = auth_client.get("/xp").json()["xp"]

    # Toggle done → expected: +10 XP
    auth_client.patch(f"/daily/tasks/{task_id}", json={"is_done": True})
    xp_after_first = auth_client.get("/xp").json()["xp"]
    assert xp_after_first == xp_baseline + 10

    # Untoggle, then re-toggle: should NOT grant XP again
    auth_client.patch(f"/daily/tasks/{task_id}", json={"is_done": False})
    auth_client.patch(f"/daily/tasks/{task_id}", json={"is_done": True})
    xp_after_retoggle = auth_client.get("/xp").json()["xp"]
    assert xp_after_retoggle == xp_after_first, (
        f"XP was farmed by toggling: {xp_baseline} → {xp_after_first} → {xp_after_retoggle}"
    )


# ---------------------------------------------------------------------------
# Bug 2: Saving the daily log repeatedly farms XP.
# Expected behavior: a given day's daily log grants XP at most once.
# ---------------------------------------------------------------------------


@pytest.mark.xfail(reason="Bug: each PUT /daily/log re-awards XP without dedup.")
def test_xp_not_farmable_via_daily_log_save(auth_client: TestClient):
    xp_baseline = auth_client.get("/xp").json()["xp"]

    auth_client.put("/daily/log", json={"mood": "🙂", "reflection": "first"})
    xp_after_first = auth_client.get("/xp").json()["xp"]
    assert xp_after_first == xp_baseline + 5  # XP_DAILY_LOG_SAVE

    # Save again with different content: should NOT grant additional XP
    auth_client.put("/daily/log", json={"mood": "🔥", "reflection": "updated"})
    xp_after_second = auth_client.get("/xp").json()["xp"]
    assert xp_after_second == xp_after_first


# ---------------------------------------------------------------------------
# Bug 3: Deleting a completed task removes it from stats history.
# Expected behavior: once a task counted toward stats (was completed at some
# point), deleting it does NOT retroactively remove it from the counts.
# ---------------------------------------------------------------------------


@pytest.mark.xfail(reason="Bug: stats query counts current rows, not historical events.")
def test_deleted_completed_task_still_counted_in_stats(auth_client: TestClient):
    # Create + complete two tasks
    t1 = auth_client.post("/daily/tasks", json={"text": "t1"}).json()["id"]
    t2 = auth_client.post("/daily/tasks", json={"text": "t2"}).json()["id"]
    auth_client.patch(f"/daily/tasks/{t1}", json={"is_done": True})
    auth_client.patch(f"/daily/tasks/{t2}", json={"is_done": True})
    before = auth_client.get("/stats?days=7").json()["total_tasks_done"]
    assert before == 2

    # Delete one of them. It still happened — stats should reflect that.
    auth_client.delete(f"/daily/tasks/{t1}")
    after = auth_client.get("/stats?days=7").json()["total_tasks_done"]
    assert after == 2, f"Deleting a completed task wiped a stats point: {before} → {after}"


# ---------------------------------------------------------------------------
# Bug 4: Pomodoro work session XP can be re-awarded.
# Expected behavior: each pomodoro session grants XP at most once on
# completion. Re-PATCHing /complete on an already-completed session
# should NOT re-award.
# ---------------------------------------------------------------------------


@pytest.mark.xfail(reason="Bug: re-completing a pomodoro session re-awards XP.")
def test_xp_not_farmable_via_pomodoro_recomplete(auth_client: TestClient):
    r = auth_client.post("/pomodoro", json={"session_type": "work", "duration_minutes": 25})
    session_id = r.json()["id"]

    xp_baseline = auth_client.get("/xp").json()["xp"]
    auth_client.patch(f"/pomodoro/{session_id}/complete", json={})
    xp_first = auth_client.get("/xp").json()["xp"]
    assert xp_first == xp_baseline + 25  # XP_POMODORO_COMPLETE

    # PATCH /complete again on the already-completed session
    auth_client.patch(f"/pomodoro/{session_id}/complete", json={})
    xp_second = auth_client.get("/xp").json()["xp"]
    assert xp_second == xp_first


# ---------------------------------------------------------------------------
# Bug 5: Deleting a completed pomodoro session removes it from stats.
# Expected: pomodoro stats count completion events, not current rows.
# ---------------------------------------------------------------------------


@pytest.mark.xfail(reason="Bug: pomodoro stats query counts current rows.")
def test_deleted_pomodoro_still_in_stats(auth_client: TestClient):
    r = auth_client.post("/pomodoro", json={"session_type": "work", "duration_minutes": 25})
    sid = r.json()["id"]
    auth_client.patch(f"/pomodoro/{sid}/complete", json={})

    before = auth_client.get("/stats?days=7").json()["total_pomodoros"]
    assert before == 1

    auth_client.delete(f"/pomodoro/{sid}")
    after = auth_client.get("/stats?days=7").json()["total_pomodoros"]
    assert after == 1


# ---------------------------------------------------------------------------
# Bonus: also verify that creating a note grants XP exactly once (currently
# correct, but worth pinning down so the refactor doesn't break it).
# ---------------------------------------------------------------------------


def test_note_create_grants_xp_once(auth_client: TestClient):
    xp_baseline = auth_client.get("/xp").json()["xp"]
    auth_client.post("/notes", json={
        "title": "Paper", "authors": "", "year": None,
        "key_points": "", "questions": "", "tags": "",
    })
    xp_after = auth_client.get("/xp").json()["xp"]
    assert xp_after == xp_baseline + 10  # XP_NOTE_CREATE
