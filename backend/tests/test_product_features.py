"""Regression tests for the daily product workflow added around Today."""

from fastapi.testclient import TestClient

from app.api.routes import summaries
from app.core.ai import SummaryResult


def test_unfinished_task_can_be_carried_forward_once(auth_client: TestClient):
    task = auth_client.post(
        "/daily/tasks", json={"text": "Revise introduction", "task_date": "2026-05-31"},
    ).json()

    first = auth_client.post(f"/daily/tasks/{task['id']}/carry-forward")
    second = auth_client.post(f"/daily/tasks/{task['id']}/carry-forward")

    assert first.status_code == 201
    assert first.json()["task_date"] == "2026-06-01"
    assert second.status_code == 201
    assert second.json()["id"] == first.json()["id"]


def test_completed_task_is_not_carried_forward(auth_client: TestClient):
    task = auth_client.post("/daily/tasks", json={"text": "Done"}).json()
    auth_client.patch(f"/daily/tasks/{task['id']}", json={"is_done": True})

    response = auth_client.post(f"/daily/tasks/{task['id']}/carry-forward")

    assert response.status_code == 400


def test_pomodoro_focus_appears_in_stats(auth_client: TestClient):
    task = auth_client.post("/daily/tasks", json={"text": "Read diffusion paper"}).json()
    session = auth_client.post(
        "/pomodoro",
        json={"session_type": "work", "duration_minutes": 25, "linked_task_id": task["id"]},
    ).json()
    auth_client.patch(f"/pomodoro/{session['id']}/complete", json={})

    stats = auth_client.get("/stats?days=7").json()

    assert stats["work_labels"] == [{"label": "Read diffusion paper", "minutes": 25}]


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


def test_paper_note_theme_route_is_exposed(auth_client: TestClient, monkeypatch):
    auth_client.post("/summaries/opt-in", json={"opted_in": True})
    monkeypatch.setattr(summaries.ai, "is_configured", lambda: True)
    monkeypatch.setattr(
        summaries.ai,
        "summarise_paper_notes",
        lambda *_args: SummaryResult("Recurring themes", "test-model", 10, 5),
    )

    response = auth_client.post("/summaries/paper-notes/generate")

    assert response.status_code == 201
    assert response.json()["kind"] == "paper_notes"
    assert response.json()["content"] == "Recurring themes"
