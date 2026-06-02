"""Tests for AI-recap date gating: Friday-only / month-end / 90-day cooldown."""

from datetime import datetime, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.api.routes import summaries as summaries_route
from app.core import ai
from app.models.ai_summary import AiSummary


def _enable_ai(client: TestClient) -> None:
    r = client.post("/summaries/opt-in", json={"opted_in": True})
    assert r.status_code == 200, r.text


def _fake_summary() -> ai.SummaryResult:
    return ai.SummaryResult(
        content="A short recap.", model="test-model",
        tokens_in=10, tokens_out=20,
    )


def _at(year: int, month: int, day: int, hour: int = 12) -> datetime:
    return datetime(year, month, day, hour, tzinfo=timezone.utc)


def _freeze_now(monkeypatch, when: datetime) -> None:
    """Make every helper in app.api.routes.summaries see `when` as 'now'."""
    monkeypatch.setattr(summaries_route, "_utc_now", lambda: when)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def test_days_in_month_handles_leap_year():
    from app.api.routes.summaries import _days_in_month
    assert _days_in_month(2026, 1) == 31
    assert _days_in_month(2026, 2) == 28      # not leap
    assert _days_in_month(2024, 2) == 29      # leap
    assert _days_in_month(2026, 4) == 30
    assert _days_in_month(2026, 12) == 31


def test_monthly_window_covers_last_three_days(monkeypatch):
    # April has 30 days → window is 28, 29, 30 (all in).
    _freeze_now(monkeypatch, _at(2026, 4, 28))
    assert summaries_route._is_in_monthly_window(0) is True
    _freeze_now(monkeypatch, _at(2026, 4, 27))
    assert summaries_route._is_in_monthly_window(0) is False
    _freeze_now(monkeypatch, _at(2026, 4, 30))
    assert summaries_route._is_in_monthly_window(0) is True


def test_monthly_window_works_in_february_non_leap(monkeypatch):
    # 2026 Feb has 28 days → window is 26, 27, 28.
    _freeze_now(monkeypatch, _at(2026, 2, 26))
    assert summaries_route._is_in_monthly_window(0) is True
    _freeze_now(monkeypatch, _at(2026, 2, 25))
    assert summaries_route._is_in_monthly_window(0) is False


# ---------------------------------------------------------------------------
# Weekly: Friday only
# ---------------------------------------------------------------------------


def test_weekly_availability_off_on_monday(monkeypatch, auth_client: TestClient):
    _freeze_now(monkeypatch, _at(2026, 6, 1))  # Monday 2026-06-01
    _enable_ai(auth_client)
    r = auth_client.get("/summaries/weekly/availability")
    body = r.json()
    assert body["can_generate"] is False
    assert body["reason"] == "off_day"
    assert body["next_slot"] == "Friday"


def test_weekly_availability_open_on_friday(monkeypatch, auth_client: TestClient):
    _freeze_now(monkeypatch, _at(2026, 6, 5))  # Friday 2026-06-05
    _enable_ai(auth_client)
    r = auth_client.get("/summaries/weekly/availability")
    body = r.json()
    assert body["can_generate"] is True
    assert body["slot"] == "Friday"


def test_weekly_generate_rejected_on_tuesday(monkeypatch, auth_client: TestClient):
    _freeze_now(monkeypatch, _at(2026, 6, 2))  # Tuesday
    _enable_ai(auth_client)
    with patch("app.core.ai.is_configured", return_value=True):
        r = auth_client.post("/summaries/weekly/generate")
    assert r.status_code == 400
    assert "Friday" in r.json()["detail"]


def test_weekly_generate_ok_on_friday_then_blocked_same_week(
    monkeypatch, auth_client: TestClient,
):
    _freeze_now(monkeypatch, _at(2026, 6, 5))  # Friday
    _enable_ai(auth_client)
    with patch("app.core.ai.is_configured", return_value=True), \
         patch("app.core.ai.summarise_weekly_retrospective", return_value=_fake_summary()):
        r1 = auth_client.post("/summaries/weekly/generate")
        assert r1.status_code == 201, r1.text
        # Same-week second click is rejected by the unique constraint.
        r2 = auth_client.post("/summaries/weekly/generate")
        assert r2.status_code == 429


# ---------------------------------------------------------------------------
# Monthly: only in last 3 days of month
# ---------------------------------------------------------------------------


def test_monthly_availability_off_window(monkeypatch, auth_client: TestClient):
    _freeze_now(monkeypatch, _at(2026, 6, 15))  # mid-month
    _enable_ai(auth_client)
    r = auth_client.get("/summaries/monthly/availability")
    body = r.json()
    assert body["can_generate"] is False
    assert body["reason"] == "off_window"
    assert body["next_available"] == "2026-06-28"
    assert body["window_days"] == 3


def test_monthly_availability_open_in_window(monkeypatch, auth_client: TestClient):
    _freeze_now(monkeypatch, _at(2026, 6, 29))  # 2nd-to-last day of June
    _enable_ai(auth_client)
    r = auth_client.get("/summaries/monthly/availability")
    body = r.json()
    assert body["can_generate"] is True
    assert body["period_key"] == "2026-06"


def test_monthly_generate_rejected_outside_window(
    monkeypatch, auth_client: TestClient,
):
    _freeze_now(monkeypatch, _at(2026, 6, 15))
    _enable_ai(auth_client)
    with patch("app.core.ai.is_configured", return_value=True):
        r = auth_client.post("/summaries/progress/monthly/generate")
    assert r.status_code == 400
    assert "last 3 days" in r.json()["detail"]


def test_monthly_generate_ok_then_blocked_same_month(
    monkeypatch, auth_client: TestClient,
):
    _freeze_now(monkeypatch, _at(2026, 6, 30))
    _enable_ai(auth_client)
    with patch("app.core.ai.is_configured", return_value=True), \
         patch("app.core.ai.summarise_progress_recap", return_value=_fake_summary()):
        r1 = auth_client.post("/summaries/progress/monthly/generate")
        assert r1.status_code == 201, r1.text
        r2 = auth_client.post("/summaries/progress/monthly/generate")
        # Already-generated for the same month_key returns 429.
        assert r2.status_code == 429


# ---------------------------------------------------------------------------
# Stage: 90-day cooldown
# ---------------------------------------------------------------------------


def test_stage_availability_open_with_no_history(auth_client: TestClient):
    _enable_ai(auth_client)
    r = auth_client.get("/summaries/stage/availability")
    body = r.json()
    assert body["can_generate"] is True
    assert body["cooldown_days"] == 90


def test_stage_generate_ok_then_blocked_for_90_days(
    monkeypatch, auth_client: TestClient, db_engine,
):
    _enable_ai(auth_client)
    with patch("app.core.ai.is_configured", return_value=True), \
         patch("app.core.ai.summarise_progress_recap", return_value=_fake_summary()):
        r1 = auth_client.post("/summaries/progress/stage/generate?days=90")
        assert r1.status_code == 201, r1.text

        # Second call right after → blocked.
        r2 = auth_client.post("/summaries/progress/stage/generate?days=90")
        assert r2.status_code == 429
        assert "every 90 days" in r2.json()["detail"]

        # Availability endpoint agrees.
        avail = auth_client.get("/summaries/stage/availability").json()
        assert avail["can_generate"] is False
        assert avail["reason"] == "cooldown"


def test_stage_unblocks_after_90_days(
    monkeypatch, auth_client: TestClient, db_engine,
):
    """First call writes a row; jump 91 days forward + backdate the row's
    generated_at so the cooldown is over. The second call should succeed
    with a distinct period_key (because today's date has moved)."""
    from sqlalchemy.orm import sessionmaker
    _enable_ai(auth_client)
    with patch("app.core.ai.is_configured", return_value=True), \
         patch("app.core.ai.summarise_progress_recap", return_value=_fake_summary()):
        _freeze_now(monkeypatch, _at(2026, 3, 4))
        r = auth_client.post("/summaries/progress/stage/generate?days=90")
        assert r.status_code == 201

        # Backdate the stored generated_at so the cooldown check passes.
        TS = sessionmaker(bind=db_engine, autoflush=False, autocommit=False)
        with TS() as s:
            row = s.query(AiSummary).filter_by(kind="stage").one()
            row.generated_at = _at(2026, 3, 4).replace(tzinfo=None)
            s.commit()

        # Jump forward 91 days so today's date — and thus the period_key —
        # is different from the first call's.
        _freeze_now(monkeypatch, _at(2026, 6, 4))
        r2 = auth_client.post("/summaries/progress/stage/generate?days=90")
        assert r2.status_code == 201, r2.text


def test_stage_cooldown_helper_returns_none_when_no_row(db_engine):
    """The helper should return None when no stage row exists for the user."""
    from sqlalchemy.orm import sessionmaker
    TS = sessionmaker(bind=db_engine, autoflush=False, autocommit=False)
    with TS() as s:
        assert summaries_route._stage_cooldown_until(user_id=999, db=s) is None


def test_monthly_next_open_iso_inside_window(monkeypatch):
    _freeze_now(monkeypatch, _at(2026, 6, 30))
    nxt = summaries_route._monthly_next_open_iso(0)
    # Already in the window → next opens next month (July: 31 days, threshold 28, +1 = 29)
    assert nxt == "2026-07-29"


def test_monthly_next_open_iso_outside_window(monkeypatch):
    _freeze_now(monkeypatch, _at(2026, 6, 10))
    assert summaries_route._monthly_next_open_iso(0) == "2026-06-28"
