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
import { flashMessage, fmtMinutes, parseApiDate, setMessage } from "../utils";
import { renderAnalogClockSvg } from "./clock";
import { getTodayWorkMinutes } from "./stats";

let clockEl: HTMLDivElement;       // analog clock SVG container
let displayEl: HTMLDivElement;     // digital readout below the clock
let todayEl: HTMLParagraphElement; // "Today: Xh Ym" hint line
let startBtn: HTMLButtonElement;
let endBtn: HTMLButtonElement;
let messageEl: HTMLParagraphElement;

let active: StopwatchSessionRead | null = null;
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
    todayEl.textContent = `Today: ${fmtMinutes(getTodayWorkMinutes() + live)}`;
  }

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
      const s = await startStopwatch();
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

export function init(initialCatSkin: string = "tabby"): void {
  catSkin = initialCatSkin;
  clockEl = document.querySelector<HTMLDivElement>("#stopwatch-clock")!;
  displayEl = document.querySelector<HTMLDivElement>("#stopwatch-display")!;
  todayEl = document.querySelector<HTMLParagraphElement>("#stopwatch-today")!;
  startBtn = document.querySelector<HTMLButtonElement>("#stopwatch-start-btn")!;
  endBtn = document.querySelector<HTMLButtonElement>("#stopwatch-end-btn")!;
  messageEl = document.querySelector<HTMLParagraphElement>("#stopwatch-message")!;

  // The today-work line lives on a stale baseline until StatsView refreshes.
  // After each refresh, re-render so the line picks up the new value.
  window.addEventListener("progress:updated", () => render());

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
