"""Tests for /projects CRUD and the project_id wiring on daily tasks,
paper notes, and Feynman entries."""

from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_project(client: TestClient, name: str = "Thread A", color: str = "") -> int:
    r = client.post("/projects", json={"name": name, "color": color})
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def test_list_projects_empty(auth_client: TestClient):
    r = auth_client.get("/projects")
    assert r.status_code == 200
    assert r.json() == []


def test_create_and_list_project(auth_client: TestClient):
    pid = _make_project(auth_client, "Thesis")
    r = auth_client.get("/projects")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["id"] == pid
    assert body[0]["name"] == "Thesis"
    assert body[0]["is_archived"] is False


def test_create_rejects_bad_color(auth_client: TestClient):
    r = auth_client.post("/projects", json={"name": "X", "color": "not-a-color"})
    assert r.status_code == 422


def test_archive_and_filter(auth_client: TestClient):
    pid_active = _make_project(auth_client, "Active")
    pid_arch = _make_project(auth_client, "Archived")
    auth_client.patch(f"/projects/{pid_arch}", json={"is_archived": True})

    r_default = auth_client.get("/projects")
    assert [p["id"] for p in r_default.json()] == [pid_active]

    r_all = auth_client.get("/projects?include_archived=true")
    assert {p["id"] for p in r_all.json()} == {pid_active, pid_arch}


def test_rename_project(auth_client: TestClient):
    pid = _make_project(auth_client, "Old")
    r = auth_client.patch(f"/projects/{pid}", json={"name": "New"})
    assert r.status_code == 200
    assert r.json()["name"] == "New"


def test_cross_user_isolation(auth_client: TestClient, second_auth_client: TestClient):
    pid = _make_project(auth_client, "Owner's")
    # Other user cannot read / patch / delete by id
    assert second_auth_client.patch(f"/projects/{pid}", json={"name": "stolen"}).status_code == 404
    assert second_auth_client.delete(f"/projects/{pid}").status_code == 404
    # Other user's list is empty
    assert second_auth_client.get("/projects").json() == []


# ---------------------------------------------------------------------------
# project_id on dependent rows
# ---------------------------------------------------------------------------


def test_create_task_with_project(auth_client: TestClient):
    pid = _make_project(auth_client)
    r = auth_client.post("/daily/tasks", json={"text": "Read paper X", "project_id": pid})
    assert r.status_code == 201, r.text
    assert r.json()["project_id"] == pid


def test_create_task_rejects_unknown_project(auth_client: TestClient):
    r = auth_client.post("/daily/tasks", json={"text": "x", "project_id": 9999})
    assert r.status_code == 400


def test_cannot_assign_other_users_project_to_own_task(
    auth_client: TestClient, second_auth_client: TestClient,
):
    foreign_pid = _make_project(second_auth_client)
    r = auth_client.post("/daily/tasks", json={"text": "x", "project_id": foreign_pid})
    assert r.status_code == 400


def test_patch_task_changes_project(auth_client: TestClient):
    pid_a = _make_project(auth_client, "A")
    pid_b = _make_project(auth_client, "B")
    r1 = auth_client.post("/daily/tasks", json={"text": "t", "project_id": pid_a})
    tid = r1.json()["id"]
    r2 = auth_client.patch(f"/daily/tasks/{tid}", json={"project_id": pid_b})
    assert r2.status_code == 200
    assert r2.json()["project_id"] == pid_b


def test_patch_task_can_unassign_project(auth_client: TestClient):
    pid = _make_project(auth_client)
    r1 = auth_client.post("/daily/tasks", json={"text": "t", "project_id": pid})
    tid = r1.json()["id"]
    r2 = auth_client.patch(f"/daily/tasks/{tid}", json={"project_id": None})
    assert r2.status_code == 200
    assert r2.json()["project_id"] is None


def test_paper_note_carries_project(auth_client: TestClient):
    pid = _make_project(auth_client)
    r = auth_client.post(
        "/notes",
        json={
            "title": "Paper", "authors": "Me", "year": 2026,
            "key_points": "", "questions": "", "tags": "",
            "project_id": pid,
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["project_id"] == pid


def test_feynman_carries_project(auth_client: TestClient):
    pid = _make_project(auth_client)
    r = auth_client.post(
        "/feynman",
        json={"concept": "X", "explanation": "", "gaps": "", "analogy": "", "project_id": pid},
    )
    assert r.status_code == 201
    assert r.json()["project_id"] == pid


# ---------------------------------------------------------------------------
# Deletion cascades to NULL
# ---------------------------------------------------------------------------


def test_delete_project_unassigns_dependents(auth_client: TestClient):
    pid = _make_project(auth_client)
    auth_client.post("/daily/tasks", json={"text": "t1", "project_id": pid})
    auth_client.post("/daily/tasks", json={"text": "t2", "project_id": pid})
    auth_client.post(
        "/notes",
        json={"title": "n", "authors": "", "year": None, "key_points": "",
              "questions": "", "tags": "", "project_id": pid},
    )
    auth_client.post(
        "/feynman",
        json={"concept": "c", "explanation": "", "gaps": "", "analogy": "", "project_id": pid},
    )

    r = auth_client.delete(f"/projects/{pid}")
    assert r.status_code == 204

    # Project gone.
    assert auth_client.get("/projects").json() == []
    # Dependents still exist but unassigned.
    tasks = auth_client.get("/daily").json()["tasks"]
    assert len(tasks) == 2
    assert all(t["project_id"] is None for t in tasks)
    assert all(n["project_id"] is None for n in auth_client.get("/notes").json())
    assert all(e["project_id"] is None for e in auth_client.get("/feynman").json())


# ---------------------------------------------------------------------------
# Stats: time_per_project surfaces the breakdown
# ---------------------------------------------------------------------------


def test_stats_time_per_project_empty_window(auth_client: TestClient):
    """Stats endpoint always exposes the new field, even with no data."""
    r = auth_client.get("/stats?days=7")
    assert r.status_code == 200
    assert r.json().get("time_per_project") == []


def test_stats_time_per_project_aggregates_via_linked_task(auth_client: TestClient):
    """Sessions inherit project transitively via linked_task_id → daily_task."""
    pid_a = _make_project(auth_client, "Alpha")
    pid_b = _make_project(auth_client, "Beta")
    task_a = auth_client.post("/daily/tasks", json={"text": "ta", "project_id": pid_a}).json()
    task_b = auth_client.post("/daily/tasks", json={"text": "tb", "project_id": pid_b}).json()
    task_un = auth_client.post("/daily/tasks", json={"text": "tu"}).json()

    # 25 min on A, 25 min on B (default work session), 25 min unassigned.
    # Pomodoro has a partial unique index forbidding 2 in-progress work
    # sessions per user, so each iteration must complete before the next.
    for tid in (task_a["id"], task_b["id"], task_un["id"]):
        r = auth_client.post(
            "/pomodoro",
            json={"session_type": "work", "linked_task_id": tid},
        )
        assert r.status_code in (200, 201), r.text
        sid = r.json()["id"]
        r2 = auth_client.patch(f"/pomodoro/{sid}/complete", json={})
        assert r2.status_code in (200, 204), r2.text

    body = auth_client.get("/stats?days=7").json()
    rows = body["time_per_project"]
    by_name = {r["name"]: r["minutes"] for r in rows}
    assert by_name.get("Alpha", 0) == 25
    assert by_name.get("Beta", 0) == 25
    assert by_name.get("(no project)", 0) == 25
    # "(no project)" sits at the tail of the sorted list.
    assert rows[-1]["name"] == "(no project)"


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------


def test_dashboard_404_for_unknown_project(auth_client: TestClient):
    r = auth_client.get("/projects/9999/dashboard")
    assert r.status_code == 404


def test_dashboard_basic_shape(auth_client: TestClient):
    pid = _make_project(auth_client, "Diffusion")
    r = auth_client.get(f"/projects/{pid}/dashboard")
    assert r.status_code == 200
    body = r.json()
    assert body["project"]["id"] == pid
    assert body["minutes_7d"] == 0
    assert body["minutes_30d"] == 0
    assert body["open_tasks_count"] == 0
    assert body["open_tasks"] == []
    assert body["paper_notes"] == []
    assert body["feynman_entries"] == []
    assert body["recent_reflections"] == []


def test_dashboard_aggregates_work_minutes_and_open_tasks(auth_client: TestClient):
    pid = _make_project(auth_client, "Alpha")
    other = _make_project(auth_client, "Beta")
    task_a = auth_client.post("/daily/tasks", json={"text": "in alpha", "project_id": pid}).json()
    task_b = auth_client.post("/daily/tasks", json={"text": "in beta", "project_id": other}).json()
    # 25 minutes on each (default work session length).
    for tid in (task_a["id"], task_b["id"]):
        s = auth_client.post(
            "/pomodoro",
            json={"session_type": "work", "linked_task_id": tid},
        ).json()
        auth_client.patch(f"/pomodoro/{s['id']}/complete", json={})

    body = auth_client.get(f"/projects/{pid}/dashboard").json()
    assert body["minutes_7d"] == 25
    assert body["minutes_30d"] == 25
    assert body["open_tasks_count"] == 1
    assert body["open_tasks"][0]["id"] == task_a["id"]
    assert body["last_activity_at"] is not None


def test_dashboard_reflection_mentions_substring_match(auth_client: TestClient):
    pid = _make_project(auth_client, "Diffusion")
    auth_client.put("/daily/log", json={
        "mood": "🙂",
        "reflection": "Today I read more about diffusion models and the score matching trick.",
    })
    body = auth_client.get(f"/projects/{pid}/dashboard").json()
    mentions = body["recent_reflections"]
    assert len(mentions) == 1
    assert "diffusion" in mentions[0]["snippet"].lower()


def test_dashboard_includes_paper_notes_and_feynman(auth_client: TestClient):
    pid = _make_project(auth_client, "Survey")
    auth_client.post("/notes", json={
        "title": "Smith 2024", "authors": "Smith", "year": 2024,
        "key_points": "", "questions": "", "tags": "",
        "project_id": pid,
    })
    auth_client.post("/feynman", json={
        "concept": "Backprop", "explanation": "", "gaps": "", "analogy": "",
        "project_id": pid,
    })
    body = auth_client.get(f"/projects/{pid}/dashboard").json()
    assert len(body["paper_notes"]) == 1
    assert body["paper_notes"][0]["title"] == "Smith 2024"
    assert len(body["feynman_entries"]) == 1
    assert body["feynman_entries"][0]["concept"] == "Backprop"
