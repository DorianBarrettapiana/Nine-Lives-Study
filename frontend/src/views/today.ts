/**
 * Today view — the unified planning surface.
 *
 * Replaces the previous Today + Daily-tracker split. One date-aware
 * page that orchestrates the day's tasks, main goal, upcoming
 * deadlines, mood, and reflection. Past dates are read-only.
 *
 * Mood: writes go to /mood (the canonical mood_entries stream). The
 * old daily_logs.mood column is left untouched by this view.
 */

import { createMoodEntry, listMoodEntries, type MoodEntryRead } from "../api/mood";
import {
  carryDailyTask, createDailyTask, deleteDailyTask, getDailyState,
  listUpcomingTasks, saveDailyLog, updateDailyTask,
  type DailyStateRead, type DailyTaskRead,
} from "../api/tracker";
import { escapeHtml, parseApiDate, setMessage } from "../utils";
import { renderEmptyStateWithCat } from "./icons";
import * as PomodoroView from "./pomodoro";
import {
  getActiveProjects, refreshProjects,
} from "./project-state";
import { projectChipHtml } from "./project-picker";
import * as StopwatchView from "./stopwatch";

const MOODS = [
  { emoji: "😩", label: "Exhausted" },
  { emoji: "😔", label: "Low" },
  { emoji: "😐", label: "Neutral" },
  { emoji: "🙂", label: "Good" },
  { emoji: "🔥", label: "On fire" },
] as const;

// --- module state -----------------------------------------------------------

let dateBar: HTMLDivElement;
let mainGoalPickerEl: HTMLDivElement;
let projectFilterEl: HTMLDivElement;
let taskList: HTMLDivElement;
let taskForm: HTMLFormElement;
let taskInput: HTMLInputElement;
let taskDueInput: HTMLInputElement;
let taskProjectPickerEl: HTMLDivElement;
let progressLabel: HTMLElement;
let progressFill: HTMLDivElement;
let projectBreakdownEl: HTMLParagraphElement;
let upcomingCardEl: HTMLElement;
let upcomingListEl: HTMLDivElement;
let yesterdayCardEl: HTMLElement;
let yesterdayBodyEl: HTMLDivElement;
let yesterdayCarryAllBtn: HTMLButtonElement;
let moodRow: HTMLDivElement;
let moodStatusEl: HTMLElement;
let reflectionInput: HTMLTextAreaElement;
let messageEl: HTMLParagraphElement;

let state: DailyStateRead | null = null;
let upcoming: DailyTaskRead[] = [];
let yesterdayState: DailyStateRead | null = null;
let todaysMoods: MoodEntryRead[] = [];
let onDataChangedCb: (() => Promise<void>) | null = null;

// Date being viewed. null = today (live, editable). Any other date = read-only.
let viewedDate: string | null = null;
// Project filter applied to tasks + upcoming. null = "All projects".
// "none" = "(no project)" only. Numeric id = that project only.
let projectFilter: number | "none" | null = null;
// Pre-selected project for the next new task. Sticky across saves (same
// pattern as the projects picker uses in the notes view).
let pendingTaskProjectId: number | null = null;
let pendingTaskDue: string = "";

// --- date helpers ----------------------------------------------------------

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayStr(): string { return localDate(new Date()); }
function shiftDate(s: string, deltaDays: number): string {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return localDate(dt);
}
function isToday(): boolean {
  return viewedDate === null || viewedDate === todayStr();
}
function effectiveDate(): string {
  return viewedDate ?? todayStr();
}
function prettyDate(s: string): string {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
}

// --- rendering -------------------------------------------------------------

function renderDateBar(): void {
  const today = isToday();
  dateBar.innerHTML = `
    <button class="date-nav-btn" type="button" data-shift="-1" title="Previous day">←</button>
    <span class="date-nav-label">${prettyDate(effectiveDate())}${today ? " · Today" : ""}</span>
    <button class="date-nav-btn" type="button" data-shift="+1" title="Next day"
            ${today ? "disabled" : ""}>→</button>
    ${today ? "" : `<button class="link-btn date-nav-today" type="button" data-go-today="1">Jump to today</button>`}
  `;
}

function renderProjectFilter(): void {
  const projects = getActiveProjects();
  const opts = [
    `<option value="">All projects</option>`,
    `<option value="none" ${projectFilter === "none" ? "selected" : ""}>(no project)</option>`,
    ...projects.map((p) => `
      <option value="${p.id}" ${projectFilter === p.id ? "selected" : ""}>
        ${escapeHtml(p.name)}
      </option>
    `),
  ].join("");
  projectFilterEl.innerHTML = `<select class="today-project-filter-select">${opts}</select>`;
}

function passesProjectFilter(task: { project_id: number | null }): boolean {
  if (projectFilter === null) return true;
  if (projectFilter === "none") return task.project_id === null;
  return task.project_id === projectFilter;
}

function taskHtml(task: DailyTaskRead, readOnly: boolean): string {
  const isMainGoal = state?.log?.main_goal_task_id === task.id;
  const goalStar = isMainGoal ? `<span class="task-main-goal-star" title="Main goal">⭐</span>` : "";
  const duePill = task.due_date
    ? `<span class="due-pill ${dueClass(task.due_date)}" title="Due ${task.due_date}">📅 ${shortDue(task.due_date)}</span>`
    : "";
  return `
    <div class="task-item${task.is_done ? " task-done" : ""}${isMainGoal ? " task-main-goal" : ""}"
         data-task-id="${task.id}"
         ${readOnly ? "" : 'draggable="true"'}>
      <button class="task-checkbox ${task.is_done ? "checked" : ""}"
              data-task-action="toggle" data-id="${task.id}"
              aria-label="Toggle task"
              ${readOnly ? "disabled" : ""}>
        ${task.is_done ? "✓" : ""}
      </button>
      ${goalStar}
      <span class="task-text ${task.is_done ? "done" : ""}"
            data-task-action="edit" data-id="${task.id}"
            title="${readOnly ? "" : "Double-click to edit"}">${escapeHtml(task.text)}</span>
      ${projectChipHtml(task.project_id)}
      ${duePill}
      ${readOnly ? "" : `
        ${task.is_done ? "" : `<button class="secondary compact-btn" data-task-action="stopwatch" data-id="${task.id}" title="Start work timer">▶</button>`}
        ${task.is_done ? "" : `<button class="task-carry" data-task-action="carry" data-id="${task.id}" title="Carry to tomorrow">→</button>`}
        <button class="task-delete" data-task-action="delete" data-id="${task.id}" title="Delete">×</button>`}
    </div>`;
}

function dueClass(due: string): string {
  const today = todayStr();
  if (due < today) return "due-overdue";
  if (due === today) return "due-today";
  const inThreeDays = shiftDate(today, 3);
  if (due <= inThreeDays) return "due-soon";
  return "";
}

function shortDue(due: string): string {
  // Render as "Today" / "Tomorrow" / weekday or "MMM D" depending on
  // proximity. Compact, prevents "📅 2026-06-12" everywhere.
  const today = todayStr();
  if (due === today) return "Today";
  if (due === shiftDate(today, 1)) return "Tomorrow";
  if (due < today) return prettyDate(due);
  const [y, m, d] = due.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
}

function renderMainGoal(): void {
  if (!state) return;
  const todayTasks = state.tasks;
  // Build the picker: list today's tasks. Sticky-select if the user
  // already picked one (state.log.main_goal_task_id).
  const selected = state.log?.main_goal_task_id ?? null;
  const readOnly = !isToday();
  const opts = [
    `<option value="">— No main goal —</option>`,
    ...todayTasks.map((t) => `
      <option value="${t.id}" ${selected === t.id ? "selected" : ""}>
        ${escapeHtml(t.text)}
      </option>
    `),
  ].join("");
  // Show the legacy free-text main_goal as a fallback hint when no
  // task is picked but the user has one stored from before the redesign.
  const legacyHint = (selected === null && state.log?.main_goal)
    ? `<p class="hint">Previously: ${escapeHtml(state.log.main_goal)}</p>`
    : "";
  mainGoalPickerEl.innerHTML = `
    <select class="main-goal-select" ${readOnly ? "disabled" : ""}
            ${todayTasks.length === 0 ? "disabled" : ""}>
      ${opts}
    </select>
    ${todayTasks.length === 0
      ? `<p class="hint">Add a task below first, then pick it as today's main goal.</p>`
      : ""}
    ${legacyHint}
  `;
}

function renderProjectBreakdown(): void {
  if (!state) {
    projectBreakdownEl.textContent = "";
    return;
  }
  const counts = new Map<string, number>();
  for (const t of state.tasks) {
    if (t.is_done) continue;
    const key = t.project_id === null
      ? "(no project)"
      : (getActiveProjects().find((p) => p.id === t.project_id)?.name ?? "(unknown)");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) {
    projectBreakdownEl.textContent = "";
    return;
  }
  const parts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${escapeHtml(name)} · ${n}`);
  projectBreakdownEl.innerHTML = `Open tasks by project: ${parts.join(" &nbsp;·&nbsp; ")}`;
}

function renderTaskList(): void {
  if (!state) return;
  const readOnly = !isToday();
  const filtered = state.tasks.filter(passesProjectFilter);
  if (filtered.length === 0) {
    if (state.tasks.length > 0) {
      taskList.innerHTML = `<div class="empty-state">No task matches this filter.</div>`;
    } else {
      taskList.innerHTML = readOnly
        ? `<div class="empty-state">No task recorded for this day.</div>`
        : renderEmptyStateWithCat("No task yet. Add one below ↓");
    }
    return;
  }
  taskList.innerHTML = filtered.map((t) => taskHtml(t, readOnly)).join("");
}

function renderYesterdayCard(): void {
  // Only relevant when looking at today. When navigating to a past date,
  // hide the card entirely — the user is reviewing history, not planning.
  if (!isToday() || yesterdayState === null) {
    yesterdayCardEl.classList.add("hidden");
    return;
  }

  const reflection = yesterdayState.log?.reflection?.trim() ?? "";
  const unfinished = yesterdayState.tasks.filter((t) => !t.is_done);
  const mainGoalId = yesterdayState.log?.main_goal_task_id ?? null;
  const mainGoal = mainGoalId !== null
    ? yesterdayState.tasks.find((t) => t.id === mainGoalId)
    : null;
  const mainGoalMissed = mainGoal !== null && mainGoal !== undefined && !mainGoal.is_done;

  // Nothing to surface → keep the card out of the way so the page stays clean.
  if (reflection === "" && unfinished.length === 0 && !mainGoalMissed) {
    yesterdayCardEl.classList.add("hidden");
    return;
  }

  yesterdayCardEl.classList.remove("hidden");

  const SNIPPET_MAX = 240;
  const reflectionHtml = reflection === ""
    ? ""
    : reflection.length <= SNIPPET_MAX
      ? `<p class="yesterday-reflection">${escapeHtml(reflection)}</p>`
      : `<details class="yesterday-reflection-details">
           <summary>${escapeHtml(reflection.slice(0, SNIPPET_MAX))}…</summary>
           <p class="yesterday-reflection">${escapeHtml(reflection)}</p>
         </details>`;

  const mainGoalHtml = mainGoalMissed
    ? `<p class="yesterday-main-goal-warn">
         ⭐ Yesterday's main goal wasn't finished:
         <strong>${escapeHtml(mainGoal!.text)}</strong>
         <button class="link-btn" data-yesterday-action="carry-main"
                 data-id="${mainGoal!.id}" type="button">Carry to today</button>
       </p>`
    : "";

  const unfinishedHtml = unfinished.length === 0
    ? ""
    : `<div class="yesterday-unfinished">
         <p class="hint">${unfinished.length} unfinished task${unfinished.length === 1 ? "" : "s"}:</p>
         ${unfinished.map((t) => `
           <div class="yesterday-task-row" data-id="${t.id}">
             <span class="yesterday-task-text">${escapeHtml(t.text)}</span>
             ${projectChipHtml(t.project_id)}
             <button class="link-btn" data-yesterday-action="carry" data-id="${t.id}"
                     type="button" title="Bring to today">→ Today</button>
           </div>
         `).join("")}
       </div>`;

  yesterdayBodyEl.innerHTML = mainGoalHtml + reflectionHtml + unfinishedHtml;
  yesterdayCarryAllBtn.classList.toggle("hidden", unfinished.length < 2);
}

function renderUpcoming(): void {
  // Upcoming is global (not date-scoped), so we keep showing it even
  // when the user has navigated to a past day — gives a "still
  // pressing" anchor while reviewing history.
  const filtered = upcoming.filter(passesProjectFilter).slice(0, 5);
  if (filtered.length === 0) {
    upcomingCardEl.classList.add("hidden");
    return;
  }
  upcomingCardEl.classList.remove("hidden");
  upcomingListEl.innerHTML = filtered.map((t) => {
    const today = todayStr();
    const overdue = t.due_date !== null && t.due_date < today;
    const label = overdue
      ? `<span class="upcoming-late">⚠️ ${escapeHtml(humanWhen(t.due_date!))}</span>`
      : `<span class="upcoming-when">📅 ${escapeHtml(humanWhen(t.due_date!))}</span>`;
    return `
      <div class="upcoming-item" data-task-id="${t.id}">
        ${label}
        <span class="upcoming-text">${escapeHtml(t.text)}</span>
        ${projectChipHtml(t.project_id)}
      </div>
    `;
  }).join("");
}

function humanWhen(date: string): string {
  const today = todayStr();
  if (date < today) {
    const [y, m, d] = date.split("-").map(Number);
    const daysLate = Math.round(
      (new Date(today).getTime() - new Date(y, m - 1, d).getTime()) / (24 * 3600 * 1000),
    );
    return daysLate <= 1 ? "yesterday" : `${daysLate}d overdue`;
  }
  return shortDue(date);
}

function renderMood(): void {
  const readOnly = !isToday();
  moodRow.innerHTML = MOODS.map((m) => `
    <button class="mood-button" type="button"
            data-today-mood="${m.emoji}" title="${m.label}"
            ${readOnly ? "disabled" : ""}>
      ${m.emoji}
    </button>
  `).join("");
  if (todaysMoods.length === 0) {
    moodStatusEl.textContent = isToday() ? "No mood logged today." : "";
    return;
  }
  const compact = todaysMoods
    .slice(0, 5)
    .map((m) => {
      const t = parseApiDate(m.created_at).toLocaleTimeString(undefined, {
        hour: "2-digit", minute: "2-digit",
      });
      return `${m.mood} ${t}`;
    })
    .join(" · ");
  moodStatusEl.textContent = `Today: ${compact}`;
}

function renderReflection(): void {
  if (!state) return;
  reflectionInput.value = state.log?.reflection ?? "";
  reflectionInput.disabled = !isToday();
}

function renderTaskForm(): void {
  const readOnly = !isToday();
  taskForm.classList.toggle("hidden", readOnly);
}

export function render(): void {
  if (!state) {
    taskList.innerHTML = renderEmptyStateWithCat("Loading today…");
    return;
  }
  renderDateBar();
  renderProjectFilter();
  renderMainGoal();
  progressLabel.textContent = `${state.done_count} / ${state.total_count}`;
  progressFill.style.width = `${state.completion_percent}%`;
  renderProjectBreakdown();
  renderYesterdayCard();
  renderTaskList();
  renderUpcoming();
  renderMood();
  renderReflection();
  renderTaskForm();
  renderTaskProjectPicker();
}

async function renderTaskProjectPicker(): Promise<void> {
  // Use a local inline picker rather than the shared component because
  // we need it to sit in the same row as the date and Add-task button,
  // not a labeled grid cell.
  if (getActiveProjects().length === 0) {
    try { await refreshProjects(); } catch { /* leave empty */ }
  }
  const projects = getActiveProjects();
  const opts = [
    `<option value="">(no project)</option>`,
    ...projects.map((p) => `<option value="${p.id}" ${pendingTaskProjectId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`),
  ].join("");
  taskProjectPickerEl.innerHTML = `<select class="project-picker-select inline">${opts}</select>`;
  const sel = taskProjectPickerEl.querySelector<HTMLSelectElement>("select")!;
  sel.addEventListener("change", () => {
    pendingTaskProjectId = sel.value === "" ? null : Number(sel.value);
  });
}

// --- data ------------------------------------------------------------------

export async function refresh(): Promise<void> {
  try {
    // Yesterday is only useful while planning today. When the user is
    // browsing a past date, skip the extra fetch.
    const yesterdayFetch: Promise<DailyStateRead | null> = isToday()
      ? getDailyState(shiftDate(todayStr(), -1)).catch(() => null)
      : Promise.resolve(null);
    const [s, up, moods, y] = await Promise.all([
      getDailyState(viewedDate ?? undefined),
      // Upcoming is always for "from today onwards" — date navigation in
      // Today doesn't shift the looming-deadlines window.
      listUpcomingTasks().catch(() => [] as DailyTaskRead[]),
      // Today's mood stream (server scopes to caller). 1-day window is
      // enough for the status strip; full history lives in Mood tab.
      listMoodEntries(1).catch(() => [] as MoodEntryRead[]),
      yesterdayFetch,
    ]);
    state = s;
    upcoming = up;
    yesterdayState = y;
    // Filter today's moods to actual today (the 1-day list can include
    // yesterday's tail-end depending on tz).
    const today = todayStr();
    todaysMoods = moods.filter(
      (m) => parseApiDate(m.created_at).toLocaleDateString("sv-SE") === today,
    ).sort((a, b) => b.created_at.localeCompare(a.created_at));
    render();
  } catch (error) {
    console.error(error);
    setMessage(messageEl, "Could not load today.", "error");
  }
}

// --- mutations -------------------------------------------------------------

async function setMainGoal(taskId: number | null): Promise<void> {
  try {
    // The server uses 0 as the "unassign" sentinel because PUT semantics
    // would otherwise silently clear the field on partial updates.
    const sentinel = taskId === null ? 0 : taskId;
    const log = await saveDailyLog({
      mood: "",  // mood goes through /mood now, not via this endpoint
      reflection: state?.log?.reflection ?? "",
      main_goal_task_id: sentinel,
    });
    if (state) state.log = log;
    setMessage(messageEl, taskId === null ? "Main goal cleared." : "Main goal saved.", "success");
    render();
    await onDataChangedCb?.();
  } catch (error) {
    console.error(error);
    setMessage(messageEl, "Could not save main goal.", "error");
  }
}

async function recordMood(mood: string): Promise<void> {
  try {
    await createMoodEntry({ mood, reflection: "" });
    await refresh();
    await onDataChangedCb?.();
  } catch (error) {
    console.error(error);
    setMessage(messageEl, "Could not record mood.", "error");
  }
}

async function saveReflection(): Promise<void> {
  try {
    const log = await saveDailyLog({
      mood: "",
      reflection: reflectionInput.value.trim(),
    });
    if (state) state.log = log;
    setMessage(messageEl, "Reflection saved.", "success");
    await onDataChangedCb?.();
  } catch (error) {
    console.error(error);
    setMessage(messageEl, "Could not save reflection.", "error");
  }
}

// --- inline task edit ------------------------------------------------------

function startInlineEdit(taskId: number, span: HTMLElement): void {
  if (!isToday() || !state) return;
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const input = document.createElement("input");
  input.type = "text";
  input.value = task.text;
  input.className = "task-edit-input";
  input.maxLength = 500;
  span.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  let committed = false;
  const cancel = (): void => {
    if (committed) return;
    committed = true;
    input.replaceWith(span);
  };
  const commit = async (): Promise<void> => {
    if (committed) return;
    committed = true;
    const newText = input.value.trim();
    if (!newText || newText === task.text) {
      input.replaceWith(span);
      return;
    }
    try {
      await updateDailyTask(task.id, { text: newText });
      await refresh();
    } catch (error) {
      console.error(error);
      setMessage(messageEl, "Could not update task.", "error");
      input.replaceWith(span);
    }
  };
  input.addEventListener("blur", () => void commit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
}

// --- drag-reorder ----------------------------------------------------------

let dragTaskId: number | null = null;

function attachDragHandlers(): void {
  taskList.querySelectorAll<HTMLDivElement>(".task-item[draggable=true]").forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      dragTaskId = Number(row.dataset.taskId);
      row.classList.add("dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(dragTaskId));
      }
    });
    row.addEventListener("dragend", () => {
      dragTaskId = null;
      row.classList.remove("dragging");
      taskList.querySelectorAll(".drop-above").forEach((el) => el.classList.remove("drop-above"));
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      taskList.querySelectorAll(".drop-above").forEach((el) => el.classList.remove("drop-above"));
      row.classList.add("drop-above");
    });
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      row.classList.remove("drop-above");
      const movedId = dragTaskId;
      dragTaskId = null;
      if (!movedId || !state) return;
      const targetId = Number(row.dataset.taskId);
      if (movedId === targetId) return;
      const group = row.parentElement!;
      const items = Array.from(group.querySelectorAll<HTMLDivElement>(".task-item"));
      const targetIdx = items.indexOf(row);
      const prevIdx = items[targetIdx - 1]?.dataset.taskId === String(movedId)
        ? targetIdx - 2 : targetIdx - 1;
      const targetTask = state.tasks.find((t) => t.id === targetId);
      const prevTask = prevIdx >= 0
        ? state.tasks.find((t) => t.id === Number(items[prevIdx].dataset.taskId))
        : null;
      if (!targetTask) return;
      const prevSO = prevTask ? prevTask.sort_order : targetTask.sort_order - 1;
      const newSO = (prevSO + targetTask.sort_order) / 2;
      try {
        await updateDailyTask(movedId, { sort_order: newSO });
        await refresh();
      } catch (error) {
        console.error(error);
        setMessage(messageEl, "Could not reorder.", "error");
      }
    });
  });
}

// --- init ------------------------------------------------------------------

export function init(onDataChanged: () => Promise<void>): void {
  onDataChangedCb = onDataChanged;
  dateBar = document.querySelector<HTMLDivElement>("#today-date-bar")!;
  mainGoalPickerEl = document.querySelector<HTMLDivElement>("#today-main-goal-picker")!;
  projectFilterEl = document.querySelector<HTMLDivElement>("#today-project-filter")!;
  taskList = document.querySelector<HTMLDivElement>("#today-task-list")!;
  taskForm = document.querySelector<HTMLFormElement>("#today-task-form")!;
  taskInput = document.querySelector<HTMLInputElement>("#today-task-input")!;
  taskDueInput = document.querySelector<HTMLInputElement>("#today-task-due")!;
  taskProjectPickerEl = document.querySelector<HTMLDivElement>("#today-task-project-picker")!;
  progressLabel = document.querySelector<HTMLElement>("#today-progress-label")!;
  progressFill = document.querySelector<HTMLDivElement>("#today-progress-fill")!;
  projectBreakdownEl = document.querySelector<HTMLParagraphElement>("#today-project-breakdown")!;
  upcomingCardEl = document.querySelector<HTMLElement>("#today-upcoming-card")!;
  upcomingListEl = document.querySelector<HTMLDivElement>("#today-upcoming-list")!;
  yesterdayCardEl = document.querySelector<HTMLElement>("#today-yesterday-card")!;
  yesterdayBodyEl = document.querySelector<HTMLDivElement>("#today-yesterday-body")!;
  yesterdayCarryAllBtn = document.querySelector<HTMLButtonElement>("#today-yesterday-carry-all")!;
  moodRow = document.querySelector<HTMLDivElement>("#today-mood-row")!;
  moodStatusEl = document.querySelector<HTMLElement>("#today-mood-status")!;
  reflectionInput = document.querySelector<HTMLTextAreaElement>("#today-reflection")!;
  messageEl = document.querySelector<HTMLParagraphElement>("#today-message")!;

  // Date navigation
  dateBar.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.shift) {
      const next = shiftDate(effectiveDate(), Number(target.dataset.shift));
      if (next > todayStr()) return; // forbid future
      viewedDate = next === todayStr() ? null : next;
      await refresh();
    } else if (target.dataset.goToday) {
      viewedDate = null;
      await refresh();
    }
  });

  // Project filter
  projectFilterEl.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const v = target.value;
    projectFilter = v === "" ? null : (v === "none" ? "none" : Number(v));
    // When filtering by a real project, also default the new-task form's
    // project to the same one — saves the user a click.
    if (typeof projectFilter === "number") {
      pendingTaskProjectId = projectFilter;
    }
    render();
  });

  // Main goal picker
  mainGoalPickerEl.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const v = target.value;
    void setMainGoal(v === "" ? null : Number(v));
  });

  // Task form (add task)
  taskForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isToday()) return;
    const text = taskInput.value.trim();
    if (!text) {
      setMessage(messageEl, "Task text is required.", "error");
      return;
    }
    try {
      await createDailyTask({
        text,
        project_id: pendingTaskProjectId,
        due_date: taskDueInput.value || null,
      });
      taskInput.value = "";
      taskDueInput.value = "";
      pendingTaskDue = "";
      setMessage(messageEl, "Task created.", "success");
      await refresh();
      await onDataChangedCb?.();
      window.dispatchEvent(new CustomEvent("task-list:updated"));
    } catch (error) {
      console.error(error);
      setMessage(messageEl, "Could not create task.", "error");
    }
  });

  // Task interactions (toggle / carry / delete / inline-edit-trigger / start)
  taskList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !state) return;
    const action = target.dataset.taskAction;
    const id = Number(target.dataset.id);
    if (!action || !Number.isFinite(id)) return;
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    if (!isToday() && action !== "stopwatch" && action !== "pomodoro") return;
    try {
      if (action === "toggle") {
        await updateDailyTask(id, { is_done: !task.is_done });
        await refresh();
        await onDataChangedCb?.();
        window.dispatchEvent(new CustomEvent("task-list:updated"));
      } else if (action === "carry") {
        await carryDailyTask(id);
        setMessage(messageEl, "Carried to tomorrow.", "success");
        await refresh();
        await onDataChangedCb?.();
      } else if (action === "delete") {
        await deleteDailyTask(id);
        setMessage(messageEl, "Task deleted.", "success");
        await refresh();
        await onDataChangedCb?.();
        window.dispatchEvent(new CustomEvent("task-list:updated"));
      } else if (action === "stopwatch") {
        await StopwatchView.startForFocus(id, task.text);
      } else if (action === "pomodoro") {
        await PomodoroView.startForFocus(id);
      }
    } catch (error) {
      console.error(error);
      setMessage(messageEl, "Could not update task.", "error");
    }
  });

  // Double-click on task text → inline edit
  taskList.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.taskAction !== "edit") return;
    if (!isToday()) return;
    const id = Number(target.dataset.id);
    if (Number.isFinite(id)) startInlineEdit(id, target);
  });

  // Drag-reorder: rebind on every render via MutationObserver.
  new MutationObserver(() => attachDragHandlers())
    .observe(taskList, { childList: true, subtree: true });

  // Yesterday review — per-task carry, main-goal carry, carry-all.
  yesterdayBodyEl.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.yesterdayAction;
    if (!action) return;
    const id = Number(target.dataset.id);
    if (!Number.isFinite(id)) return;
    try {
      await carryDailyTask(id);
      setMessage(messageEl, "Carried to today.", "success");
      await refresh();
      await onDataChangedCb?.();
      window.dispatchEvent(new CustomEvent("task-list:updated"));
    } catch (error) {
      console.error(error);
      setMessage(messageEl, "Could not carry task.", "error");
    }
  });

  yesterdayCarryAllBtn.addEventListener("click", async () => {
    if (yesterdayState === null) return;
    const unfinished = yesterdayState.tasks.filter((t) => !t.is_done);
    if (unfinished.length === 0) return;
    yesterdayCarryAllBtn.disabled = true;
    try {
      // carryDailyTask is server-side idempotent on (date, text), so
      // even if the user clicks twice it won't duplicate.
      await Promise.all(unfinished.map((t) => carryDailyTask(t.id)));
      setMessage(messageEl, `Carried ${unfinished.length} task${unfinished.length === 1 ? "" : "s"} to today.`, "success");
      await refresh();
      await onDataChangedCb?.();
      window.dispatchEvent(new CustomEvent("task-list:updated"));
    } catch (error) {
      console.error(error);
      setMessage(messageEl, "Could not carry tasks.", "error");
    } finally {
      yesterdayCarryAllBtn.disabled = false;
    }
  });

  // Upcoming list — clicking jumps to that task's day.
  upcomingListEl.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest<HTMLElement>(".upcoming-item");
    if (!row) return;
    const tid = Number(row.dataset.taskId);
    const task = upcoming.find((t) => t.id === tid);
    if (!task || !task.planned_date) return;
    viewedDate = task.planned_date === todayStr() ? null : task.planned_date;
    await refresh();
  });

  // Mood — every click writes a new entry. No more daily_logs.mood from here.
  moodRow.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const mood = target.dataset.todayMood;
    if (!mood || !isToday()) return;
    await recordMood(mood);
  });

  // Reflection save
  document.querySelector<HTMLButtonElement>("#today-save-reflection")!
    .addEventListener("click", () => void saveReflection());

  // Re-render when other parts of the app change shared state.
  window.addEventListener("cat:skin-changed", () => render());
  window.addEventListener("projects:updated", () => render());
  window.addEventListener("task-list:updated", () => { void refresh(); });

  // Suppress unused-warning for pendingTaskDue (kept around in case we
  // later persist the user's last due-date selection across saves).
  void pendingTaskDue;
}
