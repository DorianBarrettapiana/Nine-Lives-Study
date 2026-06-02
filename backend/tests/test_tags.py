"""Tests for the cross-module tag system (A2)."""

from fastapi.testclient import TestClient


def _make_note(client: TestClient, title: str, tag_names: list[str] | None = None, tags_csv: str = "") -> dict:
    payload = {
        "title": title,
        "authors": "",
        "year": None,
        "key_points": "",
        "questions": "",
        "tags": tags_csv,
    }
    if tag_names is not None:
        payload["tag_names"] = tag_names
    r = client.post("/notes", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_note_with_tag_names_populates_tag_list(auth_client: TestClient):
    note = _make_note(auth_client, "Paper A", tag_names=["Diffusion", "Robotics"])
    assert {t["name"] for t in note["tag_list"]} == {"Diffusion", "Robotics"}
    # CSV mirror is updated too so legacy clients keep working.
    assert "Diffusion" in note["tags"] and "Robotics" in note["tags"]


def test_create_note_with_legacy_tags_csv_creates_tags(auth_client: TestClient):
    note = _make_note(auth_client, "Paper B", tags_csv="Lambda, MCMC")
    names = {t["name"] for t in note["tag_list"]}
    assert names == {"Lambda", "MCMC"}


def test_tags_dedupe_by_case(auth_client: TestClient):
    note = _make_note(auth_client, "Paper C", tag_names=["foo", "FOO", "  foo  "])
    assert len(note["tag_list"]) == 1
    assert note["tag_list"][0]["name"] == "foo"


def test_list_tags_includes_counts(auth_client: TestClient):
    _make_note(auth_client, "P1", tag_names=["alpha", "beta"])
    _make_note(auth_client, "P2", tag_names=["alpha"])
    r = auth_client.get("/tags")
    assert r.status_code == 200
    by_name = {t["name"]: t for t in r.json()}
    assert by_name["alpha"]["paper_note_count"] == 2
    assert by_name["alpha"]["use_count"] == 2
    assert by_name["beta"]["paper_note_count"] == 1


def test_update_note_replaces_tags(auth_client: TestClient):
    note = _make_note(auth_client, "P1", tag_names=["alpha", "beta"])
    r = auth_client.patch(f"/notes/{note['id']}", json={"tag_names": ["gamma"]})
    assert r.status_code == 200, r.text
    assert {t["name"] for t in r.json()["tag_list"]} == {"gamma"}

    tags = {t["name"]: t for t in auth_client.get("/tags").json()}
    assert tags["gamma"]["paper_note_count"] == 1
    # alpha/beta still exist but with zero references.
    assert tags["alpha"]["paper_note_count"] == 0


def test_update_with_empty_tag_names_clears_tags(auth_client: TestClient):
    note = _make_note(auth_client, "P1", tag_names=["alpha"])
    r = auth_client.patch(f"/notes/{note['id']}", json={"tag_names": []})
    assert r.status_code == 200
    assert r.json()["tag_list"] == []


def test_update_without_tag_fields_keeps_tags(auth_client: TestClient):
    note = _make_note(auth_client, "P1", tag_names=["alpha"])
    r = auth_client.patch(f"/notes/{note['id']}", json={"title": "P1 renamed"})
    assert r.status_code == 200
    assert {t["name"] for t in r.json()["tag_list"]} == {"alpha"}


def test_delete_note_drops_tag_links(auth_client: TestClient):
    note = _make_note(auth_client, "P1", tag_names=["alpha"])
    assert auth_client.delete(f"/notes/{note['id']}").status_code == 204
    by_name = {t["name"]: t for t in auth_client.get("/tags").json()}
    assert by_name["alpha"]["paper_note_count"] == 0


def test_rename_tag(auth_client: TestClient):
    _make_note(auth_client, "P1", tag_names=["alpha"])
    tag_id = auth_client.get("/tags").json()[0]["id"]
    r = auth_client.patch(f"/tags/{tag_id}", json={"name": "Alpha"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Alpha"
    # Note still shows the tag under its new display name.
    notes = auth_client.get("/notes").json()
    assert notes[0]["tag_list"][0]["name"] == "Alpha"


def test_rename_to_existing_name_conflicts(auth_client: TestClient):
    _make_note(auth_client, "P1", tag_names=["alpha", "beta"])
    tags = {t["name"]: t for t in auth_client.get("/tags").json()}
    r = auth_client.patch(f"/tags/{tags['alpha']['id']}", json={"name": "Beta"})
    assert r.status_code == 409


def test_delete_tag_cascades_links(auth_client: TestClient):
    note = _make_note(auth_client, "P1", tag_names=["alpha"])
    tag_id = auth_client.get("/tags").json()[0]["id"]
    assert auth_client.delete(f"/tags/{tag_id}").status_code == 204
    r = auth_client.get("/notes")
    assert r.json()[0]["tag_list"] == []
    # The note itself survives.
    assert any(n["id"] == note["id"] for n in r.json())


def test_tag_items_drilldown(auth_client: TestClient):
    note = _make_note(auth_client, "P1", tag_names=["alpha"])
    tag_id = auth_client.get("/tags").json()[0]["id"]
    r = auth_client.get(f"/tags/{tag_id}/items")
    assert r.status_code == 200
    body = r.json()
    assert body["tag"]["name"] == "alpha"
    assert len(body["paper_notes"]) == 1
    assert body["paper_notes"][0]["id"] == note["id"]
    assert body["feynman_entries"] == []
    assert body["daily_tasks"] == []


def test_tags_isolated_per_user(auth_client: TestClient, second_auth_client: TestClient):
    _make_note(auth_client, "P1", tag_names=["alpha"])
    assert second_auth_client.get("/tags").json() == []
    # Same-name tag for second user is a separate row.
    r = second_auth_client.post("/notes", json={
        "title": "Theirs", "authors": "", "year": None,
        "key_points": "", "questions": "", "tags": "",
        "tag_names": ["alpha"],
    })
    assert r.status_code == 201
    a_tags = auth_client.get("/tags").json()
    b_tags = second_auth_client.get("/tags").json()
    assert len(a_tags) == 1 and len(b_tags) == 1
    assert a_tags[0]["id"] != b_tags[0]["id"]


def test_feynman_create_with_tag_names(auth_client: TestClient):
    r = auth_client.post("/feynman", json={
        "concept": "Backprop",
        "explanation": "chain rule",
        "gaps": "vanishing",
        "analogy": "",
        "tag_names": ["learning", "ml"],
    })
    assert r.status_code == 201, r.text
    names = {t["name"] for t in r.json()["tag_list"]}
    assert names == {"learning", "ml"}

    # And /tags reflects the Feynman count.
    by_name = {t["name"]: t for t in auth_client.get("/tags").json()}
    assert by_name["ml"]["feynman_entry_count"] == 1
    assert by_name["ml"]["paper_note_count"] == 0


def test_feynman_update_replaces_tags(auth_client: TestClient):
    r = auth_client.post("/feynman", json={
        "concept": "X", "explanation": "", "gaps": "", "analogy": "",
        "tag_names": ["a"],
    })
    entry_id = r.json()["id"]
    r2 = auth_client.patch(f"/feynman/{entry_id}", json={"tag_names": ["b", "c"]})
    assert r2.status_code == 200
    assert {t["name"] for t in r2.json()["tag_list"]} == {"b", "c"}


def test_feynman_delete_clears_links(auth_client: TestClient):
    r = auth_client.post("/feynman", json={
        "concept": "X", "explanation": "", "gaps": "", "analogy": "",
        "tag_names": ["alpha"],
    })
    eid = r.json()["id"]
    assert auth_client.delete(f"/feynman/{eid}").status_code == 204
    by_name = {t["name"]: t for t in auth_client.get("/tags").json()}
    assert by_name["alpha"]["feynman_entry_count"] == 0


def test_daily_task_create_with_tag_names(auth_client: TestClient):
    r = auth_client.post("/daily/tasks", json={
        "text": "Write outline",
        "tag_names": ["thesis", "morning"],
    })
    assert r.status_code == 201, r.text
    assert {t["name"] for t in r.json()["tag_list"]} == {"thesis", "morning"}


def test_daily_task_list_includes_tag_list(auth_client: TestClient):
    auth_client.post("/daily/tasks", json={
        "text": "T1", "tag_names": ["x"],
    })
    state = auth_client.get("/daily").json()
    assert state["tasks"][0]["tag_list"][0]["name"] == "x"


def test_daily_task_update_replaces_tags(auth_client: TestClient):
    rid = auth_client.post("/daily/tasks", json={
        "text": "T", "tag_names": ["a"],
    }).json()["id"]
    r = auth_client.patch(f"/daily/tasks/{rid}", json={"tag_names": ["b"]})
    assert r.status_code == 200
    assert {t["name"] for t in r.json()["tag_list"]} == {"b"}


def test_carry_forward_keeps_tags(auth_client: TestClient):
    rid = auth_client.post("/daily/tasks", json={
        "text": "T", "tag_names": ["alpha"],
    }).json()["id"]
    r = auth_client.post(f"/daily/tasks/{rid}/carry-forward")
    # Carry-forward moves the row (200) rather than copying it (201), so the
    # same task keeps its tag and there is still only one tagged task.
    assert r.status_code == 200
    assert r.json()["id"] == rid
    assert {t["name"] for t in r.json()["tag_list"]} == {"alpha"}
    by_name = {t["name"]: t for t in auth_client.get("/tags").json()}
    assert by_name["alpha"]["daily_task_count"] == 1


def test_tag_items_drilldown_covers_all_types(auth_client: TestClient):
    note = auth_client.post("/notes", json={
        "title": "P", "authors": "", "year": None,
        "key_points": "", "questions": "", "tags": "",
        "tag_names": ["cross"],
    }).json()
    feyn = auth_client.post("/feynman", json={
        "concept": "F", "explanation": "", "gaps": "", "analogy": "",
        "tag_names": ["cross"],
    }).json()
    task = auth_client.post("/daily/tasks", json={
        "text": "T", "tag_names": ["cross"],
    }).json()

    tags = auth_client.get("/tags").json()
    cross_id = next(t["id"] for t in tags if t["name"] == "cross")
    body = auth_client.get(f"/tags/{cross_id}/items").json()
    assert body["tag"]["use_count"] == 3
    assert [n["id"] for n in body["paper_notes"]] == [note["id"]]
    assert [e["id"] for e in body["feynman_entries"]] == [feyn["id"]]
    assert [t["id"] for t in body["daily_tasks"]] == [task["id"]]


def test_tag_names_takes_precedence_over_csv(auth_client: TestClient):
    note = _make_note(
        auth_client, "P", tag_names=["from-list"], tags_csv="from-csv",
    )
    names = {t["name"] for t in note["tag_list"]}
    assert names == {"from-list"}
