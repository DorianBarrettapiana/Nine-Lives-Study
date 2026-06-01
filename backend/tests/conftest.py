"""Shared pytest fixtures.

Each test gets a fresh, isolated, in-memory SQLite DB. We override
`get_db` and set INVITE_CODE/COOKIE_SECURE env vars before importing the app.
"""

import os
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

# Ensure the backend root is on sys.path so `import app...` works whether
# pytest is launched from repo root, backend/, or anywhere else.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

# Env vars must be set BEFORE importing the app (which reads them at module load).
# We force-overwrite (not setdefault) because a Machine-level INVITE_CODE may be
# set on the dev machine and would silently shadow our test code otherwise.
os.environ["INVITE_CODE"] = "test-invite-code"
os.environ["COOKIE_SECURE"] = "0"

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.core.database import Base, get_db  # noqa: E402
from app.core.migrations import run_migrations  # noqa: E402
from app.main import app  # noqa: E402

# Import models so create_all picks them up
from app.models.daily_tracker import DailyLog, DailyTask  # noqa: E402, F401
from app.models.feynman_entry import FeynmanEntry  # noqa: E402, F401
from app.models.mood_entry import MoodEntry  # noqa: E402, F401
from app.models.paper_note import PaperNote  # noqa: E402, F401
from app.models.pomodoro_session import PomodoroSession  # noqa: E402, F401
from app.models.project import Project  # noqa: E402, F401
from app.models.session import Session as SessionModel  # noqa: E402, F401
from app.models.stopwatch_session import StopwatchSession  # noqa: E402, F401
from app.models.tag import Tag, TagLink  # noqa: E402, F401
from app.models.user import User  # noqa: E402, F401
from app.models.user_progress import UserProgress  # noqa: E402, F401
from app.models.xp_event import XpEvent  # noqa: E402, F401


@pytest.fixture
def db_engine():
    """Per-test in-memory SQLite engine. StaticPool keeps the same conn alive
    so the data created in one request survives across other requests in the
    same test (each request opens a new SQLAlchemy session on the same conn)."""
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    run_migrations(engine)
    try:
        yield engine
    finally:
        engine.dispose()


@pytest.fixture
def client(db_engine) -> Iterator[TestClient]:
    """FastAPI TestClient with the DB dependency overridden to use db_engine."""
    TestSession = sessionmaker(bind=db_engine, autoflush=False, autocommit=False)

    def _get_test_db():
        session = TestSession()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def auth_client(client: TestClient) -> TestClient:
    """A TestClient already logged in as a freshly-registered user.

    The cookie jar on TestClient persists across requests, so subsequent
    calls are authenticated automatically.
    """
    response = client.post(
        "/auth/register",
        json={
            "username": "tester",
            "password": "Hunter2!Hunter2!",
            "invite_code": "test-invite-code",
            "language": "en",
            "theme": "dark",
        },
    )
    assert response.status_code == 201, response.text
    return client


@pytest.fixture
def second_auth_client(client: TestClient) -> TestClient:
    """A second authenticated client (different user) sharing the same DB.

    Useful for cross-user isolation tests. Uses a separate TestClient instance
    so its cookie jar doesn't collide with `auth_client`.
    """
    from fastapi.testclient import TestClient as TC
    c = TC(app)
    response = c.post(
        "/auth/register",
        json={
            "username": "intruder",
            "password": "Hunter2!Hunter2!",
            "invite_code": "test-invite-code",
        },
    )
    assert response.status_code == 201, response.text
    return c
