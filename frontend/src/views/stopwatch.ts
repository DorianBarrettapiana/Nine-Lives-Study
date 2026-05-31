/**
 * Stopwatch ("positive timing") sidebar widget.
 *
 * Sits below the XP card. Server holds canonical state (active session,
 * accumulated seconds, last_started_at) so a page refresh resumes the
 * timer correctly. The local interval merely re-renders the HH:MM:SS
 * label from `Date.now()` minus the server's `last_started_at` — no
 * second-by-second writes to the backend.
 *
 * Mutex with the pomodoro timer is enforced server-side (409 if either
 * is active). The view also listens for `pomodoro:active` window events
 * so the Start button can be visually disabled before the user clicks.
 */

import { ApiError } from "../api/client";
import {
  endStopwatch,
  getActive,
  pauseStopwatch,
  resumeStopwatch,
  startStopwatch,
  updateStopwatchTask,
  type StopwatchSessionRead,
} from "../api/stopwatch";
import { flashMessage, fmtMinutes, setMessage } from "../utils";
import { renderAnalogClockSvg } from "./clock";
import { getTodayWorkMinutes } from "./stats";
import { renderTaskPicker } from "./taskPicker";

let clockEl: HTMLDivElement;       // analog clock SVG container
let displayEl: HTMLDivElement;     // digital readout below the clock
let todayEl: HTMLParagraphElement; // "Today: Xh Ym" hint line
let focusInput: HTMLInputElement;
let startBtn: HTMLButtonElement;
let endBtn: HTMLButtonElement;
let messageEl: HTMLParagraphElement;
let taskPickerEl: HTMLDivElement | null = null;

// Holds the picker's "what should we start with" value until the user
// clicks Start. Once a session is active, the source of truth is
// `active.linked_task_id` and this variable is no longer consulted.
let pendingTaskId: number | null = null;

let active: StopwatchSessionRead | null = null;
// Local clock baseline for the currently-active session. We anchor on the
// server's `elapsed_seconds` at the moment we received the response, then
// just add `(Date.now() - activeFetchedAt)` while running. This sidesteps
// client-vs-server wall-clock skew, which previously caused a visible jump
// on Resume when the client's clock differed from the server's by even a
// few seconds. Null when no active session.
let activeElapsedAtFetchSeconds = 0;
let activeFetchedAtMs = 0;
let tickIntervalId: ReturnType<typeof setInterval> | null = null;
// True when a pomodoro is currently running locally; blocks Start.
let pomodoroBlocking = false;
// User's currently-selected cat skin — drives the ear fill on the analog
// clock so the timer visually matches their avatar.
let catSkin = "tabby";

/** Update the cat skin used to color the clock's ears. Called from main.ts
 *  when the user picks a new skin in the sidebar picker. */
export function setCatSkin(skin: string): void {
  catSkin = skin;
  render();
}

function fmtHMS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function currentElapsedSeconds(): number {
  if (!active) return 0;
  if (active.is_running) {
    // Anchor on `elapsed_seconds` from the response (server's authoritative
    // total at fetch time) + client-side delta since then. The previous
    // implementation computed `accumulated + (Date.now() - last_started_at)`
    // which baked in client-vs-server clock skew on every render.
    const sinceFetch = Math.max(0, (Date.now() - activeFetchedAtMs) / 1000);
    return activeElapsedAtFetchSeconds + sinceFetch;
  }
  return active.accumulated_seconds;
}

function render(): void {
  const seconds = currentElapsedSeconds();
  const running = !!(active && active.is_running);

  // Analog clock face (primary visual).
  clockEl.innerHTML = renderAnalogClockSvg({ seconds, running, catSkin });

  // Digital readout (secondary, for precise reading).
  displayEl.textContent = fmtHMS(seconds);
  displayEl.classList.toggle("paused", !running);

  // Today's accumulated work time (pomodoro + stopwatch). Server-computed
  // baseline counts only ENDED sessions; while a stopwatch is active
  // (running or paused) its in-progress minutes aren't in the baseline
  // yet, so add them locally for a live, accurate readout.
  if (todayEl) {
    const live = active ? Math.floor(seconds / 60) : 0;
    const focus = active?.work_label ? ` · ${active.work_label}` : "";
    todayEl.textContent = `Today: ${fmtMinutes(getTodayWorkMinutes() + live)}${focus}`;
  }
  if (focusInput) focusInput.disabled = !!active;

  if (!active) {
    startBtn.textContent = "▶ Start";
    startBtn.disabled = pomodoroBlocking;
    startBtn.title = pomodoroBlocking
      ? "Stop the pomodoro first to start a stopwatch"
      : "Start the stopwatch";
    endBtn.disabled = true;
    return;
  }
  if (running) {
    startBtn.textContent = "⏸ Pause";
    startBtn.disabled = false;
    startBtn.title = "Pause the stopwatch";
  } else {
    startBtn.textContent = "▶ Resume";
    startBtn.disabled = pomodoroBlocking;
    startBtn.title = pomodoroBlocking
      ? "Stop the pomodoro first"
      : "Resume the stopwatch";
  }
  endBtn.disabled = false;
}

function startTicking(): void {
  if (tickIntervalId !== null) return;
  tickIntervalId = setInterval(() => render(), 500);
}

function stopTicking(): void {
  if (tickIntervalId !== null) {
    clearInterval(tickIntervalId);
    tickIntervalId = null;
  }
}

function setActive(s: StopwatchSessionRead | null): void {
  active = s;
  // Snapshot the server's authoritative elapsed total and the moment we
  // observed it. The tick will extrapolate from this baseline rather than
  // recomputing from `last_started_at` (which is server-clock relative).
  activeElapsedAtFetchSeconds = s ? s.elapsed_seconds : 0;
  activeFetchedAtMs = Date.now();
  if (s && s.is_running) startTicking();
  else stopTicking();
  // Picker selection follows active.linked_task_id (or pending when idle).
  void refreshTaskPickerUI();
  // Tell the rest of the app (specifically pomodoro view) whether to
  // disable its Start button.
  window.dispatchEvent(new CustomEvent("stopwatch:state", {
    detail: { active: !!s, running: !!(s && s.is_running) },
  }));
  render();
}

function parseDetail(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.body) as { detail?: string };
      if (parsed?.detail) return parsed.detail;
    } catch { /* fall through */ }
  }
  return "Could not contact server.";
}

// Guards against the user double-clicking Start/Pause while the network
// round-trip is in flight. Without this, two pause requests could fire,
// or a fast double-click on Start could race two startStopwatch() calls.
let inFlight = false;

async function onStartClick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  startBtn.disabled = true;
  setMessage(messageEl, "", "neutral");
  try {
    if (active === null) {
      const s = await startStopwatch(focusInput.value.trim(), pendingTaskId);
      setActive(s);
    } else if (active.is_running) {
      // Optimistic pause: freeze the displayed seconds immediately so the
      // UI feels responsive even if the server is slow. We fold the
      // running segment into accumulated_seconds locally; the server's
      // authoritative response then overwrites this.
      const sessionId = active.id;
      const frozen = Math.floor(currentElapsedSeconds());
      // Server caps accumulated at this value, so a slow pause request
      // won't credit time the user spent on break waiting for the network.
      const runningSegment = Math.max(0, frozen - active.accumulated_seconds);
      setActive({
        ...active,
        accumulated_seconds: frozen,
        last_started_at: null,
        is_running: false,
        elapsed_seconds: frozen,
      });
      const s = await pauseStopwatch(sessionId, runningSegment);
      setActive(s);
    } else {
      const s = await resumeStopwatch(active.id);
      setActive(s);
    }
  } catch (e) {
    // Roll back optimistic UI to server truth.
    try { setActive(await getActive()); } catch { /* keep current state */ }
    setMessage(messageEl, parseDetail(e), "error");
  } finally {
    inFlight = false;
    // render() inside setActive re-derives disabled from current state.
    render();
  }
}

export async function startForFocus(taskId: number | null, label: string): Promise<boolean> {
  if (active || inFlight) {
    setMessage(messageEl, "End the current stopwatch before starting another focus.", "error");
    return false;
  }
  pendingTaskId = taskId;
  focusInput.value = label;
  await onStartClick();
  return active !== null;
}

async function onEndClick(): Promise<void> {
  if (active === null) return;
  if (!window.confirm("End the stopwatch session? You'll earn XP equal to the minutes worked.")) return;
  setMessage(messageEl, "", "neutral");
  try {
    const finished = await endStopwatch(active.id);
    setActive(null);
    const minutes = Math.floor(finished.accumulated_seconds / 60);
    if (minutes > 0) {
      flashMessage(messageEl, `Session ended. +${minutes} XP`, "success");
      // Reuse the pomodoro completion bus: bounce the cat + refresh XP/streak.
      window.dispatchEvent(new CustomEvent("cat:cheer"));
    } else {
      flashMessage(messageEl, "Session ended (under 1 min, no XP).", "neutral");
    }
  } catch (e) {
    setMessage(messageEl, parseDetail(e), "error");
  }
}

export async function refresh(): Promise<void> {
  try {
    const s = await getActive();
    setActive(s);
  } catch (e) {
    console.error(e);
  }
}

async function refreshTaskPickerUI(): Promise<void> {
  if (taskPickerEl === null) return;
  // Two modes:
  //  - No active session → picker writes to `pendingTaskId`, picked up on Start.
  //  - Active session → picker PATCHes the running row mid-stream.
  // We rebuild the whole picker on every refresh because the task list
  // itself may have changed (user added/completed a task in tracker).
  const selectedId = active !== null ? active.linked_task_id : pendingTaskId;
  await renderTaskPicker({
    container: taskPickerEl,
    selectedTaskId: selectedId,
    label: active !== null ? "Working on" : "Working on",
    onChange: (taskId) => {
      if (active === null) {
        pendingTaskId = taskId;
        return;
      }
      // Optimistic local update so the dropdown reflects the choice
      // immediately even before the PATCH returns.
      active = { ...active, linked_task_id: taskId };
      void updateStopwatchTask(active.id, taskId).then(setActive);
    },
  });
}

export function init(initialCatSkin: string = "tabby"): void {
  catSkin = initialCatSkin;
  clockEl = document.querySelector<HTMLDivElement>("#stopwatch-clock")!;
  displayEl = document.querySelector<HTMLDivElement>("#stopwatch-display")!;
  todayEl = document.querySelector<HTMLParagraphElement>("#stopwatch-today")!;
  focusInput = document.querySelector<HTMLInputElement>("#stopwatch-focus-input")!;
  startBtn = document.querySelector<HTMLButtonElement>("#stopwatch-start-btn")!;
  endBtn = document.querySelector<HTMLButtonElement>("#stopwatch-end-btn")!;
  messageEl = document.querySelector<HTMLParagraphElement>("#stopwatch-message")!;
  taskPickerEl = document.querySelector<HTMLDivElement>("#stopwatch-task-picker");

  // The today-work line lives on a stale baseline until StatsView refreshes.
  // After each refresh, re-render so the line picks up the new value.
  window.addEventListener("progress:updated", () => render());

  // Task list may have changed in the tracker view; re-fetch + re-render.
  window.addEventListener("task-list:updated", () => void refreshTaskPickerUI());

  startBtn.addEventListener("click", () => void onStartClick());
  endBtn.addEventListener("click", () => void onEndClick());

  // Listen for pomodoro state — if pomodoro is active, our Start is locked.
  window.addEventListener("pomodoro:state", (e: Event) => {
    const ce = e as CustomEvent<{ active: boolean; running: boolean }>;
    pomodoroBlocking = !!(ce.detail?.active);
    render();
  });

  render();
  void refreshTaskPickerUI();
}
