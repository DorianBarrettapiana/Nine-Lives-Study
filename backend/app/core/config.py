"""Application configuration."""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent
DB_PATH = BASE_DIR / "phdstudylab.db"
DATABASE_URL = f"sqlite:///{DB_PATH}"
APP_NAME = "PhDStudyLab API"
APP_VERSION = "0.1.0"