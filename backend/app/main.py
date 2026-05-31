"""Application entry point."""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.auth import router as auth_router
from app.api.routes.daily_tracker import router as daily_tracker_router
from app.api.routes.feynman_entries import router as feynman_entries_router
from app.api.routes.friends import router as friends_router
from app.api.routes.health import router as health_router
from app.api.routes.mood import router as mood_router
from app.api.routes.paper_notes import router as paper_notes_router
from app.api.routes.pomodoro import router as pomodoro_router
from app.api.routes.projects import router as projects_router
from app.api.routes.stats import router as stats_router
from app.api.routes.stopwatch import router as stopwatch_router
from app.api.routes.summaries import router as summaries_router
from app.api.routes.users import router as users_router
from app.api.routes.xp import router as xp_router
from app.core.config import APP_NAME, APP_VERSION
from app.core.database import Base, engine
from app.core.migrations import run_migrations
from app.models.ai_summary import AiSummary  # noqa: F401

# Import ORM models before creating tables.
# This ensures that SQLAlchemy knows every table definition.
from app.models.daily_tracker import DailyLog, DailyTask  # noqa: F401
from app.models.feed_like import FeedLike  # noqa: F401
from app.models.feynman_entry import FeynmanEntry  # noqa: F401
from app.models.friend_cheer import FriendCheer  # noqa: F401
from app.models.friendship import Friendship  # noqa: F401
from app.models.mood_entry import MoodEntry  # noqa: F401
from app.models.paper_note import PaperNote  # noqa: F401
from app.models.pomodoro_session import PomodoroSession  # noqa: F401
from app.models.project import Project  # noqa: F401
from app.models.session import Session  # noqa: F401
from app.models.stopwatch_session import StopwatchSession  # noqa: F401
from app.models.user import User  # noqa: F401
from app.models.user_progress import UserProgress  # noqa: F401
from app.models.xp_event import XpEvent  # noqa: F401

# Create missing database tables on startup, then apply ad-hoc migrations
# (e.g. ALTER TABLE for newly-added columns on pre-existing tables).
Base.metadata.create_all(bind=engine)
run_migrations(engine)

app = FastAPI(
    title=APP_NAME,
    version=APP_VERSION,
)

_cors_origins_env = os.environ.get("CORS_ORIGINS", "")
_cors_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()]
if not _cors_origins:
    # Dev fallback. In production this would silently let an unrelated origin
    # talk to a real cookie-auth backend if CORS_ORIGINS got misconfigured /
    # dropped, so refuse to boot unless we're explicitly in a dev env.
    _env = os.environ.get("APP_ENV", "dev").lower()
    if _env not in {"dev", "development", "test", "testing"}:
        raise RuntimeError(
            "CORS_ORIGINS must be set in non-dev environments "
            "(refusing to fall back to http://localhost:5173)."
        )
    _cors_origins = ["http://localhost:5173"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    # Cookie auth needs credentials and explicit origins (no wildcard).
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(auth_router)
app.include_router(users_router)
app.include_router(projects_router)
app.include_router(paper_notes_router)
app.include_router(feynman_entries_router)
app.include_router(daily_tracker_router)
app.include_router(pomodoro_router)
app.include_router(stopwatch_router)
app.include_router(xp_router)
app.include_router(mood_router)
app.include_router(stats_router)
app.include_router(friends_router)
app.include_router(summaries_router)
