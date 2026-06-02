"""Tests for milestone backplanning (C: parent_milestone_id + suggest + bulk-create)."""

from datetime import date, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.core.backplanning import (
    pick_template,
    suggest_children,
    weeks_between,
)


def _iso(d: date) -> str:
    return d.isoformat()


def _make_parent(client: TestClient, title: str, weeks_out: int, project_id: int | None = None) -> dict:
    body = {
        "title": title,
        "due_date": _iso(date.today() + timedelta(weeks=weeks_out)),
    }
    if project_id is not None:
        body["project_id"] = project_id
    r = client.post("/milestones", json=body)
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Pure-function rules
# ---------------------------------------------------------------------------


def test_pick_template_matches_keywords():
    assert pick_template("NeurIPS abstract") == "abstract"
    assert pick_template("Thesis defence rehearsal") == "defense"
    assert pick_template("Postdoc application") == "application"
    assert pick_template("Paper draft v2") == "draft"
    assert pick_template("Generic mystery task") == "generic"


def test_pick_template_is_case_insensitive():
    assert pick_template("ABSTRACT") == "abstract"


def test_suggest_returns_empty_when_too_close():
    today = date(2026, 6, 1)
    suggestions, _ = suggest_children(today, today + timedelta(days=7), "Abstract")
    assert suggestions == []


def test_suggest_uses_template_titles_when_far_enough():
    today = date(2026, 6, 1)
    suggestions, template = suggest_children(today, today + timedelta(weeks=6), "NeurIPS abstract")
    assert template == "abstract"
    titles = [s.title for s in suggestions]
    # First-and-last entries from the abstract template must appear.
    assert "Outline + scope" in titles
    assert "Polish + submit" in titles


def test_suggest_dates_are_strictly_before_parent_due():
    today = date(2026, 6, 1)
    parent_due = today + timedelta(weeks=8)
    suggestions, _ = suggest_children(today, parent_due, "thesis draft")
    assert suggestions
    for s in suggestions:
        assert today < s.due_date < parent_due


def test_suggest_dedupes_same_day_dates_on_short_horizons():
    today = date(2026, 6, 1)
    # 14 days → rounding two fractions to the same day is possible.
    suggestions, _ = suggest_children(today, today + timedelta(days=14), "abstract")
    dates = [s.due_date for s in suggestions]
    assert len(dates) == len(set(dates)), "Suggestions must not repeat a date"


def test_weeks_between_rounds_up():
    today = date(2026, 6, 1)
    assert weeks_between(today, today) == 0
    assert weeks_between(today, today + timedelta(days=1)) == 1
    assert weeks_between(today, today + timedelta(days=7)) == 1
    assert weeks_between(today, today + timedelta(days=8)) == 2


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


def test_get_suggestions_returns_template_match(auth_client: TestClient):
    parent = _make_parent(auth_client, "NeurIPS abstract", weeks_out=6)
    r = auth_client.get(f"/milestones/{parent['id']}/suggest-children")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["template"] == "abstract"
    assert body["weeks_remaining"] == 6
    assert 3 <= len(body["suggestions"]) <= 8
    # Every suggestion sits between today and parent due_date.
    parent_due = parent["due_date"]
    for s in body["suggestions"]:
        assert s["due_date"] < parent_due
        assert s["template_hint"] == "abstract"


def test_get_suggestions_returns_empty_when_too_close(auth_client: TestClient):
    parent = _make_parent(auth_client, "Tomorrow's abstract", weeks_out=0)
    r = auth_client.get(f"/milestones/{parent['id']}/suggest-children")
    assert r.status_code == 200
    body = r.json()
    assert body["suggestions"] == []
    # Template still resolves so the UI can render a "too close" hint.
    assert body["template"] == "abstract"


def test_create_milestone_with_parent_inherits_link(auth_client: TestClient):
    parent = _make_parent(auth_client, "Big deliverable", weeks_out=6)
    r = auth_client.post(
        "/milestones",
        json={
            "title": "First check",
            "due_date": _iso(date.today() + timedelta(weeks=2)),
            "parent_milestone_id": parent["id"],
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["parent_milestone_id"] == parent["id"]


def test_create_milestone_rejects_cross_user_parent(
    auth_client: TestClient, second_auth_client: TestClient,
):
    parent = _make_parent(auth_client, "Mine", weeks_out=8)
    r = second_auth_client.post(
        "/milestones",
        json={
            "title": "Theirs",
            "due_date": _iso(date.today() + timedelta(weeks=2)),
            "parent_milestone_id": parent["id"],
        },
    )
    assert r.status_code == 400
    assert "parent" in r.json()["detail"].lower()


def test_bulk_create_children_attaches_under_parent(auth_client: TestClient):
    project_id = auth_client.post("/projects", json={"name": "Thesis"}).json()["id"]
    parent = _make_parent(auth_client, "Defense", weeks_out=10, project_id=project_id)
    children = [
        {
            "title": "Outline",
            "due_date": _iso(date.today() + timedelta(weeks=3)),
            "template_hint": "defense",
        },
        {
            "title": "Mock #1",
            "due_date": _iso(date.today() + timedelta(weeks=6)),
            "template_hint": "defense",
        },
    ]
    r = auth_client.post(
        f"/milestones/{parent['id']}/children",
        json={"children": children},
    )
    assert r.status_code == 201, r.text
    created = r.json()
    assert len(created) == 2
    # All children inherit the parent's project_id.
    assert all(c["project_id"] == project_id for c in created)
    assert all(c["parent_milestone_id"] == parent["id"] for c in created)


def test_bulk_create_rejects_child_at_or_after_parent_date(auth_client: TestClient):
    parent = _make_parent(auth_client, "Defense", weeks_out=4)
    r = auth_client.post(
        f"/milestones/{parent['id']}/children",
        json={"children": [{
            "title": "Late",
            "due_date": parent["due_date"],  # same day → reject
            "template_hint": "",
        }]},
    )
    assert r.status_code == 400
    assert "before" in r.json()["detail"].lower()


def test_deleting_parent_cascades_children(auth_client: TestClient):
    parent = _make_parent(auth_client, "Big", weeks_out=8)
    auth_client.post(
        f"/milestones/{parent['id']}/children",
        json={"children": [{
            "title": "Step",
            "due_date": _iso(date.today() + timedelta(weeks=2)),
            "template_hint": "",
        }]},
    )
    assert auth_client.delete(f"/milestones/{parent['id']}").status_code == 204
    # No milestones left.
    assert auth_client.get("/milestones").json() == []


def test_milestone_cannot_be_own_parent(auth_client: TestClient):
    m = _make_parent(auth_client, "Mine", weeks_out=4)
    r = auth_client.patch(
        f"/milestones/{m['id']}",
        json={"parent_milestone_id": m["id"]},
    )
    assert r.status_code == 400
    assert "own parent" in r.json()["detail"].lower()


def test_milestone_read_includes_parent_field(auth_client: TestClient):
    m = _make_parent(auth_client, "Solo", weeks_out=4)
    assert "parent_milestone_id" in m
    assert m["parent_milestone_id"] is None


# ---------------------------------------------------------------------------
# LLM path — gated on ai_opt_in + ANTHROPIC_API_KEY, falls back to rules
# ---------------------------------------------------------------------------


def _enable_ai(client: TestClient) -> None:
    """Flip the user's AI opt-in via the /summaries/opt-in endpoint."""
    r = client.post("/summaries/opt-in", json={"opted_in": True})
    assert r.status_code == 200, r.text


def test_suggestions_use_llm_when_opted_in_and_configured(auth_client: TestClient):
    _enable_ai(auth_client)
    parent = _make_parent(auth_client, "NeurIPS abstract", weeks_out=6)
    parent_due = date.fromisoformat(parent["due_date"])
    fake_items = [
        {"title": "AI: Outline", "due_date": (date.today() + timedelta(days=10)).isoformat()},
        {"title": "AI: Draft", "due_date": (date.today() + timedelta(days=20)).isoformat()},
        {"title": "AI: Submit", "due_date": (parent_due - timedelta(days=2)).isoformat()},
    ]
    with patch("app.core.ai.is_configured", return_value=True), \
         patch("app.core.ai.suggest_backplan_via_llm", return_value=fake_items) as mock_ai:
        r = auth_client.get(f"/milestones/{parent['id']}/suggest-children")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "llm"
    titles = [s["title"] for s in body["suggestions"]]
    assert titles == ["AI: Outline", "AI: Draft", "AI: Submit"]
    assert all(s["template_hint"] == "llm" for s in body["suggestions"])
    mock_ai.assert_called_once()


def test_suggestions_fall_back_to_rules_when_llm_returns_none(auth_client: TestClient):
    _enable_ai(auth_client)
    parent = _make_parent(auth_client, "NeurIPS abstract", weeks_out=6)
    with patch("app.core.ai.is_configured", return_value=True), \
         patch("app.core.ai.suggest_backplan_via_llm", return_value=None):
        r = auth_client.get(f"/milestones/{parent['id']}/suggest-children")
    body = r.json()
    assert body["source"] == "rules"
    assert body["suggestions"]  # rules engine still produced items


def test_suggestions_skip_llm_when_not_opted_in(auth_client: TestClient):
    parent = _make_parent(auth_client, "NeurIPS abstract", weeks_out=6)
    # is_configured = True but the user hasn't opted in → don't call AI.
    with patch("app.core.ai.is_configured", return_value=True), \
         patch("app.core.ai.suggest_backplan_via_llm") as mock_ai:
        r = auth_client.get(f"/milestones/{parent['id']}/suggest-children")
    assert r.json()["source"] == "rules"
    mock_ai.assert_not_called()


def test_force_rules_overrides_llm(auth_client: TestClient):
    _enable_ai(auth_client)
    parent = _make_parent(auth_client, "Abstract", weeks_out=6)
    with patch("app.core.ai.is_configured", return_value=True), \
         patch("app.core.ai.suggest_backplan_via_llm") as mock_ai:
        r = auth_client.get(f"/milestones/{parent['id']}/suggest-children?force_rules=true")
    assert r.json()["source"] == "rules"
    mock_ai.assert_not_called()


def test_llm_items_outside_window_are_dropped(auth_client: TestClient):
    _enable_ai(auth_client)
    parent = _make_parent(auth_client, "Abstract", weeks_out=4)
    parent_due = date.fromisoformat(parent["due_date"])
    fake_items = [
        # Past
        {"title": "Past", "due_date": (date.today() - timedelta(days=1)).isoformat()},
        # On parent date — must be strictly before
        {"title": "Collide", "due_date": parent_due.isoformat()},
        # After parent
        {"title": "After", "due_date": (parent_due + timedelta(days=3)).isoformat()},
        # Two valid items — minimum for the LLM path to be accepted
        {"title": "OK 1", "due_date": (date.today() + timedelta(days=7)).isoformat()},
        {"title": "OK 2", "due_date": (parent_due - timedelta(days=2)).isoformat()},
    ]
    with patch("app.core.ai.is_configured", return_value=True), \
         patch("app.core.ai.suggest_backplan_via_llm", return_value=fake_items):
        r = auth_client.get(f"/milestones/{parent['id']}/suggest-children")
    body = r.json()
    assert body["source"] == "llm"
    titles = [s["title"] for s in body["suggestions"]]
    assert titles == ["OK 1", "OK 2"]


def test_llm_degenerate_response_falls_back(auth_client: TestClient):
    """If <2 LLM items pass validation, fall back to rules rather than
    showing the user a one-item list with the LLM badge."""
    _enable_ai(auth_client)
    parent = _make_parent(auth_client, "Abstract", weeks_out=6)
    parent_due = date.fromisoformat(parent["due_date"])
    fake_items = [
        # Only one valid item — caller treats as "degenerate, use rules"
        {"title": "Lonely", "due_date": (parent_due - timedelta(days=2)).isoformat()},
        {"title": "Bad date", "due_date": "not-a-date"},
    ]
    with patch("app.core.ai.is_configured", return_value=True), \
         patch("app.core.ai.suggest_backplan_via_llm", return_value=fake_items):
        r = auth_client.get(f"/milestones/{parent['id']}/suggest-children")
    assert r.json()["source"] == "rules"


def test_parse_backplan_json_strips_code_fence():
    from app.core.ai import _parse_backplan_json
    raw = '```json\n{"suggestions": [{"title": "T", "due_date": "2026-06-15"}]}\n```'
    items = _parse_backplan_json(raw)
    assert items == [{"title": "T", "due_date": "2026-06-15"}]


def test_parse_backplan_json_returns_none_on_garbage():
    from app.core.ai import _parse_backplan_json
    assert _parse_backplan_json("not json at all") is None
    assert _parse_backplan_json('{"other_key": []}') is None
    assert _parse_backplan_json("[]") is None  # top-level must be dict
