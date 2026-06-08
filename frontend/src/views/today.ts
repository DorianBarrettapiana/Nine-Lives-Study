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

import { createMoodEntry, deleteMoodEntry, listMoodEntries, type MoodEntryRead } from "../api/mood";
import {
  carryDailyTask, carryTaskToToday, createDailyTask, deleteDailyTask,
  getDailyState, listUpcomingTasks, saveDailyLog,
  updateDailyTask,
  type DailyStateRead, type DailyTaskRead,
} from "../api/tracker";
import { addMilestoneToToday, listMilestones, type MilestoneRead } from "../api/milestones";
import { escapeHtml, flashMessage, parseApiDate, setMessage } from "../utils";
import { renderEmptyStateWithCat } from "./icons";
import * as PomodoroView from "./pomodoro";
import {
  getActiveProjects, refreshProjects,
} from "./project-state";
import { projectChipHtml } from "./project-picker";
import * as StopwatchView from "./stopwatch";
import * as TimerMode from "./timerMode";

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
let milestonesCardEl: HTMLElement;
let milestonesListEl: HTMLDivElement;
let taskEstimateEl: HTMLDivElement;
let yesterdayCardEl: HTMLElement;
let yesterdayBodyEl: HTMLDivElement;
let yesterdayCarryAllBtn: HTMLButtonElement;
let moodRow: HTMLDivElement;
let moodReflectionInput: HTMLTextAreaElement;
let moodSaveBtn: HTMLButtonElement;
let moodMessageEl: HTMLParagraphElement;
let moodListEl: HTMLDivElement;
let reflectionInput: HTMLTextAreaElement;
let messageEl: HTMLParagraphElement;
let selectedMood = "";

let state: DailyStateRead | null = null;
let upcoming: DailyTaskRead[] = [];
let milestones: MilestoneRead[] = [];
let yesterdayState: DailyStateRead | null = null;
let todaysMoods: MoodEntryRead[] = [];
let onDataChangedCb: (() => Promise<void>) | null = null;
// Root tasks whose subtask panel the user has manually expanded this
// session. Subtasks start collapsed (we don't auto-expand on load); this
// set keeps a group open across re-renders once the user opens it.
const expandedTaskIds = new Set<number>();

// Date being viewed. null = today (live, editable). Any other date = read-only.
let viewedDate: string | null = null;
// Project filter applied to tasks + upcoming. null = "All projects".
// "none" = "(no project)" only. Numeric id = that project only.
let projectFilter: number | "none" | null = null;
// Pre-selected project for the next new task. Sticky across saves (same
// pattern as the projects picker uses in the notes view).
let pendingTaskProjectId: number | null = null;
let pendingTaskDue: string = "";
let addingChildForTaskId: number | null = null;
// Which root task currently has its "break it down" question panel open.
let breakingDownTaskId: number | null = null;
// Estimate (minutes) pre-selected for the next new task via the chip row.
// null = no estimate. Sticky across the session like the project picker.
let pendingTaskEstimate: number | null = null;
// Which task currently has its inline estimate editor open (root OR child).
// Lets any task — including subtasks — be sized or re-sized after creation.
let editingEstimateTaskId: number | null = null;

// Offered time-estimate buckets (minutes). Tuned to pomodoro-ish chunks so a
// task that doesn't fit in one sitting is visibly "too big".
const ESTIMATE_CHOICES = [5, 15, 25, 45] as const;
// At/above this estimate a leaf task earns a gentle "break it down" nudge.
const BIG_TASK_MINUTES = 45;

// The three guiding questions behind the "break it down" panel. Answering any
// of them turns the answer into a concrete subtask — the value is the prompt
// to think concretely, not the AI-ness of it.
const BREAKDOWN_QUESTIONS = [
  "Smallest step that proves progress?",
  "What info are you missing to continue?",
  "What's a version you could finish in 25 min?",
] as const;

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

// Inline estimate control shown on every task row. Three states:
//  - editing → chip row (5/15/25/45 + clear) that PATCHes the task,
//  - has estimate → clickable ~Xm pill that opens the editor,
//  - no estimate → a tiny "+ size" affordance (hidden when read-only/done).
// Works the same for root tasks and subtasks, so any task can be sized.
function estimateControlHtml(task: DailyTaskRead, readOnly: boolean): string {
  if (!readOnly && editingEstimateTaskId === task.id) {
    const chips = ESTIMATE_CHOICES.map((mins) => `
      <button type="button" class="estimate-chip ${task.estimate_minutes === mins ? "active" : ""}"
              data-task-action="set-estimate" data-id="${task.id}" data-estimate="${mins}">${mins}m</button>`).join("");
    const clear = task.estimate_minutes !== null
      ? `<button type="button" class="estimate-chip estimate-clear" data-task-action="set-estimate" data-id="${task.id}" data-estimate="clear" title="Clear estimate">✕</button>`
      : "";
    return `<span class="estimate-edit">${chips}${clear}</span>`;
  }
  if (task.estimate_minutes !== null) {
    return readOnly
      ? `<span class="estimate-pill" title="Estimate">~${task.estimate_minutes}m</span>`
      : `<button type="button" class="estimate-pill estimate-pill-btn" data-task-action="edit-estimate" data-id="${task.id}" title="Click to change the estimate">~${task.estimate_minutes}m</button>`;
  }
  return (!readOnly && !task.is_done)
    ? `<button type="button" class="link-btn estimate-add" data-task-action="edit-estimate" data-id="${task.id}" title="Add a size estimate">+ size</button>`
    : "";
}

// One reusable "add a concrete step" form. `parentId` is always the ROOT task
// id: breaking a subtask down yields siblings (the model allows one level only).
function addStepFormHtml(parentId: number): string {
  return `
    <form class="task-child-form" data-parent-id="${parentId}">
      <input class="task-child-input" type="text" maxlength="500" placeholder="Add a concrete step..." autofocus />
      <button type="submit">Add step</button>
      <button type="button" class="secondary" data-task-action="cancel-child" data-id="${parentId}">Cancel</button>
    </form>`;
}

function taskHtml(task: DailyTaskRead, readOnly: boolean, isChild = false, hasChildren = false): string {
  const isMainGoal = state?.log?.main_goal_task_id === task.id;
  const goalStar = isMainGoal ? `<span class="task-main-goal-star" title="Main goal">⭐</span>` : "";
  const milestonePill = task.milestone_id !== null
    ? `<span class="milestone-pill" title="Advances a milestone">🎯</span>`
    : "";
  const duePill = task.due_date
    ? `<span class="due-pill ${dueClass(task.due_date)}" title="Due ${task.due_date}">📅 ${shortDue(task.due_date)}</span>`
    : "";
  const estControl = estimateControlHtml(task, readOnly);
  // A big, un-broken-down leaf is the classic "too vague to start" trap —
  // offer a one-click path into the break-down panel.
  const bigNudge = !readOnly && !isChild && !task.is_done && !hasChildren
    && task.estimate_minutes !== null && task.estimate_minutes >= BIG_TASK_MINUTES
    ? `<button type="button" class="link-btn task-big-nudge" data-task-action="break-down" data-id="${task.id}" title="This looks big — break it into steps">⚠ break down</button>`
    : "";
  // A subtask broken down yields *siblings* (one-level model), so its hint
  // wording differs slightly from a root task's "into steps".
  const stepTitle = isChild ? "Add another step alongside this one" : "Break this task into steps";
  return `
    <div class="task-item ${isChild ? "task-child" : "task-root"}${task.is_done ? " task-done" : ""}${isMainGoal ? " task-main-goal" : ""}"
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
      ${milestonePill}
      ${projectChipHtml(task.project_id)}
      ${duePill}
      ${estControl}
      ${bigNudge}
      ${readOnly
        ? (task.is_done ? "" : `<button type="button" class="link-btn task-carry-today" data-task-action="carry-to-today" data-id="${task.id}" title="Add this task to today">→ Today</button>`)
        : `
        ${task.is_done ? "" : `<button type="button" class="link-btn task-add-child" data-task-action="add-child" data-id="${task.id}" title="${stepTitle}">+ Step</button>`}
        ${task.is_done ? "" : `<button type="button" class="link-btn task-breakdown-btn" data-task-action="break-down" data-id="${task.id}" title="Stuck? Answer 3 quick questions to break it down">🧩 Break down</button>`}
        ${task.is_done ? "" : `<button class="secondary compact-btn" data-task-action="stopwatch" data-id="${task.id}" title="Start work timer">▶</button>`}
        ${task.is_done ? "" : `<button class="task-carry" data-task-action="carry" data-id="${task.id}" title="Carry to tomorrow">→</button>`}
        <button class="task-delete" data-task-action="delete" data-id="${task.id}" title="Delete">×</button>`}
    </div>`;
}

function breakdownPanelHtml(taskId: number): string {
  const rows = BREAKDOWN_QUESTIONS.map((q, i) => `
    <label class="task-breakdown-q">
      <span>${escapeHtml(q)}</span>
      <input class="task-breakdown-input" data-q-index="${i}" type="text" maxlength="500"
             placeholder="Answer becomes a subtask (optional)" />
    </label>`).join("");
  return `
    <form class="task-breakdown-form" data-parent-id="${taskId}">
      <p class="hint task-breakdown-hint">Stuck? Turn the blocker into next steps — fill any that apply.</p>
      ${rows}
      <div class="button-row">
        <button type="submit">Add as steps</button>
        <button type="button" class="secondary" data-task-action="cancel-breakdown" data-id="${taskId}">Cancel</button>
      </div>
    </form>`;
}

function taskGroupHtml(task: DailyTaskRead, children: DailyTaskRead[], readOnly: boolean): string {
  const rootId = task.id;
  const addingRoot = addingChildForTaskId === rootId && !readOnly;
  const breakingDownRoot = breakingDownTaskId === rootId && !readOnly;
  // Each child row may be followed by its own step-form / breakdown panel when
  // the user chose to break *that subtask* down. Steps still attach to rootId
  // so they appear as siblings (the model forbids deeper nesting).
  const childRows = children.map((child) => {
    const addStep = addingChildForTaskId === child.id && !readOnly ? addStepFormHtml(rootId) : "";
    const breakdown = breakingDownTaskId === child.id && !readOnly ? breakdownPanelHtml(rootId) : "";
    return taskHtml(child, readOnly, true) + addStep + breakdown;
  }).join("");
  // Subtasks are collapsed by default — opening Today should not auto-expand
  // every group. We keep a group open only if the user expanded it this
  // session (expandedTaskIds), or if they're mid-way through adding a step.
  const childrenOpen = expandedTaskIds.has(rootId) || addingRoot;
  const childPanel = children.length === 0 && !addingRoot
    ? ""
    : `<details class="task-children" data-root-id="${rootId}"${childrenOpen ? " open" : ""}>
         <summary>${children.length} step${children.length === 1 ? "" : "s"}</summary>
         <div class="task-children-list">${childRows}</div>
         ${addingRoot ? addStepFormHtml(rootId) : ""}
       </details>`;
  const breakdownPanel = breakingDownRoot ? breakdownPanelHtml(rootId) : "";
  return `<div class="task-group">${taskHtml(task, readOnly, false, children.length > 0)}${childPanel}${breakdownPanel}</div>`;
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
  for (const t of state.tasks.filter((task) => task.parent_task_id === null)) {
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
  const roots = filtered.filter((task) => task.parent_task_id === null);
  if (roots.length === 0) {
    if (state.tasks.length > 0) {
      taskList.innerHTML = `<div class="empty-state">No task matches this filter.</div>`;
    } else {
      taskList.innerHTML = readOnly
        ? `<div class="empty-state">No task recorded for this day.</div>`
        : renderEmptyStateWithCat("No task yet. Add one below ↓");
    }
    return;
  }
  taskList.innerHTML = roots.map((task) => taskGroupHtml(
    task,
    filtered.filter((child) => child.parent_task_id === task.id),
    readOnly,
  )).join("");
  taskList.querySelector<HTMLInputElement>(".task-child-input")?.focus();
}

function renderYesterdayCard(): void {
  // Only relevant when looking at today. When navigating to a past date,
  // hide the card entirely — the user is reviewing history, not planning.
  if (!isToday() || yesterdayState === null) {
    yesterdayCardEl.classList.add("hidden");
    return;
  }

  const reflection = yesterdayState.log?.reflection?.trim() ?? "";
  const unfinished = yesterdayState.tasks.filter((t) => !t.is_done && t.parent_task_id === null);
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

function daysUntil(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [ty, tm, td] = todayStr().split("-").map(Number);
  return Math.round(
    (new Date(y, m - 1, d).getTime() - new Date(ty, tm - 1, td).getTime()) / (24 * 3600 * 1000),
  );
}

// --- #1: milestone check-points → today -----------------------------------
// Surfaces near-due (or overdue) milestones that aren't yet pulled into today,
// so a far-off deadline becomes one concrete task you can start now.
const MILESTONE_HORIZON_DAYS = 21;

function renderMilestoneSteps(): void {
  // Planning affordance only — hide it while browsing past days.
  if (!isToday() || !state) {
    milestonesCardEl.classList.add("hidden");
    return;
  }
  // Milestones already turned into an open task today shouldn't be re-offered.
  const linked = new Set(
    state.tasks.filter((t) => !t.is_done && t.milestone_id !== null).map((t) => t.milestone_id),
  );
  const candidates = milestones
    .filter((m) => !m.is_archived && !linked.has(m.id) && daysUntil(m.due_date) <= MILESTONE_HORIZON_DAYS)
    .filter(passesProjectFilter)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .slice(0, 5);
  if (candidates.length === 0) {
    milestonesCardEl.classList.add("hidden");
    return;
  }
  milestonesCardEl.classList.remove("hidden");
  milestonesListEl.innerHTML = candidates.map((m) => {
    const d = daysUntil(m.due_date);
    const countdown = d < 0
      ? `<span class="milestone-step-when overdue">${Math.abs(d)}d overdue</span>`
      : d === 0
        ? `<span class="milestone-step-when due-today">due today</span>`
        : `<span class="milestone-step-when">D-${d}</span>`;
    return `
      <div class="milestone-step-item" data-milestone-id="${m.id}">
        ${countdown}
        <span class="milestone-step-title">${escapeHtml(m.title)}</span>
        ${projectChipHtml(m.project_id)}
        <button type="button" class="link-btn milestone-step-add" data-milestone-id="${m.id}">+ Add to today</button>
      </div>`;
  }).join("");
}

// --- #3: estimate chips on the new-task form -------------------------------

function renderEstimateChips(): void {
  if (!taskEstimateEl) return;
  const chips = ESTIMATE_CHOICES.map((mins) => `
    <button type="button" class="estimate-chip ${pendingTaskEstimate === mins ? "active" : ""}"
            data-estimate="${mins}">${mins}m</button>`).join("");
  taskEstimateEl.innerHTML = `<span class="estimate-chips-label">Size:</span>${chips}`;
}

function renderMood(): void {
  const readOnly = !isToday();
  moodRow.innerHTML = MOODS.map((m) => `
    <button class="mood-button ${selectedMood === m.emoji ? "active" : ""}" type="button"
            data-today-mood="${m.emoji}" title="${m.label}"
            ${readOnly ? "disabled" : ""}>
      ${m.emoji}
    </button>
  `).join("");
  moodReflectionInput.disabled = readOnly;
  moodSaveBtn.disabled = readOnly;

  if (todaysMoods.length === 0) {
    moodListEl.innerHTML = isToday()
      ? `<p class="hint today-mood-empty">No mood logged today yet.</p>`
      : "";
    return;
  }
  // One row per entry — emoji, time, optional reflection, delete.
  moodListEl.innerHTML = todaysMoods.map((m) => {
    const t = parseApiDate(m.created_at).toLocaleTimeString(undefined, {
      hour: "2-digit", minute: "2-digit",
    });
    const reflection = m.reflection
      ? `<span class="today-mood-entry-reflection">${escapeHtml(m.reflection)}</span>`
      : "";
    return `
      <div class="today-mood-entry">
        <span class="today-mood-entry-emoji">${m.mood}</span>
        <span class="today-mood-entry-time hint">${t}</span>
        ${reflection}
        ${isToday() ? `<button type="button" class="today-mood-entry-delete" data-mood-delete="${m.id}" title="Delete">×</button>` : ""}
      </div>`;
  }).join("");
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
  renderMilestoneSteps();
  renderUpcoming();
  renderMood();
  renderReflection();
  renderTaskForm();
  renderEstimateChips();
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
    const [s, up, moods, y, ms] = await Promise.all([
      getDailyState(viewedDate ?? undefined),
      // Upcoming is always for "from today onwards" — date navigation in
      // Today doesn't shift the looming-deadlines window.
      listUpcomingTasks().catch(() => [] as DailyTaskRead[]),
      // Today's mood stream (server scopes to caller). 1-day window is
      // enough for the inline list; multi-day history lives in Stats.
      listMoodEntries(1).catch(() => [] as MoodEntryRead[]),
      yesterdayFetch,
      // Future-dated, non-archived milestones for the "steps due soon" card.
      listMilestones({ onlyFuture: false }).catch(() => [] as MilestoneRead[]),
    ]);
    state = s;
    upcoming = up;
    yesterdayState = y;
    milestones = ms;
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

async function recordMood(): Promise<void> {
  if (!selectedMood) {
    setMessage(moodMessageEl, "Pick a mood first.", "error");
    return;
  }
  try {
    await createMoodEntry({
      mood: selectedMood,
      reflection: moodReflectionInput.value.trim(),
    });
    selectedMood = "";
    moodReflectionInput.value = "";
    setMessage(moodMessageEl, "Mood recorded.", "success");
    await refresh();
    await onDataChangedCb?.();
  } catch (error) {
    console.error(error);
    setMessage(moodMessageEl, "Could not record mood.", "error");
  }
}

async function removeMood(id: number): Promise<void> {
  if (!window.confirm("Delete this mood entry?")) return;
  try {
    await deleteMoodEntry(id);
    await refresh();
    await onDataChangedCb?.();
  } catch (error) {
    console.error(error);
    setMessage(moodMessageEl, "Could not delete entry.", "error");
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

// Two tasks belong to the same reorder group when they share a parent (both
// roots → parent null; or both children of the same task).
function sameSiblingGroup(aId: number, bId: number): boolean {
  if (!state) return false;
  const a = state.tasks.find((t) => t.id === aId);
  const b = state.tasks.find((t) => t.id === bId);
  return !!a && !!b && a.parent_task_id === b.parent_task_id;
}

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
      // Only signal a valid drop when the hovered row is in the same sibling
      // group as the dragged one — no cross-level (root↔child) moves.
      if (state && dragTaskId !== null && sameSiblingGroup(dragTaskId, Number(row.dataset.taskId))) {
        row.classList.add("drop-above");
      }
    });
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      row.classList.remove("drop-above");
      const movedId = dragTaskId;
      dragTaskId = null;
      if (!movedId || !state) return;
      const targetId = Number(row.dataset.taskId);
      if (movedId === targetId) return;
      const moved = state.tasks.find((t) => t.id === movedId);
      const targetTask = state.tasks.find((t) => t.id === targetId);
      if (!moved || !targetTask) return;
      // Reorder only within one sibling group (roots, or one parent's children).
      if (moved.parent_task_id !== targetTask.parent_task_id) return;
      const isChildLevel = moved.parent_task_id !== null;
      const scope: ParentNode = isChildLevel
        ? (row.closest(".task-children-list") ?? taskList)
        : taskList;
      const itemSel = isChildLevel ? ".task-item.task-child" : ".task-item.task-root";
      const items = Array.from(scope.querySelectorAll<HTMLDivElement>(itemSel));
      const targetIdx = items.indexOf(row);
      const prevIdx = items[targetIdx - 1]?.dataset.taskId === String(movedId)
        ? targetIdx - 2 : targetIdx - 1;
      const prevTask = prevIdx >= 0
        ? state.tasks.find((t) => t.id === Number(items[prevIdx].dataset.taskId))
        : null;
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
  milestonesCardEl = document.querySelector<HTMLElement>("#today-milestones-card")!;
  milestonesListEl = document.querySelector<HTMLDivElement>("#today-milestones-list")!;
  taskEstimateEl = document.querySelector<HTMLDivElement>("#today-task-estimate")!;
  yesterdayCardEl = document.querySelector<HTMLElement>("#today-yesterday-card")!;
  yesterdayBodyEl = document.querySelector<HTMLDivElement>("#today-yesterday-body")!;
  yesterdayCarryAllBtn = document.querySelector<HTMLButtonElement>("#today-yesterday-carry-all")!;
  moodRow = document.querySelector<HTMLDivElement>("#today-mood-row")!;
  moodReflectionInput = document.querySelector<HTMLTextAreaElement>("#today-mood-reflection")!;
  moodSaveBtn = document.querySelector<HTMLButtonElement>("#today-mood-save")!;
  moodMessageEl = document.querySelector<HTMLParagraphElement>("#today-mood-message")!;
  moodListEl = document.querySelector<HTMLDivElement>("#today-mood-list")!;
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
        estimate_minutes: pendingTaskEstimate,
      });
      taskInput.value = "";
      taskDueInput.value = "";
      pendingTaskDue = "";
      pendingTaskEstimate = null;
      renderEstimateChips();
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
    if (!isToday() && action !== "stopwatch" && action !== "pomodoro" && action !== "carry-to-today") return;
    try {
      if (action === "carry-to-today") {
        // Available while reviewing a past day: pull that task into today.
        // The backend brings a parent's unfinished children along, and a
        // clicked subtask drags its parent with it.
        await carryTaskToToday(id);
        setMessage(messageEl, "Added to today.", "success");
        await refresh();
        await onDataChangedCb?.();
        window.dispatchEvent(new CustomEvent("task-list:updated"));
      } else if (action === "add-child") {
        addingChildForTaskId = id;
        renderTaskList();
      } else if (action === "cancel-child") {
        addingChildForTaskId = null;
        renderTaskList();
      } else if (action === "break-down") {
        breakingDownTaskId = breakingDownTaskId === id ? null : id;
        renderTaskList();
        taskList.querySelector<HTMLInputElement>(".task-breakdown-input")?.focus();
      } else if (action === "cancel-breakdown") {
        breakingDownTaskId = null;
        renderTaskList();
      } else if (action === "edit-estimate") {
        editingEstimateTaskId = editingEstimateTaskId === id ? null : id;
        renderTaskList();
      } else if (action === "set-estimate") {
        const raw = target.dataset.estimate;
        const value = raw === "clear" ? null : Number(raw);
        editingEstimateTaskId = null;
        await updateDailyTask(id, { estimate_minutes: value });
        await refresh();
        await onDataChangedCb?.();
      } else if (action === "toggle") {
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
        TimerMode.setMode("free");
        await StopwatchView.startForFocus(id, task.text, task.estimate_minutes ?? undefined);
      } else if (action === "pomodoro") {
        TimerMode.setMode("pomodoro");
        await PomodoroView.startForFocus(id);
      }
    } catch (error) {
      console.error(error);
      setMessage(messageEl, "Could not update task.", "error");
    }
  });

  taskList.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches(".task-child-form")) {
      event.preventDefault();
      const parentId = Number(form.dataset.parentId);
      const input = form.querySelector<HTMLInputElement>(".task-child-input");
      const text = input?.value.trim() ?? "";
      if (!Number.isFinite(parentId) || !text) return;
      try {
        await createDailyTask({ text, parent_task_id: parentId });
        addingChildForTaskId = null;
        setMessage(messageEl, "Step added.", "success");
        await refresh();
        await onDataChangedCb?.();
        window.dispatchEvent(new CustomEvent("task-list:updated"));
      } catch (error) {
        console.error(error);
        setMessage(messageEl, "Could not add step.", "error");
      }
    } else if (form.matches(".task-breakdown-form")) {
      event.preventDefault();
      const parentId = Number(form.dataset.parentId);
      if (!Number.isFinite(parentId)) return;
      // Each non-empty answer becomes one concrete subtask.
      const answers = Array.from(
        form.querySelectorAll<HTMLInputElement>(".task-breakdown-input"),
      ).map((i) => i.value.trim()).filter((v) => v.length > 0);
      if (answers.length === 0) {
        setMessage(messageEl, "Answer at least one question to create a step.", "error");
        return;
      }
      try {
        // Sequential keeps sort_order deterministic (creation-ordered).
        for (const text of answers) {
          await createDailyTask({ text, parent_task_id: parentId });
        }
        breakingDownTaskId = null;
        setMessage(messageEl, `Added ${answers.length} step${answers.length === 1 ? "" : "s"}.`, "success");
        await refresh();
        await onDataChangedCb?.();
        window.dispatchEvent(new CustomEvent("task-list:updated"));
      } catch (error) {
        console.error(error);
        setMessage(messageEl, "Could not add steps.", "error");
      }
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

  // Remember which subtask groups the user expands so re-renders don't snap
  // them shut. `toggle` doesn't bubble, so we listen in the capture phase.
  taskList.addEventListener("toggle", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLDetailsElement) || !el.classList.contains("task-children")) return;
    const rootId = Number(el.dataset.rootId);
    if (!Number.isFinite(rootId)) return;
    if (el.open) expandedTaskIds.add(rootId);
    else expandedTaskIds.delete(rootId);
  }, true);

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
    const unfinished = yesterdayState.tasks.filter((t) => !t.is_done && t.parent_task_id === null);
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

  // Milestone "steps due soon" — pull a milestone into today as a task.
  milestonesListEl.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest<HTMLElement>(".milestone-step-add");
    if (!btn) return;
    const mid = Number(btn.dataset.milestoneId);
    if (!Number.isFinite(mid)) return;
    (btn as HTMLButtonElement).disabled = true;
    try {
      await addMilestoneToToday(mid);
      flashMessage(messageEl, "🎯 Added to today.", "success");
      await refresh();
      await onDataChangedCb?.();
      window.dispatchEvent(new CustomEvent("task-list:updated"));
    } catch (error) {
      console.error(error);
      setMessage(messageEl, "Could not add milestone to today.", "error");
      (btn as HTMLButtonElement).disabled = false;
    }
  });

  // Estimate chips on the new-task form — toggle the pending estimate.
  taskEstimateEl.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const chip = target.closest<HTMLElement>(".estimate-chip");
    if (!chip) return;
    const mins = Number(chip.dataset.estimate);
    if (!Number.isFinite(mins)) return;
    pendingTaskEstimate = pendingTaskEstimate === mins ? null : mins;
    renderEstimateChips();
  });

  // Mood emoji click — stage selection (Save button commits with optional
  // reflection text). Keeps single-click recording out of the way of
  // misclicks, and lets users add context before persisting.
  moodRow.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const mood = target.dataset.todayMood;
    if (!mood || !isToday()) return;
    selectedMood = selectedMood === mood ? "" : mood;
    renderMood();
  });
  moodSaveBtn.addEventListener("click", () => void recordMood());
  moodListEl.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const id = Number(target.dataset.moodDelete);
    if (!Number.isFinite(id)) return;
    void removeMood(id);
  });
  // History link routes the user to Stats where the full timeline lives.
  document.querySelector<HTMLButtonElement>("#today-mood-history-link")
    ?.addEventListener("click", () => {
      document.querySelector<HTMLButtonElement>('.feature-tab[data-view="stats"]')?.click();
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
