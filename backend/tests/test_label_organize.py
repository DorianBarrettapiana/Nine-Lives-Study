"""Tests for /stats/labels/relabel — the "self-organize your time records"
feature: rename or merge focus labels globally across all sessions.

Merge and rename are the same primitive: relabelling A → B. If B is a new
name it renames; if B already exists the two buckets combine. Only the
session `work_label` strings change — the task tree is untouched, so there
is no parent/child ambiguity.
"""

from fastapi.testclient import TestClient


def _completed_pomodoro(client: TestClient, *, label: str, minutes: int = 25) -> dict:
    """Create + complete a work pomodoro carrying a free-text focus label."""
    session = client.post(
        "/pomodoro",
        json={"session_type": "work", "duration_minutes": minutes, "work_label": label},
    ).json()
    client.patch(f"/pomodoro/{session['id']}/complete", json={})
    return session


def _labels(client: TestClient) -> dict[str, int]:
    stats = client.get("/stats?days=7").json()
    return {row["label"]: row["minutes"] for row in stats["work_labels"]}


# ---------------------------------------------------------------------------
# Rename
# ---------------------------------------------------------------------------


def test_rename_label_updates_stats(auth_client: TestClient):
    _completed_pomodoro(auth_client, label="writing", minutes=25)
    assert _labels(auth_client) == {"writing": 25}

    r = auth_client.post(
        "/stats/labels/relabel",
        json={"from_label": "writing", "to_label": "Thesis writing"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["updated_sessions"] == 1

    assert _labels(auth_client) == {"Thesis writing": 25}


def test_rename_materializes_task_label(auth_client: TestClient):
    """A session that inherits its label from a linked task gets the new name
    stamped onto work_label; the task text itself is left untouched."""
    task = auth_client.post("/daily/tasks", json={"text": "Read paper"}).json()
    session = auth_client.post(
        "/pomodoro",
        json={"session_type": "work", "duration_minutes": 25, "linked_task_id": task["id"]},
    ).json()
    auth_client.patch(f"/pomodoro/{session['id']}/complete", json={})
    assert _labels(auth_client) == {"Read paper": 25}

    r = auth_client.post(
        "/stats/labels/relabel",
        json={"from_label": "Read paper", "to_label": "Lit review"},
    )
    assert r.status_code == 200
    assert r.json()["updated_sessions"] == 1
    assert _labels(auth_client) == {"Lit review": 25}

    # Task text is unchanged — we only relabelled the time record.
    tasks = auth_client.get("/daily").json()["tasks"]
    assert next(t for t in tasks if t["id"] == task["id"])["text"] == "Read paper"


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------


def test_merge_combines_minutes(auth_client: TestClient):
    _completed_pomodoro(auth_client, label="writing", minutes=25)
    _completed_pomodoro(auth_client, label="Writing", minutes=25)
    assert _labels(auth_client) == {"writing": 25, "Writing": 25}

    r = auth_client.post(
        "/stats/labels/relabel",
        json={"from_label": "writing", "to_label": "Writing"},
    )
    assert r.status_code == 200
    assert r.json()["updated_sessions"] == 1

    assert _labels(auth_client) == {"Writing": 50}


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------


def test_relabel_same_label_is_noop(auth_client: TestClient):
    _completed_pomodoro(auth_client, label="x", minutes=25)
    r = auth_client.post(
        "/stats/labels/relabel", json={"from_label": "x", "to_label": "x"},
    )
    assert r.status_code == 200
    assert r.json()["updated_sessions"] == 0
    assert _labels(auth_client) == {"x": 25}


def test_relabel_rejects_unlabelled_bucket(auth_client: TestClient):
    r = auth_client.post(
        "/stats/labels/relabel",
        json={"from_label": "Unlabelled work", "to_label": "Something"},
    )
    assert r.status_code == 400


def test_relabel_rejects_blank(auth_client: TestClient):
    r = auth_client.post(
        "/stats/labels/relabel",
        json={"from_label": "writing", "to_label": "   "},
    )
    # Pydantic min_length=1 passes ("   " is 3 chars) but the route strips and
    # rejects an effectively-empty target.
    assert r.status_code == 400


def test_relabel_is_cross_user_isolated(
    auth_client: TestClient, second_auth_client: TestClient,
):
    _completed_pomodoro(auth_client, label="shared", minutes=25)
    _completed_pomodoro(second_auth_client, label="shared", minutes=25)

    r = auth_client.post(
        "/stats/labels/relabel",
        json={"from_label": "shared", "to_label": "mine"},
    )
    assert r.status_code == 200
    assert r.json()["updated_sessions"] == 1

    # Only the caller's sessions were relabelled.
    assert _labels(auth_client) == {"mine": 25}
    assert _labels(second_auth_client) == {"shared": 25}
