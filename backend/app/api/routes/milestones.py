"""Milestone routes (scoped to current user).

A Milestone is a date-anchored target (conference deadline, defense,
chapter due). Optionally bound to a Project. Returned by default
sorted by due_date ascending so the sidebar can show "next up" without
re-sorting client-side.

Default listing: active (not archived), regardless of whether due_date
is past — the user often wants to see "expired but not yet acknowledged"
items. `include_archived` and `only_future` flags carve out the other
common views.
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core import ai
from app.core.auth import get_current_user
from app.core.backplanning import suggest_children, weeks_between
from app.core.database import get_db
from app.models.milestone import Milestone
from app.models.project import Project
from app.models.user import User
from app.schemas.milestone import (
    BackplanChildren,
    MilestoneCreate,
    MilestoneRead,
    MilestoneSuggestion,
    MilestoneSuggestionsRead,
    MilestoneUpdate,
)

router = APIRouter(prefix="/milestones", tags=["milestones"])


def _get_owned_milestone(milestone_id: int, current_user: User, db: Session) -> Milestone:
    """Fetch a milestone or 404 if it doesn't belong to the caller."""
    m = db.get(Milestone, milestone_id)
    if m is None or m.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Milestone not found.",
        )
    return m


def _validate_project_id(project_id: int | None, current_user: User, db: Session) -> None:
    """Reject project_id values that don't belong to the current user.

    Same shape as the daily_tasks / paper_notes validator. NULL is
    always allowed (cross-project milestone).
    """
    if project_id is None:
        return
    project = db.get(Project, project_id)
    if project is None or project.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unknown project.",
        )


def _validate_parent_milestone(
    parent_id: int | None, current_user: User, db: Session,
    forbid_self: int | None = None,
) -> None:
    """Reject parent_milestone_id values that don't belong to the caller.

    `forbid_self` blocks a row from becoming its own parent on an
    UPDATE — passes the milestone's own id at the call site. We do NOT
    do a transitive cycle check here: deep chains of parent-of-parent
    aren't a use case the backplanning flow creates (one level only),
    and protecting against them costs a recursive CTE for a problem the
    UI never produces.
    """
    if parent_id is None:
        return
    if forbid_self is not None and parent_id == forbid_self:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A milestone cannot be its own parent.",
        )
    parent = db.get(Milestone, parent_id)
    if parent is None or parent.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unknown parent milestone.",
        )


@router.get("", response_model=list[MilestoneRead])
def list_milestones(
    include_archived: bool = False,
    only_future: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Milestone]:
    """List the caller's milestones, soonest-first.

    Defaults to active (not archived), all dates. `only_future=true`
    drops items whose due_date has passed; the sidebar uses that to
    avoid showing stale items at the top of the countdown list.
    """
    stmt = (
        select(Milestone)
        .where(Milestone.user_id == current_user.id)
        .order_by(Milestone.due_date.asc(), Milestone.id.asc())
    )
    if not include_archived:
        stmt = stmt.where(Milestone.is_archived == False)  # noqa: E712
    if only_future:
        stmt = stmt.where(Milestone.due_date >= date.today())
    return list(db.scalars(stmt).all())


@router.post("", response_model=MilestoneRead, status_code=201)
def create_milestone(
    payload: MilestoneCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Milestone:
    _validate_project_id(payload.project_id, current_user, db)
    _validate_parent_milestone(payload.parent_milestone_id, current_user, db)
    m = Milestone(
        user_id=current_user.id,
        title=payload.title.strip(),
        due_date=payload.due_date,
        project_id=payload.project_id,
        notes=payload.notes or "",
        is_archived=False,
        parent_milestone_id=payload.parent_milestone_id,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


@router.patch("/{milestone_id}", response_model=MilestoneRead)
def update_milestone(
    milestone_id: int,
    payload: MilestoneUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Milestone:
    m = _get_owned_milestone(milestone_id, current_user, db)
    data = payload.model_dump(exclude_unset=True)
    if "project_id" in data:
        _validate_project_id(data["project_id"], current_user, db)
    if "parent_milestone_id" in data:
        _validate_parent_milestone(
            data["parent_milestone_id"], current_user, db, forbid_self=m.id,
        )
    if "title" in data and data["title"] is not None:
        data["title"] = data["title"].strip()
    for field, value in data.items():
        setattr(m, field, value)
    db.commit()
    db.refresh(m)
    return m


@router.delete("/{milestone_id}", status_code=204)
def delete_milestone(
    milestone_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Hard-delete the milestone.

    No dependent rows yet (tasks don't reference milestones), so this
    is a plain DELETE. When/if task → milestone wiring lands, mirror
    the /projects DELETE policy: set FK to NULL before removing.
    """
    m = _get_owned_milestone(milestone_id, current_user, db)
    # SQLite FK enforcement is disabled, so cascade child rows manually
    # (matches the project / paper-note delete patterns elsewhere).
    db.execute(
        delete(Milestone)
        .where(Milestone.user_id == current_user.id)
        .where(Milestone.parent_milestone_id == m.id)
    )
    db.delete(m)
    db.commit()


# ---------------------------------------------------------------------------
# Backplanning: deterministic check-point suggestions
# ---------------------------------------------------------------------------


def _llm_suggestions_if_opted_in(
    parent: Milestone, today: date, current_user: User, db: Session,
) -> list[MilestoneSuggestion] | None:
    """Try the LLM path; return None on any reason to fall back.

    Failure modes (all silent, all fall back):
      * No ANTHROPIC_API_KEY on the server
      * User hasn't opted in
      * Parent too close (rules engine returns empty there anyway; the
        LLM has no useful suggestions either)
      * SDK / network exception
      * Response unparseable or violates the schema
    """
    if not ai.is_configured() or not current_user.ai_opt_in:
        return None
    interval_days = (parent.due_date - today).days
    if interval_days < 14:
        return None

    siblings = db.scalars(
        select(Milestone)
        .where(Milestone.user_id == current_user.id)
        .where(Milestone.id != parent.id)
        .where(Milestone.is_archived == False)  # noqa: E712
        .order_by(Milestone.due_date.asc())
    ).all()
    sibling_payload = [
        {"title": s.title, "due_date": s.due_date.isoformat()}
        for s in siblings
    ]

    raw_items = ai.suggest_backplan_via_llm(
        parent_title=parent.title,
        parent_due_iso=parent.due_date.isoformat(),
        today_iso=today.isoformat(),
        sibling_milestones=sibling_payload,
    )
    if not raw_items:
        return None

    out: list[MilestoneSuggestion] = []
    seen_days: set[date] = set()
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        title = (item.get("title") or "").strip()
        date_str = item.get("due_date")
        if not title or not isinstance(date_str, str):
            continue
        try:
            due = date.fromisoformat(date_str)
        except ValueError:
            continue
        # Enforce the same window the prompt asks for, in case the model
        # ignored it. Self-defense.
        if due <= today or due >= parent.due_date:
            continue
        if due in seen_days:
            continue
        seen_days.add(due)
        out.append(MilestoneSuggestion(
            title=title[:200], due_date=due, template_hint="llm",
        ))
    out.sort(key=lambda s: s.due_date)
    # Cap to the same upper bound as the rules engine so UX stays
    # consistent regardless of which path served the request.
    out = out[:8]
    # A degenerate response (e.g. all items outside the window) is
    # indistinguishable from "no suggestions" — fall back rather than
    # show the user an empty list with the LLM badge.
    if len(out) < 2:
        return None
    return out


@router.get("/{milestone_id}/suggest-children", response_model=MilestoneSuggestionsRead)
def get_suggested_children(
    milestone_id: int,
    force_rules: bool = Query(
        default=False,
        description=(
            "Skip the LLM path even if the user is opted in. Used by the "
            "frontend's 're-roll without AI' button."
        ),
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MilestoneSuggestionsRead:
    """Return intermediate check-point suggestions for a parent milestone.

    Two engines:
      1. **LLM**: if `ANTHROPIC_API_KEY` is set and the user has
         `ai_opt_in=True`, ask Claude to propose 3–6 dated check-points.
         Strictly validated; any failure mode falls through silently.
      2. **Rules**: deterministic templates (`app.core.backplanning`).
         Always available, always fast.

    `force_rules=true` skips the LLM path for users who want to compare.
    Returns the engine used in `source` so the UI can badge it.

    Suggestions are never persisted — the frontend lets the user
    edit / delete / add items, then POSTs `/children` to save.
    """
    parent = _get_owned_milestone(milestone_id, current_user, db)
    today = date.today()

    rule_items, template = suggest_children(today, parent.due_date, parent.title)
    suggestions: list[MilestoneSuggestion]
    source = "rules"
    if not force_rules:
        llm_items = _llm_suggestions_if_opted_in(parent, today, current_user, db)
        if llm_items is not None:
            suggestions = llm_items
            source = "llm"
        else:
            suggestions = [
                MilestoneSuggestion(
                    title=s.title, due_date=s.due_date, template_hint=s.template_hint,
                ) for s in rule_items
            ]
    else:
        suggestions = [
            MilestoneSuggestion(
                title=s.title, due_date=s.due_date, template_hint=s.template_hint,
            ) for s in rule_items
        ]
    return MilestoneSuggestionsRead(
        suggestions=suggestions,
        template=template,
        weeks_remaining=weeks_between(today, parent.due_date),
        source=source,
    )


@router.post(
    "/{milestone_id}/children",
    response_model=list[MilestoneRead],
    status_code=status.HTTP_201_CREATED,
)
def create_child_milestones(
    milestone_id: int,
    payload: BackplanChildren,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Milestone]:
    """Bulk-create check-point milestones under one parent.

    Each child inherits the parent's `project_id` so the dashboard
    aggregates them under the right thread. Due dates must be strictly
    before the parent's; the route 400s on a child whose date is on or
    after the parent. (We keep the validation minimal — the suggestion
    engine never produces a violation, but a hand-edited UI submit
    could.)
    """
    parent = _get_owned_milestone(milestone_id, current_user, db)

    created: list[Milestone] = []
    for child in payload.children:
        if child.due_date >= parent.due_date:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Child due_date {child.due_date.isoformat()} must be before "
                    f"parent due_date {parent.due_date.isoformat()}."
                ),
            )
        title = child.title.strip()
        if not title:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Child title cannot be blank.",
            )
        m = Milestone(
            user_id=current_user.id,
            title=title[:200],
            due_date=child.due_date,
            project_id=parent.project_id,
            notes="",
            is_archived=False,
            parent_milestone_id=parent.id,
        )
        db.add(m)
        created.append(m)
    db.commit()
    for m in created:
        db.refresh(m)
    return created
