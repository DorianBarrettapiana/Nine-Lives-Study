"""Application entry point."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.daily_tracker import router as daily_tracker_router
from app.api.routes.feynman_entries import router as feynman_entries_router
from app.api.routes.health import router as health_router
from app.api.routes.paper_notes import router as paper_notes_router
from app.api.routes.pomodoro import router as pomodoro_router
from app.api.routes.stats import router as stats_router
from app.api.routes.users import router as users_router
from app.api.routes.xp import router as xp_router
from app.core.config import APP_NAME, APP_VERSION
from app.core.database import Base, engine

# Import ORM models before creating tables.
# This ensures that SQLAlchemy knows every table definition.
from app.models.daily_tracker import DailyLog, DailyTask  # noqa: F401
from app.models.feynman_entry import FeynmanEntry  # noqa: F401
from app.models.paper_note import PaperNote  # noqa: F401
from app.models.pomodoro_session import PomodoroSession  # noqa: F401
from app.models.user import User  # noqa: F401
from app.models.user_progress import UserProgress  # noqa: F401

# Create missing database tables on startup.
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title=APP_NAME,
    version=APP_VERSION,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(users_router)
app.include_router(paper_notes_router)
app.include_router(feynman_entries_router)
app.include_router(daily_tracker_router)
app.include_router(pomodoro_router)
app.include_router(xp_router)
app.include_router(stats_router)