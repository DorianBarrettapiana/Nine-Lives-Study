/**
 * Milestones sidebar view.
 *
 * Single compact card in the sidebar that doubles as countdown display
 * and inline CRUD surface. PhD deadlines (conf abstracts, defense,
 * chapter due) live at the week/month scale and don't belong inside
 * Today's daily task list — surfacing them here keeps them in the user's
 * peripheral vision without crowding the planning surface.
 *
 * Layout:
 *   - Top: section header + "+ Add" toggle
 *   - Add form: title + date + (optional) project, hidden by default
 *   - Active list (truncated to the next 3 by default)
 *   - "Show N more" toggle when there are more upcoming
 *   - Collapsible details for past + archived
 *
 * Editing: click a row to flip into inline-edit (title + date). The
 * pattern mirrors the Projects view's double-click-to-rename UX but
 * uses a single click because rows aren't doing any other action.
 */

import {
  createMilestone, deleteMilestone, listMilestones, updateMilestone,
  type MilestoneRead,
} from "../api/milestones";
import { escapeHtml, setMessage } from "../utils";
import {
  getActiveProjects, refreshProjects,
} from "./project-state";

let cardEl: HTMLElement;
let toggleAddBtn: HTMLButtonElement;
let addForm: HTMLFormElement;
let addTitleInput: HTMLInputElement;
let addDateInput: HTMLInputElement;
let addProjectPickerEl: HTMLDivElement;
let addCancelBtn: HTMLButtonElement;
let addMsgEl: HTMLParagraphElement;
let listEl: HTMLDivElement;
let showMoreBtn: HTMLButtonElement;
let pastDetailsEl: HTMLElement;
let pastListEl: HTMLDivElement;

// All non-archived milestones (the API filters archived by default).
// We keep them client-side and partition into "upcoming" / "past" for
// rendering. `pastIncludingArchived` is fetched separately on demand
// when the user opens the "past / archived" disclosure.
let active: MilestoneRead[] = [];
let pastIncludingArchived: MilestoneRead[] = [];
let pastLoaded = false;

// Add form has its own pending project selection (sticky across saves so
// the user can hammer out several milestones for the same project).
let pendingAddProjectId: number | null = null;

// Show-all flag: when true, render every upcoming milestone instead of
// truncating to the first MAX_VISIBLE.
let showAll = false;
const MAX_VISIBLE = 3;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysUntil(due: string): number {
  // Plain calendar-day diff in the caller's local timezone. Both sides
  // are anchored at 00:00 local so a midnight-ish "today" doesn't read
  // as half a day off.
  const today = todayStr();
  const [ty, tm, td] = today.split("-").map(Number);
  const [dy, dm, dd] = due.split("-").map(Number);
  const a = new Date(ty, tm - 1, td).getTime();
  const b = new Date(dy, dm - 1, dd).getTime();
  return Math.round((b - a) / (24 * 3600 * 1000));
}

function urgencyClass(days: number): string {
  if (days < 0) return "milestone-overdue";
  if (days <= 3) return "milestone-soon";
  if (days <= 7) return "milestone-near";
  return "";
}

function countdownLabel(days: number): string {
  if (days < 0) return `${-days}d ago`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${days}d`;
}

function projectChip(projectId: number | null): string {
  if (projectId === null) return "";
  const project = getActiveProjects().find((p) => p.id === projectId);
  if (project === undefined) return "";
  const color = project.color
    ? ` style="background:${escapeHtml(project.color)};"`
    : "";
  return `<span class="milestone-project-chip" title="${escapeHtml(project.name)}"${color}></span>`;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function milestoneRowHtml(m: MilestoneRead): string {
  const days = daysUntil(m.due_date);
  return `
    <div class="milestone-row ${urgencyClass(days)}" data-id="${m.id}">
      ${projectChip(m.project_id)}
      <span class="milestone-title" data-milestone-action="edit" data-id="${m.id}"
            title="Click to edit">${escapeHtml(m.title)}</span>
      <span class="milestone-countdown" title="${escapeHtml(m.due_date)}">${countdownLabel(days)}</span>
      <button class="milestone-delete" data-milestone-action="delete" data-id="${m.id}"
              title="Delete">×</button>
    </div>
  `;
}

function renderList(): void {
  // Active list = non-archived. Past = due in the past OR archived.
  // The /milestones endpoint defaults to non-archived; we filter past
  // out of the visible "upcoming" view client-side so they sit in the
  // collapsible disclosure instead.
  const today = todayStr();
  const upcoming = active.filter((m) => m.due_date >= today);
  const overdue  = active.filter((m) => m.due_date < today);

  // Surface overdue items above the next-up future ones — they're more
  // pressing than a milestone 30 days out. Within each band, the API
  // already returned them due-date-ascending.
  const visibleOrder = [...overdue, ...upcoming];

  if (visibleOrder.length === 0) {
    listEl.innerHTML = `<p class="hint milestone-empty">No upcoming milestone. Click + Add to track a deadline.</p>`;
    showMoreBtn.classList.add("hidden");
  } else {
    const shown = showAll ? visibleOrder : visibleOrder.slice(0, MAX_VISIBLE);
    listEl.innerHTML = shown.map(milestoneRowHtml).join("");
    const hidden = visibleOrder.length - shown.length;
    if (hidden > 0) {
      showMoreBtn.textContent = `Show ${hidden} more`;
      showMoreBtn.classList.remove("hidden");
    } else if (showAll && visibleOrder.length > MAX_VISIBLE) {
      showMoreBtn.textContent = "Show less";
      showMoreBtn.classList.remove("hidden");
    } else {
      showMoreBtn.classList.add("hidden");
    }
  }

  // Past / archived disclosure. Only rendered when the user opens it
  // (lazy fetch in onPastToggle).
  if (pastLoaded) {
    if (pastIncludingArchived.length === 0) {
      pastListEl.innerHTML = `<p class="hint">Nothing to show.</p>`;
    } else {
      pastListEl.innerHTML = pastIncludingArchived.map(milestoneRowHtml).join("");
    }
  }

  // Hide the disclosure entirely if there is *nothing* it could ever
  // contain (no past-due actives + we know no archived exist yet). We
  // can't know about archived without fetching, so keep the disclosure
  // visible whenever the user might still have archived items to recover.
  pastDetailsEl.classList.remove("hidden");
}

function renderAddProjectPicker(): void {
  const projects = getActiveProjects();
  const opts = [
    `<option value="">(no project)</option>`,
    ...projects.map((p) => `
      <option value="${p.id}" ${pendingAddProjectId === p.id ? "selected" : ""}>
        ${escapeHtml(p.name)}
      </option>
    `),
  ].join("");
  addProjectPickerEl.innerHTML = `<label>Project (optional)<select>${opts}</select></label>`;
  const sel = addProjectPickerEl.querySelector<HTMLSelectElement>("select");
  if (sel !== null) {
    sel.addEventListener("change", () => {
      pendingAddProjectId = sel.value === "" ? null : Number(sel.value);
    });
  }
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

export async function refresh(): Promise<void> {
  try {
    const [items] = await Promise.all([
      listMilestones(),
      // Project chips in milestone rows depend on the active-projects
      // cache; warming it here means the chip color is right on first
      // paint after this view loads.
      getActiveProjects().length === 0 ? refreshProjects() : Promise.resolve(),
    ]);
    active = items;
    renderList();
  } catch (e) {
    console.error("milestones refresh failed", e);
    listEl.innerHTML = `<p class="message error">Could not load milestones.</p>`;
  }
}

async function refreshPast(): Promise<void> {
  try {
    const all = await listMilestones({ includeArchived: true });
    const today = todayStr();
    pastIncludingArchived = all.filter((m) => m.is_archived || m.due_date < today);
    pastLoaded = true;
    renderList();
  } catch (e) {
    console.error("milestones past fetch failed", e);
    pastListEl.innerHTML = `<p class="message error">Could not load past milestones.</p>`;
  }
}

// ---------------------------------------------------------------------------
// inline edit
// ---------------------------------------------------------------------------

function startInlineEdit(row: HTMLElement, m: MilestoneRead): void {
  // Inline-edit replaces the whole row content with a compact form. We
  // re-render the full list on commit / cancel rather than splicing the
  // row back, because urgency class and ordering may change.
  row.innerHTML = `
    <form class="milestone-edit-form">
      <input type="text" maxlength="200" value="${escapeHtml(m.title)}" />
      <input type="date" value="${escapeHtml(m.due_date)}" />
      <div class="button-row">
        <button type="submit">Save</button>
        <button type="button" class="link-btn" data-edit-action="cancel">Cancel</button>
        <button type="button" class="link-btn" data-edit-action="archive">
          ${m.is_archived ? "Unarchive" : "Archive"}
        </button>
      </div>
    </form>
  `;
  const form = row.querySelector<HTMLFormElement>("form")!;
  const inputs = form.querySelectorAll<HTMLInputElement>("input");
  inputs[0].focus();
  inputs[0].select();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const newTitle = inputs[0].value.trim();
    const newDate = inputs[1].value;
    if (!newTitle || !newDate) return;
    try {
      const updated = await updateMilestone(m.id, { title: newTitle, due_date: newDate });
      const idx = active.findIndex((x) => x.id === m.id);
      if (idx >= 0) active[idx] = updated;
      // Re-sort by due_date asc (matches server side ordering).
      active.sort((a, b) => a.due_date.localeCompare(b.due_date));
      renderList();
    } catch (err) {
      console.error(err);
      renderList(); // revert UI; user can retry
    }
  });

  form.addEventListener("click", async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const editAction = t.dataset.editAction;
    if (editAction === "cancel") {
      renderList();
    } else if (editAction === "archive") {
      try {
        await updateMilestone(m.id, { is_archived: !m.is_archived });
        // Archiving removes it from the active list; refresh to re-sync.
        await refresh();
        if (pastLoaded) await refreshPast();
      } catch (err) {
        console.error(err);
        renderList();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export function init(): void {
  cardEl = document.querySelector<HTMLElement>("#milestones-card")!;
  toggleAddBtn = document.querySelector<HTMLButtonElement>("#milestones-toggle-add")!;
  addForm = document.querySelector<HTMLFormElement>("#milestones-add-form")!;
  addTitleInput = document.querySelector<HTMLInputElement>("#milestones-add-title")!;
  addDateInput = document.querySelector<HTMLInputElement>("#milestones-add-date")!;
  addProjectPickerEl = document.querySelector<HTMLDivElement>("#milestones-add-project-picker")!;
  addCancelBtn = document.querySelector<HTMLButtonElement>("#milestones-add-cancel")!;
  addMsgEl = document.querySelector<HTMLParagraphElement>("#milestones-add-message")!;
  listEl = document.querySelector<HTMLDivElement>("#milestones-list")!;
  showMoreBtn = document.querySelector<HTMLButtonElement>("#milestones-show-more")!;
  pastDetailsEl = document.querySelector<HTMLElement>("#milestones-past-details")!;
  pastListEl = document.querySelector<HTMLDivElement>("#milestones-past-list")!;

  void cardEl; // reserved for future hover/affordance hooks

  // Suppress unused-warning so the build stays clean while we keep the
  // import + state around for the inline form's project rendering.
  void addMsgEl;

  // --- "+ Add" toggle ---
  toggleAddBtn.addEventListener("click", () => {
    const showing = !addForm.classList.toggle("hidden");
    if (showing) {
      renderAddProjectPicker();
      addTitleInput.focus();
    }
  });
  addCancelBtn.addEventListener("click", () => {
    addForm.classList.add("hidden");
    addTitleInput.value = "";
    addDateInput.value = "";
    setMessage(addMsgEl, "", "neutral");
  });

  // --- Add submit ---
  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = addTitleInput.value.trim();
    const due = addDateInput.value;
    if (!title || !due) {
      setMessage(addMsgEl, "Title and date are required.", "error");
      return;
    }
    try {
      const created = await createMilestone({
        title, due_date: due, project_id: pendingAddProjectId,
      });
      active.push(created);
      active.sort((a, b) => a.due_date.localeCompare(b.due_date));
      addTitleInput.value = "";
      addDateInput.value = "";
      // pendingAddProjectId stays sticky
      setMessage(addMsgEl, "Milestone added.", "success");
      addForm.classList.add("hidden");
      renderList();
    } catch (err) {
      console.error(err);
      setMessage(addMsgEl, "Could not save milestone.", "error");
    }
  });

  // --- Show more / less ---
  showMoreBtn.addEventListener("click", () => {
    showAll = !showAll;
    renderList();
  });

  // --- Active list interactions (edit, delete) ---
  listEl.addEventListener("click", async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const action = t.dataset.milestoneAction;
    if (!action) return;
    const id = Number(t.dataset.id);
    const m = active.find((x) => x.id === id);
    if (!m) return;
    const row = t.closest<HTMLElement>(".milestone-row");
    if (row === null) return;

    if (action === "edit") {
      startInlineEdit(row, m);
    } else if (action === "delete") {
      if (!window.confirm(`Delete milestone "${m.title}"?`)) return;
      try {
        await deleteMilestone(m.id);
        active = active.filter((x) => x.id !== id);
        renderList();
      } catch (err) {
        console.error(err);
      }
    }
  });

  // --- Past list interactions (same wiring, but operates on
  //     pastIncludingArchived; clicking edit on an archived row will
  //     unarchive via the inline "Archive/Unarchive" toggle button).
  pastListEl.addEventListener("click", async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const action = t.dataset.milestoneAction;
    if (!action) return;
    const id = Number(t.dataset.id);
    const m = pastIncludingArchived.find((x) => x.id === id);
    if (!m) return;
    const row = t.closest<HTMLElement>(".milestone-row");
    if (row === null) return;

    if (action === "edit") {
      // Edit form needs the row to live in the past list; we still
      // route the same flow but use `m` from the past collection.
      startInlineEdit(row, m);
    } else if (action === "delete") {
      if (!window.confirm(`Delete milestone "${m.title}"?`)) return;
      try {
        await deleteMilestone(m.id);
        pastIncludingArchived = pastIncludingArchived.filter((x) => x.id !== id);
        renderList();
      } catch (err) {
        console.error(err);
      }
    }
  });

  // --- Lazy-load past details the first time it opens ---
  pastDetailsEl.addEventListener("toggle", () => {
    if ((pastDetailsEl as HTMLDetailsElement).open && !pastLoaded) {
      void refreshPast();
    }
  });

  // --- React to projects changes (rename / archive / delete) ---
  window.addEventListener("projects:updated", () => renderList());
}
