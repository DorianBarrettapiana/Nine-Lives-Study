"""Application entry point."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.health import router as health_router
from app.api.routes.paper_notes import router as paper_notes_router
from app.api.routes.users import router as users_router
from app.core.config import APP_NAME, APP_VERSION
from app.core.database import Base, engine

# Import ORM models before creating tables.
# This ensures that SQLAlchemy knows every table definition.
from app.models.paper_note import PaperNote  # noqa: F401
from app.models.user import User  # noqa: F401

# Create database tables on startup.
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