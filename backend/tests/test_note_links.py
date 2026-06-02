"""Tests for the `[[Title]]` bidirectional link system (B2)."""

from fastapi.testclient import TestClient


def _note(client: TestClient, title: str, key_points: str = "", questions: str = "") -> dict:
    r = client.post("/notes", json={
        "title": title,
        "authors": "",
        "year": None,
        "key_points": key_points,
        "questions": questions,
        "tags": "",
    })
    assert r.status_code == 201, r.text
    return r.json()


def _feynman(client: TestClient, concept: str, **fields) -> dict:
    payload = {"concept": concept, "explanation": "", "gaps": "", "analogy": ""}
    payload.update(fields)
    r = client.post("/feynman", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


def _links(client: TestClient, item_type: str, item_id: int) -> dict:
    r = client.get(f"/links?item_type={item_type}&item_id={item_id}")
    assert r.status_code == 200, r.text
    return r.json()


def test_note_links_resolve_to_existing_paper(auth_client: TestClient):
    target = _note(auth_client, "Diffusion Models")
    src = _note(auth_client, "My survey", key_points="See [[Diffusion Models]] for the canonical view.")

    body = _links(auth_client, "paper_note", target["id"])
    assert len(body["backlinks"]) == 1
    assert body["backlinks"][0]["source"]["item_id"] == src["id"]
    assert body["backlinks"][0]["source"]["title"] == "My survey"
    assert body["backlinks"][0]["label"] == "Diffusion Models"


def test_note_outgoing_link_is_visible(auth_client: TestClient):
    target = _note(auth_client, "Diffusion Models")
    src = _note(auth_client, "My survey", key_points="See [[Diffusion Models]].")
    body = _links(auth_client, "paper_note", src["id"])
    assert len(body["outgoing"]) == 1
    assert body["outgoing"][0]["target"]["item_id"] == target["id"]


def test_note_to_feynman_link(auth_client: TestClient):
    fy = _feynman(auth_client, "Backprop")
    src = _note(auth_client, "Lec 4 notes", key_points="Built on [[Backprop]].")
    body = _links(auth_client, "feynman_entry", fy["id"])
    assert len(body["backlinks"]) == 1
    assert body["backlinks"][0]["source"]["item_type"] == "paper_note"
    assert body["backlinks"][0]["source"]["item_id"] == src["id"]


def test_feynman_to_note_link(auth_client: TestClient):
    note = _note(auth_client, "DDPM paper")
    fy = _feynman(auth_client, "Forward process", explanation="Definition pulled from [[DDPM paper]].")
    body = _links(auth_client, "paper_note", note["id"])
    assert any(b["source"]["item_id"] == fy["id"] for b in body["backlinks"])


def test_link_resolution_is_case_insensitive(auth_client: TestClient):
    target = _note(auth_client, "Diffusion Models")
    _note(auth_client, "My survey", key_points="See [[diffusion models]].")
    body = _links(auth_client, "paper_note", target["id"])
    assert len(body["backlinks"]) == 1


def test_duplicate_brackets_dedupe(auth_client: TestClient):
    target = _note(auth_client, "X")
    _note(auth_client, "S", key_points="[[X]] [[x]] [[ X ]]")
    body = _links(auth_client, "paper_note", target["id"])
    assert len(body["backlinks"]) == 1


def test_self_link_is_dropped(auth_client: TestClient):
    note = _note(auth_client, "Self", key_points="Recurse into [[Self]] again.")
    body = _links(auth_client, "paper_note", note["id"])
    assert body["backlinks"] == []
    assert body["outgoing"] == []


def test_unresolved_token_is_silently_dropped(auth_client: TestClient):
    src = _note(auth_client, "Lone", key_points="Citing [[Ghost paper that doesn't exist]].")
    body = _links(auth_client, "paper_note", src["id"])
    assert body["outgoing"] == []


def test_link_appears_after_target_created_later(auth_client: TestClient):
    src = _note(auth_client, "Forward-ref", key_points="Need to read [[Future paper]] soon.")
    # No target yet — no link.
    assert _links(auth_client, "paper_note", src["id"])["outgoing"] == []
    # Type the target now…
    target = _note(auth_client, "Future paper")
    # …and re-save the source so its body is re-parsed against the new target.
    r = auth_client.patch(f"/notes/{src['id']}", json={"key_points": "Need to read [[Future paper]] soon."})
    assert r.status_code == 200
    body = _links(auth_client, "paper_note", target["id"])
    assert len(body["backlinks"]) == 1


def test_editing_body_to_remove_token_clears_link(auth_client: TestClient):
    target = _note(auth_client, "T")
    src = _note(auth_client, "S", key_points="cite [[T]]")
    assert len(_links(auth_client, "paper_note", target["id"])["backlinks"]) == 1
    auth_client.patch(f"/notes/{src['id']}", json={"key_points": "nope"})
    assert _links(auth_client, "paper_note", target["id"])["backlinks"] == []


def test_deleting_source_clears_link(auth_client: TestClient):
    target = _note(auth_client, "T")
    src = _note(auth_client, "S", key_points="cite [[T]]")
    assert auth_client.delete(f"/notes/{src['id']}").status_code == 204
    assert _links(auth_client, "paper_note", target["id"])["backlinks"] == []


def test_deleting_target_clears_outgoing(auth_client: TestClient):
    target = _note(auth_client, "T")
    src = _note(auth_client, "S", key_points="cite [[T]]")
    assert auth_client.delete(f"/notes/{target['id']}").status_code == 204
    # Source still exists, but outgoing panel is now empty.
    assert _links(auth_client, "paper_note", src["id"])["outgoing"] == []


def test_links_are_per_user(auth_client: TestClient, second_auth_client: TestClient):
    _note(auth_client, "Shared", key_points="")
    # Second user typing the same link name resolves to their own note,
    # not the first user's.
    own = second_auth_client.post("/notes", json={
        "title": "Theirs",
        "authors": "", "year": None,
        "key_points": "[[Shared]]",
        "questions": "", "tags": "",
    })
    assert own.status_code == 201
    # First user sees no incoming link on their "Shared" note.
    a_shared_id = auth_client.get("/notes").json()[0]["id"]
    body = _links(auth_client, "paper_note", a_shared_id)
    assert body["backlinks"] == []


def test_links_endpoint_404_on_cross_user_item(
    auth_client: TestClient, second_auth_client: TestClient,
):
    own = _note(auth_client, "Mine")
    r = second_auth_client.get(f"/links?item_type=paper_note&item_id={own['id']}")
    assert r.status_code == 404
