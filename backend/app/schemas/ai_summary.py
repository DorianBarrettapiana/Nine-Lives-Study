"""Pydantic schemas for AI-generated summaries."""

from typing import Literal

from app.schemas._base import BaseSchema, UtcDateTime

SummaryKind = Literal["weekly", "paper_notes", "feynman_review", "reflections"]


class AiSummaryRead(BaseSchema):
    """A persisted summary (returned by GET and POST routes alike)."""

    id: int
    kind: SummaryKind
    period_key: str
    content: str  # markdown
    model: str
    generated_at: UtcDateTime


class AiConfigRead(BaseSchema):
    """Surfaced via GET /summaries/config so the frontend can hide AI UI
    when the deployment isn't keyed, and remember whether the user has
    opted in to data sharing."""

    enabled: bool
    user_opted_in: bool


class AiOptInPayload(BaseSchema):
    """Body of POST /summaries/opt-in. Single field — explicit consent."""

    opted_in: bool
