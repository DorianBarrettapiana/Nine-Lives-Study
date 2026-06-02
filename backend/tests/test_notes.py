"""Tests for /notes routes (CRUD + cross-user isolation)."""

from fastapi.testclient import TestClient


def _make_note(client: TestClient, title: str = "Test paper") -> int:
    r = client.post(
        "/notes",
        json={
            "title": title,
            "authors": "Me",
            "year": 2026,
            "key_points": "kp",
            "questions": "q",
            "tags": "test",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_list_notes_empty(auth_client: TestClient):
    r = auth_client.get("/notes")
    assert r.status_code == 200
    assert r.json() == []


def test_create_and_get_note(auth_client: TestClient):
    note_id = _make_note(auth_client)
    r = auth_client.get("/notes")
    assert r.status_code == 200
    notes = r.json()
    assert len(notes) == 1
    assert notes[0]["id"] == note_id
    assert notes[0]["title"] == "Test paper"


def test_update_note(auth_client: TestClient):
    note_id = _make_note(auth_client)
    r = auth_client.patch(f"/notes/{note_id}", json={"title": "Updated title"})
    assert r.status_code == 200
    assert r.json()["title"] == "Updated title"


def test_delete_note(auth_client: TestClient):
    note_id = _make_note(auth_client)
    r = auth_client.delete(f"/notes/{note_id}")
    assert r.status_code == 204
    assert auth_client.get("/notes").json() == []


def test_update_nonexistent_note_returns_404(auth_client: TestClient):
    r = auth_client.patch("/notes/9999", json={"title": "ghost"})
    assert r.status_code == 404


def test_notes_require_auth(client: TestClient):
    assert client.get("/notes").status_code == 401
    assert client.post("/notes", json={"title": "x", "authors": "", "year": None,
                                        "key_points": "", "questions": "", "tags": ""}).status_code == 401


def test_cross_user_isolation_list(auth_client: TestClient, second_auth_client: TestClient):
    _make_note(auth_client, title="Tester's note")
    # Second user sees nothing
    r = second_auth_client.get("/notes")
    assert r.status_code == 200
    assert r.json() == []


def test_cross_user_cannot_read_or_modify(auth_client: TestClient, second_auth_client: TestClient):
    note_id = _make_note(auth_client, title="Private")
    # Second user attempts to mutate → must 404 (not 403, to avoid leaking existence)
    r_update = second_auth_client.patch(f"/notes/{note_id}", json={"title": "hacked"})
    assert r_update.status_code == 404
    r_delete = second_auth_client.delete(f"/notes/{note_id}")
    assert r_delete.status_code == 404
    # Note still exists for the owner
    notes = auth_client.get("/notes").json()
    assert notes[0]["title"] == "Private"


def test_reading_task_resolves_context_and_captures_insight(auth_client: TestClient):
    note_id = _make_note(auth_client, title="Useful paper")
    task = auth_client.post(f"/notes/{note_id}/add-to-today").json()

    context = auth_client.get(f"/notes/reading-context/{task['id']}")
    assert context.status_code == 200
    assert context.json()["note_id"] == note_id
    assert context.json()["title"] == "Useful paper"

    created = auth_client.post(f"/notes/{note_id}/insights", json={
        "key_idea": "A sharper result",
        "question": "Does it generalize?",
        "next_step": "Check the appendix",
    })
    assert created.status_code == 201, created.text
    assert created.json()["next_step"] == "Check the appendix"

    note = auth_client.get("/notes").json()[0]
    assert note["insight_count"] == 1
    assert note["latest_insight"]["key_idea"] == "A sharper result"


def test_empty_reading_insight_is_rejected(auth_client: TestClient):
    note_id = _make_note(auth_client)
    r = auth_client.post(f"/notes/{note_id}/insights", json={
        "key_idea": " ", "question": "", "next_step": "",
    })
    assert r.status_code == 400


def test_other_user_cannot_capture_insight(auth_client: TestClient, second_auth_client: TestClient):
    note_id = _make_note(auth_client, title="Private reading")
    r = second_auth_client.post(f"/notes/{note_id}/insights", json={"key_idea": "stolen"})
    assert r.status_code == 404
