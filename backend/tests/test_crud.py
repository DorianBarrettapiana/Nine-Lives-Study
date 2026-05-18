"""CRUD + isolation tests for feynman / tracker / pomodoro / mood / xp / stats."""

from fastapi.testclient import TestClient

# --- Feynman ----------------------------------------------------------------


def test_feynman_crud(auth_client: TestClient):
    payload = {"concept": "BRDF", "explanation": "Ratio of reflected radiance...", "gaps": "", "analogy": ""}
    r = auth_client.post("/feynman", json=payload)
    assert r.status_code == 201
    entry_id = r.json()["id"]

    assert len(auth_client.get("/feynman").json()) == 1

    r = auth_client.patch(f"/feynman/{entry_id}", json={"explanation": "Updated"})
    assert r.status_code == 200 and r.json()["explanation"] == "Updated"

    assert auth_client.delete(f"/feynman/{entry_id}").status_code == 204
    assert auth_client.get("/feynman").json() == []


def test_feynman_isolation(auth_client: TestClient, second_auth_client: TestClient):
    r = auth_client.post("/feynman", json={"concept": "A", "explanation": "", "gaps": "", "analogy": ""})
    entry_id = r.json()["id"]
    assert second_auth_client.patch(f"/feynman/{entry_id}", json={"concept": "B"}).status_code == 404
    assert second_auth_client.delete(f"/feynman/{entry_id}").status_code == 404


# --- Daily tracker ----------------------------------------------------------


def test_daily_get_initial(auth_client: TestClient):
    r = auth_client.get("/daily")
    assert r.status_code == 200
    body = r.json()
    assert body["tasks"] == []
    assert body["done_count"] == 0
    assert body["total_count"] == 0
    assert body["completion_percent"] == 0


def test_create_task_and_complete(auth_client: TestClient):
    r = auth_client.post("/daily/tasks", json={"text": "Read paper"})
    assert r.status_code == 201
    task_id = r.json()["id"]
    assert r.json()["is_done"] is False

    r = auth_client.patch(f"/daily/tasks/{task_id}", json={"is_done": True})
    assert r.status_code == 200 and r.json()["is_done"] is True

    body = auth_client.get("/daily").json()
    assert body["total_count"] == 1 and body["done_count"] == 1
    assert body["completion_percent"] == 100


def test_task_isolation(auth_client: TestClient, second_auth_client: TestClient):
    task_id = auth_client.post("/daily/tasks", json={"text": "Mine"}).json()["id"]
    assert second_auth_client.patch(f"/daily/tasks/{task_id}", json={"is_done": True}).status_code == 404
    assert second_auth_client.delete(f"/daily/tasks/{task_id}").status_code == 404


def test_daily_log_upsert(auth_client: TestClient):
    r = auth_client.put("/daily/log", json={"mood": "🙂", "reflection": "Good day"})
    assert r.status_code == 200
    log = r.json()
    assert log["mood"] == "🙂" and log["reflection"] == "Good day"

    # Second call: should UPDATE the same log, not create a new one
    r = auth_client.put("/daily/log", json={"mood": "🔥", "reflection": "Better"})
    assert r.status_code == 200
    assert r.json()["id"] == log["id"]
    assert r.json()["mood"] == "🔥"


# --- Pomodoro ---------------------------------------------------------------


def test_pomodoro_start_complete_list(auth_client: TestClient):
    r = auth_client.post("/pomodoro", json={"session_type": "work", "duration_minutes": 25})
    assert r.status_code == 201
    session_id = r.json()["id"]
    assert r.json()["is_completed"] is False

    r = auth_client.patch(f"/pomodoro/{session_id}/complete", json={})
    assert r.status_code == 200 and r.json()["is_completed"] is True

    sessions = auth_client.get("/pomodoro").json()
    assert len(sessions) == 1 and sessions[0]["id"] == session_id


def test_pomodoro_delete(auth_client: TestClient):
    r = auth_client.post("/pomodoro", json={"session_type": "work", "duration_minutes": 25})
    session_id = r.json()["id"]
    assert auth_client.delete(f"/pomodoro/{session_id}").status_code == 204
    assert auth_client.get("/pomodoro").json() == []


def test_pomodoro_isolation(auth_client: TestClient, second_auth_client: TestClient):
    r = auth_client.post("/pomodoro", json={"session_type": "work", "duration_minutes": 25})
    session_id = r.json()["id"]
    assert second_auth_client.patch(f"/pomodoro/{session_id}/complete", json={}).status_code == 404
    assert second_auth_client.delete(f"/pomodoro/{session_id}").status_code == 404


# --- Mood -------------------------------------------------------------------


def test_mood_create_and_list(auth_client: TestClient):
    r = auth_client.post("/mood", json={"mood": "🙂", "reflection": ""})
    assert r.status_code == 201
    entries = auth_client.get("/mood").json()
    assert len(entries) == 1


def test_mood_isolation(auth_client: TestClient, second_auth_client: TestClient):
    r = auth_client.post("/mood", json={"mood": "🙂", "reflection": ""})
    entry_id = r.json()["id"]
    assert second_auth_client.delete(f"/mood/{entry_id}").status_code == 404


# --- XP / Stats / Users -----------------------------------------------------


def test_xp_starts_at_zero(auth_client: TestClient):
    body = auth_client.get("/xp").json()
    assert body["xp"] == 0 and body["level"] == 1


def test_users_me_returns_pomodoro_defaults(auth_client: TestClient):
    body = auth_client.get("/users/me").json()
    assert body["pomodoro_work_minutes"] == 25
    assert body["pomodoro_short_break_minutes"] == 5
    assert body["pomodoro_long_break_minutes"] == 15
    assert body["pomodoro_sessions_before_long_break"] == 4


def test_users_me_patch_pomodoro_settings(auth_client: TestClient):
    r = auth_client.patch("/users/me", json={"pomodoro_work_minutes": 50, "pomodoro_short_break_minutes": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["pomodoro_work_minutes"] == 50
    assert body["pomodoro_short_break_minutes"] == 10
    # Untouched fields keep defaults
    assert body["pomodoro_long_break_minutes"] == 15


def test_users_me_patch_validates_ranges(auth_client: TestClient):
    # Above 240 → 422
    assert auth_client.patch("/users/me", json={"pomodoro_work_minutes": 300}).status_code == 422
    # Below 1 → 422
    assert auth_client.patch("/users/me", json={"pomodoro_short_break_minutes": 0}).status_code == 422


def test_users_me_delete_logs_out(auth_client: TestClient):
    r = auth_client.delete("/users/me")
    assert r.status_code == 204
    # Cookie cleared → subsequent /auth/me is 401
    assert auth_client.get("/auth/me").status_code == 401


def test_stats_endpoint_returns_aggregates(auth_client: TestClient):
    auth_client.post("/notes", json={"title": "t", "authors": "", "year": None,
                                      "key_points": "", "questions": "", "tags": ""})
    body = auth_client.get("/stats?days=7").json()
    assert body["days"] == 7
    assert body["total_notes"] == 1
