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
APP_VERSION = "0.2.0"

# --- Auth -------------------------------------------------------------------

# Invite code required to register a new account. If unset, registration is
# disabled entirely (admin-only mode).
INVITE_CODE = os.environ.get("INVITE_CODE", "")

# Session cookie lifetime, in days.
SESSION_LIFETIME_DAYS = int(os.environ.get("SESSION_LIFETIME_DAYS", "30"))

# Cookie name and security flags.
# - secure=True is required in production (HTTPS only). Set COOKIE_SECURE=0 for
#   local dev over HTTP.
SESSION_COOKIE_NAME = "nl_session"
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") != "0"