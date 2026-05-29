"""Shared base schema with explicit-UTC datetime serialization.

All API responses pass through Pydantic. By default Pydantic serializes a
naive datetime as `"2026-05-29T10:30:00"` — no timezone suffix — which JS
interprets as the browser's local time, off by the user's tz-offset. Our
DB stores naive UTC (SQLite drops tz info), so we want every datetime to
be emitted with a `Z` suffix so clients can parse it unambiguously.

Every response schema should inherit from `BaseSchema` so this is applied
consistently. The base also bakes in `from_attributes=True` so SQLAlchemy
ORM rows hydrate without each schema repeating the config.
"""

from datetime import datetime, timezone
from typing import Annotated

from pydantic import BaseModel, ConfigDict, PlainSerializer


def _to_utc_iso(value: datetime | None) -> str | None:
    """Serialize a (possibly naive) datetime as ISO 8601 with explicit `Z`."""
    if value is None:
        return None
    # Naive datetimes in this codebase are always UTC (SQLite stores naive,
    # writers always use `datetime.now(timezone.utc)`). Aware datetimes are
    # converted to UTC so the suffix is unconditionally `Z`.
    value = (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )
    return value.isoformat().replace("+00:00", "Z")


# Annotated alias schemas can use directly when they want clean type hints:
#     started_at: UtcDateTime
# Equivalent to `datetime` for input parsing; UTC-Z on JSON serialization.
UtcDateTime = Annotated[
    datetime, PlainSerializer(_to_utc_iso, return_type=str, when_used="json")
]


class BaseSchema(BaseModel):
    """All API response schemas should inherit from this.

    Provides:
      - `from_attributes=True` so SQLAlchemy ORM objects deserialize cleanly.
      - JSON encoder that emits every datetime as explicit-UTC ISO (`...Z`)
        regardless of whether the source value was naive or aware.
    """

    model_config = ConfigDict(
        from_attributes=True,
        # Pydantic v2 keeps this for back-compat; cleaner than annotating every
        # field with `UtcDateTime`. Deprecation timeline >v3 so we have runway.
        json_encoders={datetime: _to_utc_iso},
    )
