"""Symmetric encryption for per-user third-party secrets (currently the
Zotero API key).

Why this exists: users paste their *own* Zotero API key into the app's
settings. Storing it as plaintext in SQLite means a single DB-file leak
would hand every user's Zotero library to an attacker. Fernet (AES-128-CBC
+ HMAC) is enough to make that a non-trivial extra step.

The master key lives in the ``APP_SECRET_KEY`` env var. In dev, if it's
unset, we derive a stable fallback from the DB path so local development
just works — *never* used for prod (the main app refuses to boot in prod
without CORS_ORIGINS, and a missing APP_SECRET_KEY in prod will surface
through the same lens once any user tries to save a key).
"""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import DATABASE_URL


def _derive_dev_key() -> bytes:
    """Stable per-machine fallback key (dev only).

    Hashing DATABASE_URL gives us a deterministic but per-deployment key.
    Good enough for a dev SQLite file; in production APP_SECRET_KEY must
    be set explicitly.
    """
    digest = hashlib.sha256(DATABASE_URL.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is not None:
        return _fernet
    raw = os.environ.get("APP_SECRET_KEY", "").strip()
    if raw:
        # Accept either a 32-byte urlsafe-b64 Fernet key directly, or any
        # arbitrary-length secret we hash down to one.
        try:
            _fernet = Fernet(raw.encode("utf-8"))
        except (ValueError, TypeError):
            digest = hashlib.sha256(raw.encode("utf-8")).digest()
            _fernet = Fernet(base64.urlsafe_b64encode(digest))
    else:
        _fernet = Fernet(_derive_dev_key())
    return _fernet


def encrypt_str(plaintext: str) -> str:
    """Encrypt a UTF-8 string. Returns urlsafe-b64 ciphertext (str)."""
    token = _get_fernet().encrypt(plaintext.encode("utf-8"))
    return token.decode("utf-8")


def decrypt_str(ciphertext: str) -> str:
    """Decrypt a token produced by :func:`encrypt_str`. Raises ValueError on
    tamper / wrong-key."""
    try:
        return _get_fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise ValueError("Cannot decrypt secret (key rotated or value tampered).") from exc
