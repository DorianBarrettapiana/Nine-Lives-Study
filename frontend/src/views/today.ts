/**
 * Login landing page: the handful of actions worth seeing every day.
 * It deliberately composes the existing tracker and timer APIs rather than
 * creating a second planning system.
 */

import { createMoodEntry } from "../api/mood";
import {
  carryDailyTask, getDailyState, saveDailyLog, updateDailyTask,
  type DailyStateRead,
} from "../api/tracker";
import { escapeHtml, setMessage } from "../utils";
import { renderEmptyStateWithCat } from "./icons";
import * as PomodoroView from "./pomodoro";
import * as StopwatchView from "./stopwatch";

const MOODS = ["😩", "😔", "😐", "🙂", "🔥"];

let goalInput: HTMLInputElement;
let focusInput: HTMLInputElement;
let taskList: HTMLDivElement;
let progressLabel: HTMLElement;
let progressFill: HTMLDivElement;
let moodRow: HTMLDivElement;
let reflectionInput: HTMLTextAreaElement;
let messageEl: HTMLParagraphElement;
let state: DailyStateRead | null = null;
let onDataChangedCb: (() => Promise<void>) | null = null;

function taskRow(task: DailyStateRead["tasks"][number]): string {
  return `
    <div class="task-item">
      <button class="task-checkbox ${task.is_done ? "checked" : ""}" data-today-action="toggle" data-id="${task.id}">
        ${task.is_done ? "✓" : ""}
      </button>
      <span class="task-text ${task.is_done ? "done" : ""}">${escapeHtml(task.text)}</span>
      ${task.is_done ? "" : `
        <button class="secondary compact-btn" data-today-action="stopwatch" data-id="${task.id}">Start</button>
        <button class="secondary compact-btn" data-today-action="pomodoro" data-id="${task.id}">Pomo</button>
        <button class="task-carry" data-today-action="carry" data-id="${task.id}">Tomorrow</button>`}
    </div>`;
}

export function render(): void {
  if (!state) return;
  goalInput.value = state.log?.main_goal ?? "";
  reflectionInput.value = state.log?.reflection ?? "";
  progressLabel.textContent = `${state.done_count} / ${state.total_count}`;
  progressFill.style.width = `${state.completion_percent}%`;
  taskList.innerHTML = state.tasks.length
    ? state.tasks.map(taskRow).join("")
    : renderEmptyStateWithCat("No task yet. Add today's plan in Daily tracker.");
  moodRow.innerHTML = MOODS.map((mood) =>
    `<button class="mood-button" type="button" data-today-mood="${mood}">${mood}</button>`
  ).join("");
}

export async function refresh(): Promise<void> {
  try {
    state = await getDailyState();
    render();
  } catch (error) {
    console.error(error);
    setMessage(messageEl, "Could not load today's plan.", "error");
  }
}

async function saveLog(partial: { main_goal?: string; reflection?: string }): Promise<void> {
  const log = await saveDailyLog({
    main_goal: partial.main_goal ?? state?.log?.main_goal ?? "",
    mood: state?.log?.mood ?? "",
    reflection: partial.reflection ?? state?.log?.reflection ?? "",
  });
  if (state) state.log = log;
}

export function init(onDataChanged: () => Promise<void>): void {
  onDataChangedCb = onDataChanged;
  goalInput = document.querySelector<HTMLInputElement>("#today-main-goal")!;
  focusInput = document.querySelector<HTMLInputElement>("#today-focus-input")!;
  taskList = document.querySelector<HTMLDivElement>("#today-task-list")!;
  progressLabel = document.querySelector<HTMLElement>("#today-progress-label")!;
  progressFill = document.querySelector<HTMLDivElement>("#today-progress-fill")!;
  moodRow = document.querySelector<HTMLDivElement>("#today-mood-row")!;
  reflectionInput = document.querySelector<HTMLTextAreaElement>("#today-reflection")!;
  messageEl = document.querySelector<HTMLParagraphElement>("#today-message")!;

  document.querySelector<HTMLButtonElement>("#today-save-goal")!.addEventListener("click", async () => {
    try {
      await saveLog({ main_goal: goalInput.value.trim() });
      setMessage(messageEl, "Main goal saved.", "success");
    } catch (error) {
      console.error(error);
      setMessage(messageEl, "Could not save main goal.", "error");
    }
  });

  document.querySelector<HTMLButtonElement>("#today-save-reflection")!.addEventListener("click", async () => {
    try {
      await saveLog({ reflection: reflectionInput.value.trim() });
      setMessage(messageEl, "Evening reflection saved.", "success");
      await onDataChangedCb?.();
    } catch (error) {
      console.error(error);
      setMessage(messageEl, "Could not save reflection.", "error");
    }
  });

  document.querySelector<HTMLButtonElement>("#today-start-stopwatch")!.addEventListener("click", async () => {
    await StopwatchView.startForFocus(null, focusInput.value.trim());
  });
  document.querySelector<HTMLButtonElement>("#today-start-pomodoro")!.addEventListener("click", async () => {
    await PomodoroView.startForFocus(null, focusInput.value.trim());
  });

  moodRow.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.dataset.todayMood) return;
    try {
      await createMoodEntry({ mood: target.dataset.todayMood, reflection: "" });
      setMessage(messageEl, "Mood recorded.", "success");
      await onDataChangedCb?.();
    } catch (error) {
      console.error(error);
      setMessage(messageEl, "Could not record mood.", "error");
    }
  });

  taskList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !state) return;
    const action = target.dataset.todayAction;
    const id = Number(target.dataset.id);
    const task = state.tasks.find((item) => item.id === id);
    if (!action || !task) return;
    try {
      if (action === "toggle") await updateDailyTask(id, { is_done: !task.is_done });
      if (action === "carry") await carryDailyTask(id);
      if (action === "stopwatch") await StopwatchView.startForFocus(id, task.text);
      if (action === "pomodoro") await PomodoroView.startForFocus(id, task.text);
      if (action === "carry") setMessage(messageEl, "Task copied to tomorrow.", "success");
      if (action === "toggle") await onDataChangedCb?.();
    } catch (error) {
      console.error(error);
      setMessage(messageEl, "Could not update today's task.", "error");
    }
  });

  window.addEventListener("cat:skin-changed", () => render());
}
