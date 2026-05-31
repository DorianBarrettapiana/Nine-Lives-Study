"""Minimal Zotero Web API v3 client.

We only need read access:
  - verify credentials (GET /users/<id>/items?limit=1)
  - list a user's items   (GET /users/<id>/items/top?...)

Uses the stdlib `urllib` so we don't add a runtime HTTP dep just for two
endpoints. Network calls are synchronous — fine because FastAPI runs them
in a threadpool when the route is a plain `def` (which ours are).

Docs: https://www.zotero.org/support/dev/web_api/v3/start
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

ZOTERO_API = "https://api.zotero.org"
_USER_AGENT = "PhDStudyLab/0.2 (+https://github.com/)"

# Item types we treat as "papers worth noting". Other Zotero types
# (attachment, note, annotation) get filtered out — they aren't standalone
# references and would clutter the import picker.
PAPER_ITEM_TYPES: frozenset[str] = frozenset({
    "journalArticle",
    "conferencePaper",
    "preprint",
    "book",
    "bookSection",
    "thesis",
    "report",
    "manuscript",
    "magazineArticle",
    "newspaperArticle",
})


class ZoteroError(Exception):
    """Anything that goes wrong talking to Zotero — wraps the HTTP status."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass
class ZoteroItem:
    """Subset of a Zotero item record we map onto PaperNote fields.

    Field choices mirror what the user actually wants to see in the picker
    (title, authors, year) plus the metadata we'll write into the imported
    PaperNote (item_type, url, doi, abstract, tags).
    """

    key: str
    version: int
    item_type: str
    title: str
    authors: str
    year: int | None
    tags: str
    url: str
    doi: str
    abstract: str


def _request(path: str, api_key: str, params: dict[str, str] | None = None) -> tuple[list[dict] | dict, dict[str, str]]:
    """Issue a GET against the Zotero API. Returns (parsed-json, headers)."""
    qs = "?" + urllib.parse.urlencode(params) if params else ""
    url = f"{ZOTERO_API}{path}{qs}"
    req = urllib.request.Request(
        url,
        headers={
            # v3 is the only supported version since 2014; pinning is just
            # defense against Zotero silently shipping a v4 with breaking
            # changes someday.
            "Zotero-API-Version": "3",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": _USER_AGENT,
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read()
            headers = {k.lower(): v for k, v in resp.headers.items()}
            return json.loads(body or b"[]"), headers
    except urllib.error.HTTPError as exc:
        # 403 = bad/expired key, 404 = wrong user id, 429 = rate-limited.
        # Surface the status so the route can translate to a helpful 4xx.
        detail = exc.read().decode("utf-8", errors="replace")[:200]
        raise ZoteroError(f"Zotero {exc.code}: {detail}", status_code=exc.code) from exc
    except urllib.error.URLError as exc:
        raise ZoteroError(f"Zotero unreachable: {exc.reason}") from exc


def verify_credentials(zotero_user_id: str, api_key: str) -> None:
    """Hit the user's library with limit=1. Raises ZoteroError on failure."""
    _request(f"/users/{zotero_user_id}/items", api_key, {"limit": "1", "format": "json"})


def _parse_item(raw: dict) -> ZoteroItem | None:
    """Map a raw Zotero item JSON object to our slim `ZoteroItem`.

    Returns None for item types we don't represent as paper notes (notes,
    attachments, annotations); the caller filters these out.
    """
    data = raw.get("data") or {}
    item_type = data.get("itemType") or ""
    if item_type not in PAPER_ITEM_TYPES:
        return None

    key = raw.get("key") or data.get("key") or ""
    version = int(raw.get("version") or data.get("version") or 0)
    if not key:
        # Defensive: every Zotero item has a key. If we got nothing back,
        # skip rather than create a PaperNote we can't dedupe later.
        return None

    title = (data.get("title") or "").strip() or "(untitled)"

    # Creators → "First Last, First Last". Zotero distinguishes author from
    # editor / translator / etc.; we keep authors first and fall back to
    # other roles only if no authors exist (otherwise a book with an editor
    # listed as the only creator would import with no name at all).
    creators = data.get("creators") or []
    primary = [c for c in creators if c.get("creatorType") == "author"]
    if not primary:
        primary = creators
    authors = ", ".join(_creator_name(c) for c in primary if _creator_name(c))

    year = _extract_year(data.get("date") or "")

    # Zotero tags are a list of {"tag": str, "type": int}; we serialise as
    # comma-joined to match the PaperNote.tags storage convention.
    tag_objs = data.get("tags") or []
    tags = ", ".join(t.get("tag") for t in tag_objs if t.get("tag"))

    url = (data.get("url") or "").strip()
    doi = (data.get("DOI") or "").strip()
    abstract = (data.get("abstractNote") or "").strip()

    return ZoteroItem(
        key=key,
        version=version,
        item_type=item_type,
        title=title[:300],
        authors=authors[:500],
        year=year,
        tags=tags[:500],
        url=url[:500],
        doi=doi[:200],
        abstract=abstract,
    )


def _creator_name(c: dict) -> str:
    """Zotero has both 'name' (single field) and 'firstName'+'lastName'."""
    if c.get("name"):
        return c["name"].strip()
    parts = [c.get("firstName", "").strip(), c.get("lastName", "").strip()]
    return " ".join(p for p in parts if p)


def _extract_year(date_str: str) -> int | None:
    """Zotero's date field is free-text ('2024-03-12', 'March 2024', '2024',
    'in press', ...). Pull the first 4-digit run that looks like a year."""
    if not date_str:
        return None
    # Iterate; first 1500-3000 sequence wins.
    digits: list[str] = []
    for ch in date_str:
        if ch.isdigit():
            digits.append(ch)
            if len(digits) == 4:
                break
        else:
            digits = []
    if len(digits) != 4:
        return None
    year = int("".join(digits))
    if 1500 <= year <= 3000:
        return year
    return None


def list_top_items(
    zotero_user_id: str,
    api_key: str,
    limit: int = 50,
    start: int = 0,
    query: str | None = None,
) -> tuple[list[ZoteroItem], int]:
    """Return (items, total_results).

    `/users/<id>/items/top` returns top-level items only (no child
    attachments/notes), which is what we want — one Zotero "paper" is one
    top item plus its children. `Total-Results` header carries the
    library-wide count for paging.
    """
    params: dict[str, str] = {
        "limit": str(max(1, min(100, limit))),
        "start": str(max(0, start)),
        "format": "json",
        "include": "data",
        # Sort newest-added first so the import picker shows what the user
        # was most recently working on, which is usually what they want to
        # pull in.
        "sort": "dateAdded",
        "direction": "desc",
    }
    if query:
        params["q"] = query
        params["qmode"] = "titleCreatorYear"

    raw, headers = _request(
        f"/users/{zotero_user_id}/items/top", api_key, params,
    )
    if not isinstance(raw, list):
        raise ZoteroError("Unexpected Zotero response shape.")

    items: list[ZoteroItem] = []
    for entry in raw:
        parsed = _parse_item(entry)
        if parsed is not None:
            items.append(parsed)
    total = int(headers.get("total-results", str(len(items))))
    return items, total


def fetch_items_by_keys(
    zotero_user_id: str, api_key: str, keys: list[str],
) -> list[ZoteroItem]:
    """Fetch a specific set of Zotero items by their keys.

    Zotero supports `itemKey=K1,K2,...` (up to 50 per request) — we batch
    so a 200-key import doesn't blow past the limit.
    """
    if not keys:
        return []
    out: list[ZoteroItem] = []
    BATCH = 50
    for i in range(0, len(keys), BATCH):
        chunk = keys[i:i + BATCH]
        raw, _ = _request(
            f"/users/{zotero_user_id}/items",
            api_key,
            {"itemKey": ",".join(chunk), "format": "json", "include": "data"},
        )
        if not isinstance(raw, list):
            continue
        for entry in raw:
            parsed = _parse_item(entry)
            if parsed is not None:
                out.append(parsed)
    return out
