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
  type StopwatchSessionRead,
} from "../api/stopwatch";
import { parseApiDate, setMessage } from "../utils";

let displayEl: HTMLDivElement;
let startBtn: HTMLButtonElement;
let endBtn: HTMLButtonElement;
let messageEl: HTMLParagraphElement;

let active: StopwatchSessionRead | null = null;
let tickIntervalId: ReturnType<typeof setInterval> | null = null;
// True when a pomodoro is currently running locally; blocks Start.
let pomodoroBlocking = false;

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
  if (active.is_running && active.last_started_at) {
    // SQLite drops timezone info → server timestamps are naive UTC. Use
    // parseApiDate so JS doesn't interpret them as local time (which
    // would cause a tz-offset-sized jump on Start, e.g. +2h in CEST).
    const startedMs = parseApiDate(active.last_started_at).getTime();
    const sinceResume = Math.max(0, (Date.now() - startedMs) / 1000);
    return active.accumulated_seconds + sinceResume;
  }
  return active.accumulated_seconds;
}

function render(): void {
  displayEl.textContent = fmtHMS(currentElapsedSeconds());

  if (!active) {
    startBtn.textContent = "▶ Start";
    startBtn.disabled = pomodoroBlocking;
    startBtn.title = pomodoroBlocking
      ? "Stop the pomodoro first to start a stopwatch"
      : "Start the stopwatch";
    endBtn.disabled = true;
    displayEl.classList.remove("running");
    return;
  }
  if (active.is_running) {
    startBtn.textContent = "⏸ Pause";
    startBtn.disabled = false;
    startBtn.title = "Pause the stopwatch";
    displayEl.classList.add("running");
  } else {
    startBtn.textContent = "▶ Resume";
    startBtn.disabled = pomodoroBlocking;
    startBtn.title = pomodoroBlocking
      ? "Stop the pomodoro first"
      : "Resume the stopwatch";
    displayEl.classList.remove("running");
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
  if (s && s.is_running) startTicking();
  else stopTicking();
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

async function onStartClick(): Promise<void> {
  setMessage(messageEl, "", "neutral");
  try {
    if (active === null) {
      const s = await startStopwatch();
      setActive(s);
    } else if (active.is_running) {
      const s = await pauseStopwatch(active.id);
      setActive(s);
    } else {
      const s = await resumeStopwatch(active.id);
      setActive(s);
    }
  } catch (e) {
    setMessage(messageEl, parseDetail(e), "error");
  }
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
      setMessage(messageEl, `Session ended. +${minutes} XP`, "success");
      // Reuse the pomodoro completion bus: bounce the cat + refresh XP/streak.
      window.dispatchEvent(new CustomEvent("cat:cheer"));
    } else {
      setMessage(messageEl, "Session ended (under 1 min, no XP).", "neutral");
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

export function init(): void {
  displayEl = document.querySelector<HTMLDivElement>("#stopwatch-display")!;
  startBtn = document.querySelector<HTMLButtonElement>("#stopwatch-start-btn")!;
  endBtn = document.querySelector<HTMLButtonElement>("#stopwatch-end-btn")!;
  messageEl = document.querySelector<HTMLParagraphElement>("#stopwatch-message")!;

  startBtn.addEventListener("click", () => void onStartClick());
  endBtn.addEventListener("click", () => void onEndClick());

  // Listen for pomodoro state — if pomodoro is active, our Start is locked.
  window.addEventListener("pomodoro:state", (e: Event) => {
    const ce = e as CustomEvent<{ active: boolean; running: boolean }>;
    pomodoroBlocking = !!(ce.detail?.active);
    render();
  });

  render();
}
