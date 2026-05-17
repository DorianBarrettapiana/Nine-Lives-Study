"""Application configuration."""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent
DB_PATH = BASE_DIR / "phdstudylab.db"

_raw_db_url = os.environ.get("DATABASE_URL", f"sqlite:///{DB_PATH}")
# Render provides postgres:// but SQLAlchemy needs postgresql://
if _raw_db_url.startswith("postgres://"):
    _raw_db_url = _raw_db_url.replace("postgres://", "postgresql://", 1)
DATABASE_URL = _raw_db_url

APP_NAME = "Nine Lives Study API"
APP_VERSION = "0.1.0"