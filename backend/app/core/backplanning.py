"""Deterministic milestone backplanning rules.

Given a parent milestone (`due_date`, `title`), return a small list of
suggested intermediate check-points the user can accept / edit / drop.

No LLM is involved — this is intentionally a rule set. The 99% of the
value is in the *prompt-the-user-to-think* moment, not in the
suggestion content. Rules:

* If the parent is < 14 days away, suggest nothing — too close to plan
  in stages, the user should just start.
* Otherwise pick a template based on keywords in the parent's title:
  paper deadlines (abstract / draft / submission) / defense /
  application / generic.
* Each template defines a relative-position list (fractions of the
  interval between today and the due date) and a title per position.
* Cap suggestions at 8 to avoid noise on long horizons.

Returned check-points are ordered earliest-first; their due_dates are
strictly before the parent's due_date so the parent stays the
horizon.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

# (fraction-of-interval, title template). Title gets formatted with
# `{n}` (1-based index) and `{parent}` (parent.title).
_TEMPLATES: dict[str, list[tuple[float, str]]] = {
    "abstract": [
        (0.2, "Outline + scope"),
        (0.4, "Draft v1"),
        (0.6, "Internal review"),
        (0.8, "Revise"),
        (0.95, "Polish + submit"),
    ],
    "draft": [
        (0.15, "Outline + bullet structure"),
        (0.35, "Section drafts"),
        (0.55, "First full pass"),
        (0.75, "Reviewer round"),
        (0.9, "Final revision"),
    ],
    "defense": [
        (0.2, "Slide skeleton"),
        (0.4, "First full slide deck"),
        (0.55, "Mock defense #1"),
        (0.75, "Mock defense #2"),
        (0.9, "Polish slides + script"),
    ],
    "application": [
        (0.25, "Draft personal statement"),
        (0.5, "Request recommendation letters"),
        (0.7, "CV + supporting docs"),
        (0.9, "Submit"),
    ],
    "generic": [
        (0.25, "Set scope + plan"),
        (0.5, "Mid-point check-in"),
        (0.75, "Penultimate review"),
        (0.95, "Final pass"),
    ],
}

# (lowercased keyword fragment, template name). First match wins; order
# matters since "draft" appears in "first draft" too.
_KEYWORD_RULES: list[tuple[str, str]] = [
    ("abstract", "abstract"),
    ("defense", "defense"),
    ("defence", "defense"),  # British spelling
    ("viva", "defense"),
    ("application", "application"),
    ("apply", "application"),
    ("draft", "draft"),
    ("manuscript", "draft"),
    ("paper", "draft"),
    ("thesis", "draft"),
]

_MIN_DAYS = 14
_MAX_SUGGESTIONS = 8


@dataclass(frozen=True)
class Suggestion:
    """One backplanned check-point."""

    title: str
    due_date: date
    template_hint: str


def pick_template(parent_title: str) -> str:
    """Return the template name whose keyword first matches the title.

    Case-insensitive. Falls back to 'generic' for titles that don't
    mention a known kind of deadline.
    """
    lowered = parent_title.casefold()
    for needle, template in _KEYWORD_RULES:
        if needle in lowered:
            return template
    return "generic"


def weeks_between(today: date, due: date) -> int:
    """Whole weeks from today to due, rounded up (negative if overdue)."""
    delta = (due - today).days
    if delta <= 0:
        return 0
    return (delta + 6) // 7


def suggest_children(
    today: date, parent_due: date, parent_title: str,
) -> tuple[list[Suggestion], str]:
    """Return (suggestions, matched_template_name).

    Empty list on parents too close to today or already past. Template
    name is returned even for the empty case so the caller can show a
    "this is too close — just start" hint.
    """
    template = pick_template(parent_title)
    interval = (parent_due - today).days
    if interval < _MIN_DAYS:
        return [], template

    spec = _TEMPLATES[template][:_MAX_SUGGESTIONS]
    out: list[Suggestion] = []
    seen_dates: set[date] = set()
    for fraction, title in spec:
        # Round to the nearest day; cap one day before parent_due so the
        # final check-point doesn't collide with the parent's date.
        offset = int(round(interval * fraction))
        offset = min(offset, interval - 1)
        offset = max(offset, 1)
        d = today + timedelta(days=offset)
        # Dedupe: on short intervals two fractions can round to the same
        # day. Keep the earlier title and skip the dupe rather than
        # showing "Step A / Step A" on the same date.
        if d in seen_dates:
            continue
        seen_dates.add(d)
        out.append(Suggestion(title=title, due_date=d, template_hint=template))
    return out, template
