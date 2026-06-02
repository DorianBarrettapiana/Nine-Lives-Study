"""Pydantic schemas for note links / backlinks."""

from typing import Literal

from pydantic import BaseModel

from app.schemas._base import BaseSchema

# Keep in sync with the discriminator constants in app/models/note_link.py.
LinkItemType = Literal["paper_note", "feynman_entry"]


class LinkedItemRef(BaseSchema):
    """Compact reference to one end of a link.

    Title/concept is embedded so the frontend can render the chip
    without a follow-up fetch.
    """

    item_type: LinkItemType
    item_id: int
    title: str


class OutgoingLink(BaseSchema):
    """One outgoing link from a source item to a resolved target."""

    target: LinkedItemRef
    label: str


class BacklinkEntry(BaseSchema):
    """One incoming link — who cites this item, and the literal label they used."""

    source: LinkedItemRef
    label: str


class BacklinksRead(BaseModel):
    """Response payload for the backlinks query."""

    backlinks: list[BacklinkEntry]
    outgoing: list[OutgoingLink]
