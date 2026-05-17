/**
 * Daily tracker view.
 */

import {
  createDailyTask, deleteDailyTask, getDailyState,
  saveDailyLog, updateDailyTask, type DailyStateRead,
} from "../api/tracker";
import { escapeHtml, setMessage } from "../utils";

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

let dailyState: DailyStateRead | null = null;
let selectedMood = "";

export function render(): void {
  if (!dailyState) {
    taskList.innerHTML = `<div class="empty-state">Daily tracker not loaded yet.</div>`;
    return;
  }
  trackerPercent.textContent = `${dailyState.completion_percent}%`;
  trackerProgressFill.style.width = `${dailyState.completion_percent}%`;
  trackerCount.textContent = `${dailyState.done_count} / ${dailyState.total_count} tasks done`;

  taskList.innerHTML = dailyState.tasks.length === 0
    ? `<div class="empty-state">No task for today.</div>`
    : dailyState.tasks.map((task) => `
        <div class="task-item">
          <button class="task-checkbox ${task.is_done ? "checked" : ""}" data-task-action="toggle" data-id="${task.id}" aria-label="Toggle task">
            ${task.is_done ? "✓" : ""}
          </button>
          <span class="task-text ${task.is_done ? "done" : ""}">${escapeHtml(task.text)}</span>
          <button class="task-delete" data-task-action="delete" data-id="${task.id}">×</button>
        </div>`).join("");

  selectedMood = dailyState.log?.mood ?? "";
  reflectionInput.value = dailyState.log?.reflection ?? "";
  moodRow.innerHTML = MOODS.map((mood) => `
    <button class="mood-button ${selectedMood === mood.emoji ? "active" : ""}" data-mood="${mood.emoji}" title="${mood.label}">
      ${mood.emoji}
    </button>`).join("");
}

export async function refresh(): Promise<void> {
  try {
    dailyState = await getDailyState();
    render();
  } catch (error) {
    console.error(error);
    setMessage(trackerMessage, "Could not load daily tracker.", "error");
  }
}

export function init(onRefreshNeeded: () => Promise<void>): void {
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

  taskForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = taskInput.value.trim();
    if (!text) { setMessage(trackerMessage, "Task text is required.", "error"); return; }
    try {
      await createDailyTask({ text });
      taskInput.value = "";
      setMessage(trackerMessage, "Task created.", "success");
      await onRefreshNeeded();
    } catch (error) {
      console.error(error);
      setMessage(trackerMessage, "Could not create task.", "error");
    }
  });

  taskList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.taskAction;
    const taskId = Number(target.dataset.id);
    if (!action || !Number.isFinite(taskId) || !dailyState) return;
    const task = dailyState.tasks.find((t) => t.id === taskId);
    if (!task) return;
    try {
      if (action === "toggle") {
        await updateDailyTask(task.id, { is_done: !task.is_done });
        if (!task.is_done) setMessage(trackerMessage, "Task done! +10 XP", "success");
        await onRefreshNeeded();
      }
      else if (action === "delete") { await deleteDailyTask(task.id); setMessage(trackerMessage, "Task deleted.", "success"); await onRefreshNeeded(); }
    } catch (error) {
      console.error(error);
      setMessage(trackerMessage, "Could not update task.", "error");
    }
  });

  moodRow.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const mood = target.dataset.mood;
    if (!mood) return;
    selectedMood = mood;
    moodRow.querySelectorAll(".mood-button").forEach((btn) => {
      btn.classList.toggle("active", btn instanceof HTMLElement && btn.dataset.mood === mood);
    });
  });

  saveLogButton.addEventListener("click", async () => {
    try {
      await saveDailyLog({ mood: selectedMood, reflection: reflectionInput.value.trim() });
      setMessage(trackerMessage, "Daily log saved. +5 XP", "success");
      await onRefreshNeeded();
    } catch (error) {
      console.error(error);
      setMessage(trackerMessage, "Could not save daily log.", "error");
    }
  });
}
