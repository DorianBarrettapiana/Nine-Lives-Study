"""Regression tests for the daily product workflow added around Today."""

from datetime import date, datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.routes import summaries
from app.core.ai import SummaryResult, gather_weekly


def test_unfinished_task_carry_forward_moves_in_place(auth_client: TestClient):
    """Carry-forward re-schedules the existing row (move), it does not create
    a copy — so the same task never shows up twice (e.g. inside a project)."""
    task = auth_client.post(
        "/daily/tasks", json={"text": "Revise introduction", "task_date": "2026-05-31"},
    ).json()

    first = auth_client.post(f"/daily/tasks/{task['id']}/carry-forward")
    assert first.status_code == 200
    assert first.json()["id"] == task["id"]
    assert first.json()["task_date"] == "2026-06-01"
    assert first.json()["planned_date"] == "2026-06-01"

    # It has left its original day entirely (no duplicate left behind).
    assert auth_client.get("/daily?date=2026-05-31").json()["total_count"] == 0
    assert auth_client.get("/daily?date=2026-06-01").json()["total_count"] == 1

    # Carrying again moves the same row one more day forward.
    second = auth_client.post(f"/daily/tasks/{task['id']}/carry-forward")
    assert second.status_code == 200
    assert second.json()["id"] == task["id"]
    assert second.json()["task_date"] == "2026-06-02"


def test_completed_task_is_not_carried_forward(auth_client: TestClient):
    task = auth_client.post("/daily/tasks", json={"text": "Done"}).json()
    auth_client.patch(f"/daily/tasks/{task['id']}", json={"is_done": True})

    response = auth_client.post(f"/daily/tasks/{task['id']}/carry-forward")

    assert response.status_code == 400


def test_parent_task_carries_unfinished_subtasks_forward(auth_client: TestClient):
    parent = auth_client.post("/daily/tasks", json={
        "text": "Process data", "task_date": "2026-05-31",
    }).json()
    child = auth_client.post("/daily/tasks", json={
        "text": "Normalize columns", "parent_task_id": parent["id"],
    }).json()
    done_child = auth_client.post("/daily/tasks", json={
        "text": "Download source", "parent_task_id": parent["id"],
    }).json()
    auth_client.patch(f"/daily/tasks/{done_child['id']}", json={"is_done": True})

    response = auth_client.post(f"/daily/tasks/{parent['id']}/carry-forward")
    # Carry-forward moves rows instead of copying them, so the response is
    # 200 (updated) and the parent/child kept their original ids.
    assert response.status_code == 200, response.text
    assert response.json()["id"] == parent["id"]

    next_day = auth_client.get("/daily?date=2026-06-01").json()["tasks"]
    moved_parent = next(task for task in next_day if task["parent_task_id"] is None)
    moved_children = [task for task in next_day if task["parent_task_id"] == moved_parent["id"]]
    assert moved_parent["id"] == parent["id"]
    assert [task["id"] for task in moved_children] == [child["id"]]


def test_subtasks_inherit_project_and_stop_at_one_level(auth_client: TestClient):
    project = auth_client.post("/projects", json={"name": "Pipeline"}).json()
    parent = auth_client.post("/daily/tasks", json={
        "text": "Process data", "project_id": project["id"],
    }).json()
    child = auth_client.post("/daily/tasks", json={
        "text": "Normalize columns", "parent_task_id": parent["id"],
    })
    assert child.status_code == 201, child.text
    assert child.json()["project_id"] == project["id"]

    nested = auth_client.post("/daily/tasks", json={
        "text": "Inspect nulls", "parent_task_id": child.json()["id"],
    })
    assert nested.status_code == 400


def test_subtask_parent_is_user_scoped(auth_client: TestClient, second_auth_client: TestClient):
    parent = auth_client.post("/daily/tasks", json={"text": "Private parent"}).json()

    response = second_auth_client.post("/daily/tasks", json={
        "text": "Foreign child", "parent_task_id": parent["id"],
    })

    assert response.status_code == 400


def test_deleting_parent_task_removes_subtasks(auth_client: TestClient):
    parent = auth_client.post("/daily/tasks", json={"text": "Process data"}).json()
    auth_client.post("/daily/tasks", json={
        "text": "Normalize columns", "parent_task_id": parent["id"],
    })

    response = auth_client.delete(f"/daily/tasks/{parent['id']}")

    assert response.status_code == 204
    assert auth_client.get("/daily").json()["tasks"] == []


def test_pomodoro_focus_appears_in_stats(auth_client: TestClient):
    task = auth_client.post("/daily/tasks", json={"text": "Read diffusion paper"}).json()
    session = auth_client.post(
        "/pomodoro",
        json={"session_type": "work", "duration_minutes": 25, "linked_task_id": task["id"]},
    ).json()
    auth_client.patch(f"/pomodoro/{session['id']}/complete", json={})

    stats = auth_client.get("/stats?days=7").json()

    assert stats["work_labels"] == [{"label": "Read diffusion paper", "minutes": 25}]


def test_stats_task_ratio_includes_unfinished_tasks(auth_client: TestClient):
    first = auth_client.post("/daily/tasks", json={"text": "Draft results"}).json()
    auth_client.post("/daily/tasks", json={"text": "Read reviewer notes"})
    auth_client.post("/daily/tasks", json={
        "text": "Plan tomorrow",
        "task_date": (date.today() + timedelta(days=1)).isoformat(),
    })
    auth_client.patch(f"/daily/tasks/{first['id']}", json={"is_done": True})

    # The /daily/tasks route stamps task_date with `date.today()` (local),
    # while /stats defaults to UTC `today`. Those differ on runners whose
    # local clock isn't UTC (e.g. self-hosted Windows), so today's task
    # falls outside the [today-6, today] window in UTC and the response
    # is empty. The frontend always sends tz_offset; mirror that here so
    # the test passes on any runner regardless of its timezone.
    tz_offset_min = round(
        (datetime.now() - datetime.now(timezone.utc).replace(tzinfo=None)).total_seconds() / 60
    )
    stats = auth_client.get(f"/stats?days=7&tz_offset={tz_offset_min}").json()

    assert stats["daily_tasks"] == [{
        "date": first["task_date"],
        "total": 2,
        "done": 1,
    }]


def test_daily_tracker_mood_appears_in_mood_history(auth_client: TestClient):
    payload = {"mood": "focused", "reflection": "Good momentum"}

    first = auth_client.put("/daily/log", json=payload)
    second = auth_client.put("/daily/log", json=payload)
    history = auth_client.get("/mood").json()

    assert first.status_code == 200
    assert second.status_code == 200
    assert [entry["mood"] for entry in history] == ["focused"]


def test_quick_mood_updates_daily_log_snapshot(auth_client: TestClient):
    response = auth_client.post("/mood", json={"mood": "calm", "reflection": ""})

    daily = auth_client.get("/daily").json()

    assert response.status_code == 201
    assert daily["log"]["mood"] == "calm"


def test_ai_weekly_focus_uses_temporary_label(auth_client: TestClient, db_engine):
    user_id = auth_client.get("/users/me").json()["id"]
    session = auth_client.post(
        "/pomodoro",
        json={"session_type": "work", "duration_minutes": 25, "work_label": "Sketch experiment design"},
    ).json()
    auth_client.patch(f"/pomodoro/{session['id']}/complete", json={})
    now = datetime.now(timezone.utc)

    with Session(db_engine) as db:
        recap = gather_weekly(
            user_id,
            now - timedelta(days=1),
            db,
            now + timedelta(days=1),
        )

    assert recap["time_per_task_minutes"] == {"Sketch experiment design": 25}


def test_stopwatch_accepts_temporary_focus(auth_client: TestClient):
    response = auth_client.post(
        "/stopwatch/start", json={"work_label": "Sketch experiment design"},
    )

    assert response.status_code == 201
    assert response.json()["work_label"] == "Sketch experiment design"
    assert response.json()["linked_task_id"] is None


def test_paper_note_supports_metadata_and_feynman_link(auth_client: TestClient):
    entry = auth_client.post("/feynman", json={
        "concept": "Diffusion model",
        "explanation": "A simple explanation",
        "gaps": "",
        "analogy": "",
    }).json()

    note = auth_client.post("/notes", json={
        "title": "A useful paper",
        "authors": "Researcher",
        "year": 2026,
        "key_points": "",
        "questions": "",
        "tags": "diffusion",
        "doi": "10.1000/example",
        "url": "https://example.com/paper",
        "feynman_entry_id": entry["id"],
    })

    assert note.status_code == 201
    assert note.json()["doi"] == "10.1000/example"
    assert note.json()["feynman_entry_id"] == entry["id"]


def test_user_can_disable_social_sharing(auth_client: TestClient):
    response = auth_client.patch("/users/me", json={
        "share_study_time": False,
        "share_activity": False,
    })

    assert response.status_code == 200
    assert response.json()["share_study_time"] is False
    assert response.json()["share_activity"] is False


def test_feynman_ai_critique_route_is_exposed(auth_client: TestClient, monkeypatch):
    entry = auth_client.post("/feynman", json={
        "concept": "Diffusion model",
        "explanation": "A simple explanation",
        "gaps": "",
        "analogy": "",
    }).json()
    auth_client.post("/summaries/opt-in", json={"opted_in": True})
    monkeypatch.setattr(summaries.ai, "is_configured", lambda: True)
    monkeypatch.setattr(
        summaries.ai,
        "summarise_feynman_review",
        lambda *_args: SummaryResult("Useful critique", "test-model", 10, 5),
    )

    response = auth_client.post(f"/summaries/feynman/{entry['id']}/generate")

    assert response.status_code == 201
    assert response.json()["kind"] == "feynman_review"
    assert response.json()["content"] == "Useful critique"


def test_paper_note_read_today_flows_into_focus_minutes_and_recap(
    auth_client: TestClient, db_engine,
):
    project = auth_client.post("/projects", json={"name": "Survey draft"}).json()
    note = auth_client.post("/notes", json={
        "title": "Attention Is All You Need",
        "authors": "Vaswani et al.",
        "year": 2017,
        "key_points": "",
        "questions": "",
        "tags": "transformers",
        "project_id": project["id"],
    }).json()

    first = auth_client.post(f"/notes/{note['id']}/add-to-today")
    second = auth_client.post(f"/notes/{note['id']}/add-to-today")
    task = first.json()

    assert first.status_code == 201
    assert second.status_code == 201
    assert second.json()["id"] == task["id"]
    assert task["text"] == "Read: Attention Is All You Need"
    assert task["paper_note_id"] == note["id"]
    assert task["project_id"] == project["id"]

    session = auth_client.post("/pomodoro", json={
        "session_type": "work",
        "duration_minutes": 25,
        "linked_task_id": task["id"],
    }).json()
    auth_client.patch(f"/pomodoro/{session['id']}/complete", json={})

    notes = auth_client.get("/notes").json()
    assert notes[0]["reading_status"] == "reading"
    assert notes[0]["reading_minutes"] == 25

    now = datetime.now(timezone.utc)
    user_id = auth_client.get("/users/me").json()["id"]
    with Session(db_engine) as db:
        recap = gather_weekly(user_id, now - timedelta(days=1), db, now + timedelta(days=1))
    assert recap["time_per_project_minutes"] == {"Survey draft": 25}
    assert recap["papers_touched"] == [{
        "title": "Attention Is All You Need",
        "reading_status": "reading",
        "focus_minutes": 25,
    }]


def test_paper_note_reading_status_can_be_updated(auth_client: TestClient):
    note = auth_client.post("/notes", json={
        "title": "Paper",
        "authors": "",
        "year": None,
        "key_points": "",
        "questions": "",
        "tags": "",
    }).json()

    response = auth_client.patch(f"/notes/{note['id']}", json={"reading_status": "revisit"})

    assert response.status_code == 200
    assert response.json()["reading_status"] == "revisit"


def test_monthly_progress_recap_route_is_exposed(auth_client: TestClient, monkeypatch):
    auth_client.post("/summaries/opt-in", json={"opted_in": True})
    monkeypatch.setattr(summaries.ai, "is_configured", lambda: True)
    monkeypatch.setattr(
        summaries.ai,
        "summarise_progress_recap",
        lambda *_args: SummaryResult("Advisor-ready recap", "test-model", 10, 5),
    )
    # Monthly recap is now restricted to the last 3 days of the calendar
    # month — freeze "now" to a date in that window so this route smoke
    # test isn't time-of-month dependent.
    monkeypatch.setattr(summaries, "_utc_now", lambda: datetime(2026, 6, 30, 12, tzinfo=timezone.utc))

    response = auth_client.post("/summaries/progress/monthly/generate")

    assert response.status_code == 201
    assert response.json()["kind"] == "monthly"
    assert response.json()["content"] == "Advisor-ready recap"
