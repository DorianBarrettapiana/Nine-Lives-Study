"""Tests for the Zotero integration on /notes.

We never hit the real Zotero API — all `app.core.zotero` calls are
monkey-patched in each test so the suite stays offline-safe.
"""

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core import zotero as zotero_module
from app.core.crypto import decrypt_str, encrypt_str
from app.core.zotero import ZoteroError, ZoteroItem, _extract_year, _parse_item


# ---------------------------------------------------------------------------
# Pure-function units
# ---------------------------------------------------------------------------


def test_crypto_round_trip():
    enc = encrypt_str("hunter2")
    assert enc != "hunter2"
    assert decrypt_str(enc) == "hunter2"


def test_crypto_rejects_tampered_ciphertext():
    enc = encrypt_str("secret")
    # Flip a char to invalidate the HMAC.
    tampered = ("A" if enc[0] != "A" else "B") + enc[1:]
    with pytest.raises(ValueError):
        decrypt_str(tampered)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("", None),
        ("2024", 2024),
        ("2024-03-12", 2024),
        ("March 2024", 2024),
        ("in press", None),
        ("99", None),
        ("Fall 1987", 1987),
        ("9999", None),  # out of plausible range
    ],
)
def test_extract_year(raw: str, expected: int | None):
    assert _extract_year(raw) == expected


def test_parse_item_skips_attachments():
    raw = {"key": "X", "version": 1, "data": {"itemType": "attachment", "title": "PDF"}}
    assert _parse_item(raw) is None


def test_parse_item_authors_fallback_to_editor():
    raw = {
        "key": "K", "version": 5,
        "data": {
            "itemType": "book",
            "title": "Edited Volume",
            "creators": [{"creatorType": "editor", "firstName": "A", "lastName": "Ed"}],
        },
    }
    parsed = _parse_item(raw)
    assert parsed is not None
    assert parsed.authors == "A Ed"


def test_parse_item_full_journal_article():
    raw = {
        "key": "ABCD1234", "version": 42,
        "data": {
            "itemType": "journalArticle",
            "title": "Title",
            "creators": [
                {"creatorType": "author", "firstName": "X", "lastName": "Y"},
                {"creatorType": "editor", "name": "Editor One"},
            ],
            "date": "2023-05",
            "tags": [{"tag": "ml"}, {"tag": "vision"}],
            "url": "https://example.com",
            "DOI": "10.1/abc",
            "abstractNote": "Short abstract.",
        },
    }
    parsed = _parse_item(raw)
    assert parsed is not None
    assert parsed.title == "Title"
    assert parsed.authors == "X Y"  # editor filtered out when authors exist
    assert parsed.year == 2023
    assert parsed.tags == "ml, vision"
    assert parsed.doi == "10.1/abc"


# ---------------------------------------------------------------------------
# /notes/zotero/config
# ---------------------------------------------------------------------------


def test_zotero_config_initial_state(auth_client: TestClient):
    r = auth_client.get("/notes/zotero/config")
    assert r.status_code == 200
    assert r.json() == {"connected": False, "zotero_user_id": None}


def test_zotero_save_credentials_happy_path(
    auth_client: TestClient, monkeypatch: pytest.MonkeyPatch,
):
    calls: list[tuple[str, str]] = []

    def fake_verify(uid: str, key: str) -> None:
        calls.append((uid, key))

    monkeypatch.setattr(
        "app.api.routes.paper_notes.verify_credentials", fake_verify,
    )

    r = auth_client.put(
        "/notes/zotero/config",
        json={"zotero_user_id": "7654321", "api_key": "p-secret-key-xyz"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"connected": True, "zotero_user_id": "7654321"}
    assert calls == [("7654321", "p-secret-key-xyz")]

    # Re-reading config now shows connected.
    assert auth_client.get("/notes/zotero/config").json()["connected"] is True


def test_zotero_save_credentials_rejected_by_zotero(
    auth_client: TestClient, monkeypatch: pytest.MonkeyPatch,
):
    def fail_verify(uid: str, key: str) -> None:
        raise ZoteroError("Forbidden", status_code=403)

    monkeypatch.setattr(
        "app.api.routes.paper_notes.verify_credentials", fail_verify,
    )

    r = auth_client.put(
        "/notes/zotero/config",
        json={"zotero_user_id": "1", "api_key": "bad-key-but-long-enough"},
    )
    assert r.status_code == 400
    assert "rejected" in r.json()["detail"].lower()
    # No state stored on failure.
    assert auth_client.get("/notes/zotero/config").json()["connected"] is False


def test_zotero_rejects_non_numeric_user_id(auth_client: TestClient):
    r = auth_client.put(
        "/notes/zotero/config",
        json={"zotero_user_id": "abc", "api_key": "k" * 20},
    )
    assert r.status_code == 422


def test_zotero_disconnect(auth_client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "app.api.routes.paper_notes.verify_credentials", lambda *_: None,
    )
    auth_client.put(
        "/notes/zotero/config",
        json={"zotero_user_id": "1", "api_key": "k" * 20},
    )
    r = auth_client.delete("/notes/zotero/config")
    assert r.status_code == 204
    assert auth_client.get("/notes/zotero/config").json()["connected"] is False


# ---------------------------------------------------------------------------
# /notes/zotero/items and /import
# ---------------------------------------------------------------------------


def _connect(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.api.routes.paper_notes.verify_credentials", lambda *_: None,
    )
    r = client.put(
        "/notes/zotero/config",
        json={"zotero_user_id": "1", "api_key": "k" * 20},
    )
    assert r.status_code == 200


def _make_item(key: str = "AAAA1111", **overrides: Any) -> ZoteroItem:
    base = dict(
        key=key, version=1, item_type="journalArticle",
        title=f"Paper {key}", authors="A. Author", year=2024,
        tags="ml", url="https://example.com/" + key, doi="10.1/" + key,
        abstract="Abstract.",
    )
    base.update(overrides)
    return ZoteroItem(**base)


def test_list_items_requires_connection(auth_client: TestClient):
    r = auth_client.get("/notes/zotero/items")
    assert r.status_code == 400
    assert "not connected" in r.json()["detail"].lower()


def test_list_items_marks_already_imported(
    auth_client: TestClient, monkeypatch: pytest.MonkeyPatch,
):
    _connect(auth_client, monkeypatch)

    # First, import one item.
    items = [_make_item("KEY1"), _make_item("KEY2", title="Another")]

    def fake_list(uid, key, limit, start, query):  # type: ignore[no-untyped-def]
        return items, len(items)

    def fake_fetch(uid, key, keys):  # type: ignore[no-untyped-def]
        return [i for i in items if i.key in keys]

    monkeypatch.setattr("app.api.routes.paper_notes.list_top_items", fake_list)
    monkeypatch.setattr("app.api.routes.paper_notes.fetch_items_by_keys", fake_fetch)

    auth_client.post("/notes/zotero/import", json={"keys": ["KEY1"]})

    r = auth_client.get("/notes/zotero/items")
    assert r.status_code == 200
    by_key = {i["key"]: i for i in r.json()["items"]}
    assert by_key["KEY1"]["already_imported"] is True
    assert by_key["KEY2"]["already_imported"] is False


def test_import_creates_notes_and_is_idempotent(
    auth_client: TestClient, monkeypatch: pytest.MonkeyPatch,
):
    _connect(auth_client, monkeypatch)
    items = [_make_item("KEY1"), _make_item("KEY2", title="Second", year=2025)]
    monkeypatch.setattr(
        "app.api.routes.paper_notes.fetch_items_by_keys",
        lambda uid, key, keys: [i for i in items if i.key in keys],
    )

    r1 = auth_client.post("/notes/zotero/import", json={"keys": ["KEY1", "KEY2"]})
    assert r1.status_code == 201, r1.text
    body = r1.json()
    assert body["imported"] == 2
    assert body["updated"] == 0
    assert {n["zotero_key"] for n in body["notes"]} == {"KEY1", "KEY2"}
    assert all(n["source"] == "zotero" for n in body["notes"])

    # User writes their own reflections on KEY1.
    note_id = next(n["id"] for n in body["notes"] if n["zotero_key"] == "KEY1")
    auth_client.patch(
        f"/notes/{note_id}",
        json={"key_points": "MY THOUGHTS", "questions": "MY QS"},
    )

    # Re-importing the same items shouldn't duplicate and shouldn't wipe
    # user-written fields when on_existing='preserve' (the default).
    r2 = auth_client.post(
        "/notes/zotero/import",
        json={"keys": ["KEY1", "KEY2"], "on_existing": "preserve"},
    )
    assert r2.status_code == 201
    body2 = r2.json()
    assert body2["imported"] == 0
    assert body2["updated"] == 2

    all_notes = auth_client.get("/notes").json()
    assert len(all_notes) == 2
    key1 = next(n for n in all_notes if n["zotero_key"] == "KEY1")
    assert key1["key_points"] == "MY THOUGHTS"
    assert key1["questions"] == "MY QS"


def test_import_overwrite_resets_user_fields(
    auth_client: TestClient, monkeypatch: pytest.MonkeyPatch,
):
    _connect(auth_client, monkeypatch)
    items = [_make_item("KEY1")]
    monkeypatch.setattr(
        "app.api.routes.paper_notes.fetch_items_by_keys",
        lambda uid, key, keys: items,
    )

    r1 = auth_client.post("/notes/zotero/import", json={"keys": ["KEY1"]})
    note_id = r1.json()["notes"][0]["id"]
    auth_client.patch(f"/notes/{note_id}", json={"key_points": "MINE"})

    r2 = auth_client.post(
        "/notes/zotero/import",
        json={"keys": ["KEY1"], "on_existing": "overwrite"},
    )
    assert r2.status_code == 201
    key1 = next(n for n in auth_client.get("/notes").json() if n["zotero_key"] == "KEY1")
    assert key1["key_points"] == ""


def test_import_xp_awarded_once_per_zotero_key(
    auth_client: TestClient, monkeypatch: pytest.MonkeyPatch,
):
    """Re-importing must not stack XP — award_xp_event is keyed on
    (user, event, entity_type, entity_id) which is stable across re-imports."""
    _connect(auth_client, monkeypatch)
    items = [_make_item("KEY1")]
    monkeypatch.setattr(
        "app.api.routes.paper_notes.fetch_items_by_keys",
        lambda uid, key, keys: items,
    )

    before = auth_client.get("/xp").json()
    auth_client.post("/notes/zotero/import", json={"keys": ["KEY1"]})
    after_first = auth_client.get("/xp").json()
    assert after_first["xp"] == before["xp"] + 10

    # Re-import the same key → no extra XP.
    auth_client.post("/notes/zotero/import", json={"keys": ["KEY1"]})
    after_second = auth_client.get("/xp").json()
    assert after_second["xp"] == after_first["xp"]


def test_cross_user_zotero_isolation(
    auth_client: TestClient, second_auth_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
):
    """Two users with the same Zotero key get independent local notes."""
    _connect(auth_client, monkeypatch)
    _connect(second_auth_client, monkeypatch)
    items = [_make_item("SHARED")]
    monkeypatch.setattr(
        "app.api.routes.paper_notes.fetch_items_by_keys",
        lambda uid, key, keys: items,
    )

    auth_client.post("/notes/zotero/import", json={"keys": ["SHARED"]})
    second_auth_client.post("/notes/zotero/import", json={"keys": ["SHARED"]})

    a_notes = auth_client.get("/notes").json()
    b_notes = second_auth_client.get("/notes").json()
    assert len(a_notes) == 1 and len(b_notes) == 1
    assert a_notes[0]["id"] != b_notes[0]["id"]
    assert a_notes[0]["zotero_key"] == b_notes[0]["zotero_key"] == "SHARED"


def test_manual_note_create_with_new_fields(auth_client: TestClient):
    """Adding URL/DOI/abstract through the regular form works."""
    r = auth_client.post(
        "/notes",
        json={
            "title": "Manual paper", "authors": "Me", "year": 2026,
            "key_points": "", "questions": "", "tags": "",
            "url": "https://example.com", "doi": "10.1/x",
            "abstract": "An abstract.",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["url"] == "https://example.com"
    assert body["doi"] == "10.1/x"
    assert body["abstract"] == "An abstract."
    assert body["source"] == "manual"
    assert body["zotero_key"] is None


# Silence unused-import warning when running only this file.
_ = zotero_module
