"""Tests for /milestones CRUD and project linkage."""

from datetime import date, timedelta

from fastapi.testclient import TestClient


def _make_project(client: TestClient, name: str = "Thread") -> int:
    r = client.post("/projects", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _iso(d: date) -> str:
    return d.isoformat()


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def test_list_milestones_empty(auth_client: TestClient):
    r = auth_client.get("/milestones")
    assert r.status_code == 200
    assert r.json() == []


def test_create_milestone_minimal(auth_client: TestClient):
    r = auth_client.post(
        "/milestones",
        json={"title": "NeurIPS abstract", "due_date": _iso(date.today() + timedelta(days=14))},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["title"] == "NeurIPS abstract"
    assert body["project_id"] is None
    assert body["notes"] == ""
    assert body["is_archived"] is False


def test_create_milestone_with_project(auth_client: TestClient):
    pid = _make_project(auth_client, "DiffusionPolicy")
    r = auth_client.post(
        "/milestones",
        json={
            "title": "Abstract",
            "due_date": _iso(date.today() + timedelta(days=10)),
            "project_id": pid,
            "notes": "Cite Smith 2024",
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["project_id"] == pid
    assert body["notes"] == "Cite Smith 2024"


def test_create_rejects_unknown_project(auth_client: TestClient):
    r = auth_client.post(
        "/milestones",
        json={
            "title": "X",
            "due_date": _iso(date.today() + timedelta(days=5)),
            "project_id": 9999,
        },
    )
    assert r.status_code == 400


def test_create_rejects_empty_title(auth_client: TestClient):
    r = auth_client.post(
        "/milestones",
        json={"title": "", "due_date": _iso(date.today())},
    )
    assert r.status_code == 422


def test_list_orders_by_due_date_ascending(auth_client: TestClient):
    today = date.today()
    titles_in_order = ["soon", "medium", "later"]
    auth_client.post("/milestones", json={"title": "later",  "due_date": _iso(today + timedelta(days=30))})
    auth_client.post("/milestones", json={"title": "soon",   "due_date": _iso(today + timedelta(days=2))})
    auth_client.post("/milestones", json={"title": "medium", "due_date": _iso(today + timedelta(days=10))})
    r = auth_client.get("/milestones")
    assert [m["title"] for m in r.json()] == titles_in_order


def test_list_only_future_drops_past(auth_client: TestClient):
    today = date.today()
    auth_client.post("/milestones", json={"title": "past",   "due_date": _iso(today - timedelta(days=2))})
    auth_client.post("/milestones", json={"title": "today",  "due_date": _iso(today)})
    auth_client.post("/milestones", json={"title": "future", "due_date": _iso(today + timedelta(days=5))})

    all_r = auth_client.get("/milestones")
    assert {m["title"] for m in all_r.json()} == {"past", "today", "future"}

    future_r = auth_client.get("/milestones?only_future=true")
    assert {m["title"] for m in future_r.json()} == {"today", "future"}


def test_archive_hidden_by_default(auth_client: TestClient):
    today = date.today()
    m_id = auth_client.post("/milestones", json={
        "title": "X", "due_date": _iso(today + timedelta(days=5)),
    }).json()["id"]
    auth_client.patch(f"/milestones/{m_id}", json={"is_archived": True})

    assert auth_client.get("/milestones").json() == []
    body = auth_client.get("/milestones?include_archived=true").json()
    assert len(body) == 1 and body[0]["is_archived"] is True


def test_patch_milestone_changes_title_and_date(auth_client: TestClient):
    m_id = auth_client.post("/milestones", json={
        "title": "Old", "due_date": _iso(date.today() + timedelta(days=5)),
    }).json()["id"]
    new_date = date.today() + timedelta(days=20)
    r = auth_client.patch(
        f"/milestones/{m_id}",
        json={"title": "New", "due_date": _iso(new_date)},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "New"
    assert body["due_date"] == _iso(new_date)


def test_patch_can_unassign_project(auth_client: TestClient):
    pid = _make_project(auth_client)
    m_id = auth_client.post("/milestones", json={
        "title": "x", "due_date": _iso(date.today()), "project_id": pid,
    }).json()["id"]
    r = auth_client.patch(f"/milestones/{m_id}", json={"project_id": None})
    assert r.status_code == 200
    assert r.json()["project_id"] is None


def test_delete_milestone(auth_client: TestClient):
    m_id = auth_client.post("/milestones", json={
        "title": "x", "due_date": _iso(date.today()),
    }).json()["id"]
    r = auth_client.delete(f"/milestones/{m_id}")
    assert r.status_code == 204
    assert auth_client.get("/milestones").json() == []


# ---------------------------------------------------------------------------
# Cross-user isolation
# ---------------------------------------------------------------------------


def test_cross_user_isolation(auth_client: TestClient, second_auth_client: TestClient):
    m_id = auth_client.post("/milestones", json={
        "title": "mine", "due_date": _iso(date.today()),
    }).json()["id"]
    # Other user can't see / patch / delete
    assert second_auth_client.get("/milestones").json() == []
    assert second_auth_client.patch(f"/milestones/{m_id}", json={"title": "stolen"}).status_code == 404
    assert second_auth_client.delete(f"/milestones/{m_id}").status_code == 404


def test_cannot_assign_other_users_project(
    auth_client: TestClient, second_auth_client: TestClient,
):
    foreign_pid = _make_project(second_auth_client)
    r = auth_client.post("/milestones", json={
        "title": "x", "due_date": _iso(date.today()), "project_id": foreign_pid,
    })
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Project deletion cascade (sets milestone.project_id to NULL)
# ---------------------------------------------------------------------------


def test_delete_project_unassigns_milestones(auth_client: TestClient):
    pid = _make_project(auth_client, "Going away")
    m_id = auth_client.post("/milestones", json={
        "title": "x", "due_date": _iso(date.today()), "project_id": pid,
    }).json()["id"]

    r = auth_client.delete(f"/projects/{pid}")
    assert r.status_code == 204

    body = auth_client.get("/milestones").json()
    assert len(body) == 1
    assert body[0]["id"] == m_id
    assert body[0]["project_id"] is None
