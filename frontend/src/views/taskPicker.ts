/**
 * Daily-task picker — shared between stopwatch and pomodoro cards.
 *
 * Renders a `<select>` listing the user's open daily tasks plus a
 * "(no task)" sentinel. Wires up onChange so the caller doesn't have to
 * re-implement the DOM glue twice.
 *
 * Caching: we hold the most recently fetched task list at module level
 * so opening both timers doesn't fire two GET /tracker/state calls.
 * Auto-refreshes after window 'task-list:updated' events (dispatched by
 * the tracker view when the user creates/completes/deletes a task).
 */

import { getDailyState, type DailyTaskRead } from "../api/tracker";
import { escapeHtml } from "../utils";

let cachedTasks: DailyTaskRead[] | null = null;
let inFlight: Promise<DailyTaskRead[]> | null = null;

async function fetchTasks(): Promise<DailyTaskRead[]> {
  if (cachedTasks !== null) return cachedTasks;
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    try {
      const state = await getDailyState();
      cachedTasks = state.tasks ?? [];
      return cachedTasks;
    } catch {
      // Failing soft: timer still works without the picker if the tracker
      // endpoint is down. Just shows "(no task)".
      cachedTasks = [];
      return cachedTasks;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Call when tasks may have changed (creation, deletion, completion). */
export function invalidateTaskCache(): void {
  cachedTasks = null;
}

// Trigger cache invalidation when other views mutate the task list.
window.addEventListener("task-list:updated", () => invalidateTaskCache());

interface RenderOptions {
  /** Container element to populate. */
  container: HTMLElement;
  /** Currently linked task id, if any. Drives the initial <select> value. */
  selectedTaskId: number | null;
  /** Called when the user picks a different task. null = "(no task)". */
  onChange: (taskId: number | null) => void;
  /** Verb prefix shown before the select — e.g. "Working on" / "Focus". */
  label?: string;
  /** When true, dims the picker (use during a session if you want a lock). */
  disabled?: boolean;
}

/** Build the picker. Re-callable to refresh after an async task-list reload. */
export async function renderTaskPicker(opts: RenderOptions): Promise<void> {
  const tasks = await fetchTasks();
  // Open tasks first (you're more likely to start work on something
  // un-done than something already finished), then completed ones in a
  // separate optgroup so the selected-but-now-done task still shows up
  // instead of mysteriously vanishing from the list.
  const open = tasks.filter((t) => !t.is_done);
  const done = tasks.filter((t) => t.is_done);

  const label = opts.label ?? "Working on";
  const selected = opts.selectedTaskId ?? 0;

  const opt = (t: DailyTaskRead): string =>
    `<option value="${t.id}" ${t.id === selected ? "selected" : ""}>${escapeHtml(t.text)}</option>`;

  opts.container.innerHTML = `
    <label class="task-picker-row">
      <span class="task-picker-label">${escapeHtml(label)}:</span>
      <select class="task-picker-select" ${opts.disabled ? "disabled" : ""}>
        <option value="0" ${selected === 0 ? "selected" : ""}>(no task)</option>
        ${open.length > 0 ? `<optgroup label="Open">${open.map(opt).join("")}</optgroup>` : ""}
        ${done.length > 0 ? `<optgroup label="Done">${done.map(opt).join("")}</optgroup>` : ""}
      </select>
    </label>
  `;

  const select = opts.container.querySelector<HTMLSelectElement>("select");
  if (select === null) return;
  select.addEventListener("change", () => {
    const id = Number(select.value);
    opts.onChange(Number.isFinite(id) && id > 0 ? id : null);
  });
}

/** Re-fetch tasks from server. Use after creating a new task in another view. */
export async function refreshTasks(): Promise<void> {
  invalidateTaskCache();
  await fetchTasks();
}
