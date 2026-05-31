/**
 * Daily tracker view.
 *
 * Three regions per card:
 *   1. Day navigation — ← Today → ; past dates are read-only.
 *   2. Tasks — split into "undone" (top) and a collapsible "done" group
 *      below. Each task supports inline edit (double-click) + delete +
 *      drag-reorder.
 *   3. Daily log — mood picker + reflection textarea + Save.
 */

import {
  carryDailyTask, createDailyTask, deleteDailyTask, getDailyState,
  saveDailyLog, updateDailyTask, type DailyStateRead, type DailyTaskRead,
} from "../api/tracker";
import { escapeHtml, setMessage } from "../utils";
import { renderEmptyStateWithCat } from "./icons";

const MOODS = [
  { emoji: "😩", label: "Exhausted" },
  { emoji: "😔", label: "Low" },
  { emoji: "😐", label: "Neutral" },
  { emoji: "🙂", label: "Good" },
  { emoji: "🔥", label: "On fire" },
] as const;

let trackerPercent: HTMLElement;
let trackerProgressFill: HTMLDivElement;
let trackerCount: HTMLParagraphElement;
let taskForm: HTMLFormElement;
let taskInput: HTMLInputElement;
let taskList: HTMLDivElement;
let moodRow: HTMLDivElement;
let reflectionInput: HTMLTextAreaElement;
let saveLogButton: HTMLButtonElement;
let trackerMessage: HTMLParagraphElement;
let dateBar: HTMLDivElement;

let dailyState: DailyStateRead | null = null;
let selectedMood = "";
let doneExpanded = false;
let onDataChangedCb: (() => Promise<void>) | null = null;

// Date being viewed. null = today (live, editable). Any other date = read-only.
let viewedDate: string | null = null;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Local YYYY-MM-DD for a Date — never use toISOString() (that gives UTC). */
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

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderDateBar(): void {
  if (!dateBar) return;
  const today = isToday();
  dateBar.innerHTML = `
    <button class="date-nav-btn" type="button" data-shift="-1" title="Previous day">←</button>
    <span class="date-nav-label">${prettyDate(effectiveDate())}${today ? " · Today" : ""}</span>
    <button class="date-nav-btn" type="button" data-shift="+1" title="Next day"
            ${today ? "disabled" : ""}>→</button>
    ${today ? "" : `<button class="link-btn date-nav-today" type="button" data-go-today="1">Jump to today</button>`}
  `;
}

function taskHtml(task: DailyTaskRead, readOnly: boolean): string {
  return `
    <div class="task-item${task.is_done ? " task-done" : ""}"
         data-task-id="${task.id}"
         ${readOnly ? "" : 'draggable="true"'}>
      <button class="task-checkbox ${task.is_done ? "checked" : ""}"
              data-task-action="toggle" data-id="${task.id}"
              aria-label="Toggle task"
              ${readOnly ? "disabled" : ""}>
        ${task.is_done ? "✓" : ""}
      </button>
      <span class="task-text ${task.is_done ? "done" : ""}"
            data-task-action="edit" data-id="${task.id}"
            title="${readOnly ? "" : "Double-click to edit"}">${escapeHtml(task.text)}</span>
      ${readOnly ? "" : `
        ${task.is_done ? "" : `<button class="task-carry" data-task-action="carry" data-id="${task.id}" title="Carry to tomorrow">Tomorrow</button>`}
        <button class="task-delete" data-task-action="delete" data-id="${task.id}" title="Delete">×</button>`}
    </div>`;
}

export function render(): void {
  renderDateBar();

  if (!dailyState) {
    taskList.innerHTML = renderEmptyStateWithCat("Daily tracker not loaded yet.");
    return;
  }

  // Progress meter
  trackerPercent.textContent = `${dailyState.completion_percent}%`;
  trackerProgressFill.style.width = `${dailyState.completion_percent}%`;
  trackerCount.textContent = `${dailyState.done_count} / ${dailyState.total_count} tasks done`;

  const readOnly = !isToday();
  const undone = dailyState.tasks.filter((t) => !t.is_done);
  const done = dailyState.tasks.filter((t) => t.is_done);

  // Empty state for the whole list
  if (dailyState.tasks.length === 0) {
    taskList.innerHTML = readOnly
      ? `<div class="empty-state">No task recorded for this day.</div>`
      : renderEmptyStateWithCat("No task for today. Add one above ↑");
  } else {
    const undoneHtml = undone.map((t) => taskHtml(t, readOnly)).join("");
    const doneCount = done.length;
    const doneSection = doneCount === 0 ? "" : `
      <button class="task-done-header${doneExpanded ? " expanded" : ""}"
              type="button" data-toggle-done="1">
        <span class="arrow">${doneExpanded ? "▾" : "▸"}</span>
        Done · ${doneCount}
      </button>
      <div class="task-done-list${doneExpanded ? "" : " hidden"}">
        ${done.map((t) => taskHtml(t, readOnly)).join("")}
      </div>`;
    taskList.innerHTML = undoneHtml + doneSection;
  }

  // Add input + form is hidden for past dates.
  taskForm.classList.toggle("hidden", readOnly);

  // Daily log section
  selectedMood = dailyState.log?.mood ?? "";
  reflectionInput.value = dailyState.log?.reflection ?? "";
  reflectionInput.disabled = readOnly;
  saveLogButton.disabled = readOnly;
  saveLogButton.classList.toggle("hidden", readOnly);
  moodRow.innerHTML = MOODS.map((mood) => `
    <button class="mood-button ${selectedMood === mood.emoji ? "active" : ""}"
            data-mood="${mood.emoji}" title="${mood.label}"
            ${readOnly ? "disabled" : ""}>
      ${mood.emoji}
    </button>`).join("");
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export async function refresh(): Promise<void> {
  try {
    dailyState = await getDailyState(viewedDate ?? undefined);
    render();
  } catch (error) {
    console.error(error);
    setMessage(trackerMessage, "Could not load daily tracker.", "error");
  }
}

// ---------------------------------------------------------------------------
// Inline-edit helper
// ---------------------------------------------------------------------------

function startInlineEdit(taskId: number, span: HTMLElement): void {
  if (!isToday() || !dailyState) return;
  const task = dailyState.tasks.find((t) => t.id === taskId);
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
  const cancel = () => {
    if (committed) return;
    committed = true;
    input.replaceWith(span);
  };
  const commit = async () => {
    if (committed) return;
    committed = true;
    const newText = input.value.trim();
    if (!newText || newText === task.text) {
      input.replaceWith(span);
      return;
    }
    try {
      await updateDailyTask(task.id, { text: newText });
      await onDataChangedCb?.();
    } catch (error) {
      console.error(error);
      setMessage(trackerMessage, "Could not update task.", "error");
      input.replaceWith(span);
    }
  };
  input.addEventListener("blur", () => void commit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
}

// ---------------------------------------------------------------------------
// Drag-reorder helper
// ---------------------------------------------------------------------------

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
      if (!movedId || !dailyState) return;
      const targetId = Number(row.dataset.taskId);
      if (movedId === targetId) return;

      // Compute new sort_order via midpoint: drop "above" target means the
      // moved task goes immediately before target. Find its previous
      // sibling (in the same group) to take the midpoint.
      const group = row.parentElement!;
      const items = Array.from(group.querySelectorAll<HTMLDivElement>(".task-item"));
      const targetIdx = items.indexOf(row);
      const prevIdx = items[targetIdx - 1]?.dataset.taskId === String(movedId)
        ? targetIdx - 2
        : targetIdx - 1;
      const targetTask = dailyState.tasks.find((t) => t.id === targetId);
      const prevTask = prevIdx >= 0
        ? dailyState.tasks.find((t) => t.id === Number(items[prevIdx].dataset.taskId))
        : null;
      if (!targetTask) return;

      const prevSO = prevTask ? prevTask.sort_order : targetTask.sort_order - 1;
      const newSO = (prevSO + targetTask.sort_order) / 2;
      try {
        await updateDailyTask(movedId, { sort_order: newSO });
        await onDataChangedCb?.();
      } catch (error) {
        console.error(error);
        setMessage(trackerMessage, "Could not reorder task.", "error");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export function init(onRefreshNeeded: () => Promise<void>): void {
  onDataChangedCb = onRefreshNeeded;
  trackerPercent = document.querySelector<HTMLElement>("#tracker-percent")!;
  trackerProgressFill = document.querySelector<HTMLDivElement>("#tracker-progress-fill")!;
  trackerCount = document.querySelector<HTMLParagraphElement>("#tracker-count")!;
  taskForm = document.querySelector<HTMLFormElement>("#task-form")!;
  taskInput = document.querySelector<HTMLInputElement>("#task-input")!;
  taskList = document.querySelector<HTMLDivElement>("#task-list")!;
  moodRow = document.querySelector<HTMLDivElement>("#mood-row")!;
  reflectionInput = document.querySelector<HTMLTextAreaElement>("#reflection-input")!;
  saveLogButton = document.querySelector<HTMLButtonElement>("#save-log-button")!;
  trackerMessage = document.querySelector<HTMLParagraphElement>("#tracker-message")!;
  dateBar = document.querySelector<HTMLDivElement>("#tracker-date-bar")!;

  // Re-render the sleeping-cat empty state when the user picks a new skin.
  window.addEventListener("cat:skin-changed", () => render());

  // Date navigation (delegated)
  dateBar.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.shift) {
      const shift = Number(target.dataset.shift);
      const next = shiftDate(effectiveDate(), shift);
      // Forbid navigating past today (data wouldn't exist yet anyway).
      if (next > todayStr()) return;
      viewedDate = next === todayStr() ? null : next;
      doneExpanded = false;
      await refresh();
    } else if (target.dataset.goToday) {
      viewedDate = null;
      doneExpanded = false;
      await refresh();
    }
  });

  taskForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isToday()) return; // safety
    const text = taskInput.value.trim();
    if (!text) { setMessage(trackerMessage, "Task text is required.", "error"); return; }
    try {
      await createDailyTask({ text });
      taskInput.value = "";
      setMessage(trackerMessage, "Task created.", "success");
      await onRefreshNeeded();
      // Let stopwatch/pomodoro task pickers know they should re-fetch the
      // task list. Cheap event — fires zero work if no listener is attached.
      window.dispatchEvent(new CustomEvent("task-list:updated"));
    } catch (error) {
      console.error(error);
      setMessage(trackerMessage, "Could not create task.", "error");
    }
  });

  taskList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    // Toggle the "Done · N" collapsible header.
    if (target.closest("[data-toggle-done]")) {
      doneExpanded = !doneExpanded;
      render();
      return;
    }

    const action = target.dataset.taskAction;
    const taskId = Number(target.dataset.id);
    if (!action || !Number.isFinite(taskId) || !dailyState) return;
    const task = dailyState.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (!isToday()) return; // safety — buttons are disabled but defend in depth
    try {
      if (action === "toggle") {
        await updateDailyTask(task.id, { is_done: !task.is_done });
        await onRefreshNeeded();
        window.dispatchEvent(new CustomEvent("task-list:updated"));
      }
      else if (action === "delete") {
        await deleteDailyTask(task.id);
        setMessage(trackerMessage, "Task deleted.", "success");
        await onRefreshNeeded();
        window.dispatchEvent(new CustomEvent("task-list:updated"));
      }
      else if (action === "carry") {
        await carryDailyTask(task.id);
        setMessage(trackerMessage, "Task copied to tomorrow.", "success");
      }
    } catch (error) {
      console.error(error);
      setMessage(trackerMessage, "Could not update task.", "error");
    }
  });

  // Inline edit on double-click.
  taskList.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.taskAction !== "edit") return;
    if (!isToday()) return;
    const taskId = Number(target.dataset.id);
    if (!Number.isFinite(taskId)) return;
    startInlineEdit(taskId, target);
  });

  // Drag-reorder bindings are attached after every render.
  const observer = new MutationObserver(() => attachDragHandlers());
  observer.observe(taskList, { childList: true, subtree: true });

  moodRow.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const mood = target.dataset.mood;
    if (!mood || !isToday()) return;
    selectedMood = mood;
    moodRow.querySelectorAll(".mood-button").forEach((btn) => {
      btn.classList.toggle("active", btn instanceof HTMLElement && btn.dataset.mood === mood);
    });
  });

  saveLogButton.addEventListener("click", async () => {
    if (!isToday()) return;
    try {
      const log = await saveDailyLog({ mood: selectedMood, reflection: reflectionInput.value.trim() });
      if (dailyState) dailyState.log = log;
      const when = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      setMessage(trackerMessage, `Daily log saved at ${when}.`, "success");
      await onRefreshNeeded();
    } catch (error) {
      console.error(error);
      setMessage(trackerMessage, "Could not save daily log.", "error");
    }
  });
}
