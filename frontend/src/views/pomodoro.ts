/**
 * Pomodoro timer view.
 */

import { completeSession, listSessions, startSession, type PomodoroSessionRead } from "../api/pomodoro";
import { updateMe, type UserRead } from "../api/users";
import { formatTime, setMessage } from "../utils";

type Mode = "work" | "short_break" | "long_break";

let pomodoroDisplay: HTMLDivElement;
let pomodoroStartButton: HTMLButtonElement;
let pomodoroResetButton: HTMLButtonElement;
let pomodoroModeBadge: HTMLSpanElement;
let pomodoroMessage: HTMLParagraphElement;
let pomodoroList: HTMLDivElement;
let settingsToggle: HTMLButtonElement;
let settingsPanel: HTMLDivElement;
let settingsForm: HTMLFormElement;
let settingsWorkInput: HTMLInputElement;
let settingsShortInput: HTMLInputElement;
let settingsLongInput: HTMLInputElement;
let settingsBeforeLongInput: HTMLInputElement;
let settingsMessage: HTMLParagraphElement;
let modeHintEl: HTMLParagraphElement;

let user: UserRead | null = null;
let sessions: PomodoroSessionRead[] = [];
let pomodoroMode: Mode = "work";
let pomodoroTimeLeft = 25 * 60;             // seconds remaining
let pomodoroEndTime: number | null = null;  // wall-clock end (ms)
let pomodoroRunning = false;
let pomodoroIntervalId: ReturnType<typeof setInterval> | null = null;
let activeSessionId: number | null = null;

function workSeconds():       number { return (user?.pomodoro_work_minutes        ?? 25) * 60; }
function shortBreakSeconds(): number { return (user?.pomodoro_short_break_minutes ??  5) * 60; }
function longBreakSeconds():  number { return (user?.pomodoro_long_break_minutes  ?? 15) * 60; }
function sessionsBeforeLong(): number { return user?.pomodoro_sessions_before_long_break ?? 4; }

function todayCompletedWorkCount(): number {
  const today = new Date().toDateString();
  return sessions.filter(
    (s) => s.is_completed && s.session_type === "work" &&
      new Date(s.started_at).toDateString() === today,
  ).length;
}

function nextBreakMode(): Mode {
  // After completing the Nth work session of the day, take a long break.
  const completedToday = todayCompletedWorkCount();
  return completedToday > 0 && completedToday % sessionsBeforeLong() === 0
    ? "long_break"
    : "short_break";
}

function modeDurationSeconds(m: Mode): number {
  if (m === "work")        return workSeconds();
  if (m === "long_break")  return longBreakSeconds();
  return shortBreakSeconds();
}

function modeLabel(m: Mode): string {
  if (m === "work")        return "Work";
  if (m === "long_break")  return "Long break";
  return "Short break";
}

// Pomodoro session is recorded as "work" or "break" in the backend (current
// schema). We treat both short and long breaks as session_type="break".
function modeApiType(m: Mode): "work" | "break" {
  return m === "work" ? "work" : "break";
}

export function render(): void {
  pomodoroDisplay.textContent = formatTime(pomodoroTimeLeft);
  pomodoroStartButton.textContent = pomodoroRunning ? "⏸ Pause" : "▶ Start";
  pomodoroStartButton.classList.toggle("pomo-running", pomodoroRunning);
  pomodoroModeBadge.textContent = modeLabel(pomodoroMode);
  pomodoroModeBadge.className = `tag ${pomodoroMode === "work" ? "" : "tag-break"}`;

  if (modeHintEl) {
    const completedToday = todayCompletedWorkCount();
    const untilLong = sessionsBeforeLong() - (completedToday % sessionsBeforeLong());
    modeHintEl.textContent =
      `${workSeconds() / 60} min work · ${shortBreakSeconds() / 60} min short break · ` +
      `${longBreakSeconds() / 60} min long break every ${sessionsBeforeLong()} ` +
      `(next long break in ${untilLong === sessionsBeforeLong() ? sessionsBeforeLong() : untilLong} work session${untilLong === 1 ? "" : "s"})`;
  }

  if (sessions.length === 0) {
    pomodoroList.innerHTML = `<div class="empty-state">No sessions yet.</div>`;
    return;
  }
  pomodoroList.innerHTML = [
    `<p class="hint">Today: <strong>${todayCompletedWorkCount()}</strong> work session(s) completed</p>`,
    ...sessions.slice(0, 10).map((s) => `
      <div class="task-item">
        <span class="tag">${s.session_type === "work" ? "Work" : "Break"}</span>
        <span class="task-text ${s.is_completed ? "done" : ""}">${s.duration_minutes} min — ${s.is_completed ? "completed" : "in progress"}</span>
      </div>`),
  ].join("");
}

function renderSettings(): void {
  if (!user) return;
  settingsWorkInput.value       = String(user.pomodoro_work_minutes);
  settingsShortInput.value      = String(user.pomodoro_short_break_minutes);
  settingsLongInput.value       = String(user.pomodoro_long_break_minutes);
  settingsBeforeLongInput.value = String(user.pomodoro_sessions_before_long_break);
}

/** Called from main.ts when the authenticated user is available / changes. */
export function setUser(currentUser: UserRead): void {
  user = currentUser;
  // If timer is idle, sync the displayed duration to the new settings.
  if (!pomodoroRunning && activeSessionId === null) {
    pomodoroTimeLeft = modeDurationSeconds(pomodoroMode);
  }
  renderSettings();
  render();
}

export async function refresh(): Promise<void> {
  try {
    sessions = await listSessions();
    render();
  } catch (error) {
    console.error(error);
    setMessage(pomodoroMessage, "Could not load sessions.", "error");
  }
}

function stopTimer(): void {
  if (pomodoroIntervalId !== null) { clearInterval(pomodoroIntervalId); pomodoroIntervalId = null; }
  if (pomodoroEndTime !== null) {
    pomodoroTimeLeft = Math.max(0, Math.ceil((pomodoroEndTime - Date.now()) / 1000));
  }
  pomodoroRunning = false;
}

export function init(onDataChanged: () => Promise<void>): void {
  pomodoroDisplay        = document.querySelector<HTMLDivElement>("#pomodoro-display")!;
  pomodoroStartButton    = document.querySelector<HTMLButtonElement>("#pomodoro-start-button")!;
  pomodoroResetButton    = document.querySelector<HTMLButtonElement>("#pomodoro-reset-button")!;
  pomodoroModeBadge      = document.querySelector<HTMLSpanElement>("#pomodoro-mode-badge")!;
  pomodoroMessage        = document.querySelector<HTMLParagraphElement>("#pomodoro-message")!;
  pomodoroList           = document.querySelector<HTMLDivElement>("#pomodoro-list")!;
  settingsToggle         = document.querySelector<HTMLButtonElement>("#pomodoro-settings-toggle")!;
  settingsPanel          = document.querySelector<HTMLDivElement>("#pomodoro-settings-panel")!;
  settingsForm           = document.querySelector<HTMLFormElement>("#pomodoro-settings-form")!;
  settingsWorkInput      = document.querySelector<HTMLInputElement>("#pomodoro-setting-work")!;
  settingsShortInput     = document.querySelector<HTMLInputElement>("#pomodoro-setting-short")!;
  settingsLongInput      = document.querySelector<HTMLInputElement>("#pomodoro-setting-long")!;
  settingsBeforeLongInput= document.querySelector<HTMLInputElement>("#pomodoro-setting-before-long")!;
  settingsMessage        = document.querySelector<HTMLParagraphElement>("#pomodoro-settings-message")!;
  modeHintEl             = document.querySelector<HTMLParagraphElement>("#pomodoro-mode-hint")!;

  async function onComplete(): Promise<void> {
    stopTimer();
    if (activeSessionId !== null) {
      try {
        await completeSession(activeSessionId);
        activeSessionId = null;
        const msg = pomodoroMode === "work" ? "Work session done! +25 XP" : `${modeLabel(pomodoroMode)} over!`;
        setMessage(pomodoroMessage, msg, "success");
        await onDataChanged();
      } catch (error) { console.error(error); }
    }
    // Cycle: work → (long_break if N-th, else short_break) → work → ...
    pomodoroMode = pomodoroMode === "work" ? nextBreakMode() : "work";
    pomodoroTimeLeft = modeDurationSeconds(pomodoroMode);
    render();
  }

  pomodoroStartButton.addEventListener("click", async () => {
    if (pomodoroRunning) { stopTimer(); render(); return; }
    if (activeSessionId === null) {
      try {
        const s = await startSession(modeApiType(pomodoroMode), modeDurationSeconds(pomodoroMode) / 60);
        activeSessionId = s.id;
      } catch (error) { console.error(error); setMessage(pomodoroMessage, "Could not start session.", "error"); return; }
    }
    pomodoroEndTime = Date.now() + pomodoroTimeLeft * 1000;
    pomodoroRunning = true;
    pomodoroIntervalId = setInterval(async () => {
      pomodoroTimeLeft = Math.max(0, Math.ceil((pomodoroEndTime! - Date.now()) / 1000));
      pomodoroDisplay.textContent = formatTime(pomodoroTimeLeft);
      if (pomodoroTimeLeft <= 0) await onComplete();
    }, 500);
    render();
  });

  pomodoroResetButton.addEventListener("click", () => {
    stopTimer(); activeSessionId = null; pomodoroMode = "work";
    pomodoroTimeLeft = modeDurationSeconds("work"); pomodoroEndTime = null;
    setMessage(pomodoroMessage, "", "neutral"); render();
  });

  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && pomodoroRunning && pomodoroEndTime !== null) {
      pomodoroTimeLeft = Math.max(0, Math.ceil((pomodoroEndTime - Date.now()) / 1000));
      pomodoroDisplay.textContent = formatTime(pomodoroTimeLeft);
      if (pomodoroTimeLeft <= 0) await onComplete();
    }
  });

  settingsToggle.addEventListener("click", () => {
    settingsPanel.classList.toggle("hidden");
  });

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const work       = Number(settingsWorkInput.value);
    const shortBrk   = Number(settingsShortInput.value);
    const longBrk    = Number(settingsLongInput.value);
    const beforeLong = Number(settingsBeforeLongInput.value);

    const errors: string[] = [];
    if (!(work >= 1 && work <= 240))         errors.push("Work: 1-240 min");
    if (!(shortBrk >= 1 && shortBrk <= 60))  errors.push("Short break: 1-60 min");
    if (!(longBrk >= 1 && longBrk <= 60))    errors.push("Long break: 1-60 min");
    if (!(beforeLong >= 1 && beforeLong <= 10)) errors.push("Sessions before long break: 1-10");
    if (errors.length) {
      setMessage(settingsMessage, errors.join(" · "), "error");
      return;
    }

    try {
      const updated = await updateMe({
        pomodoro_work_minutes: work,
        pomodoro_short_break_minutes: shortBrk,
        pomodoro_long_break_minutes: longBrk,
        pomodoro_sessions_before_long_break: beforeLong,
      });
      setUser(updated);
      setMessage(settingsMessage, "Settings saved.", "success");
    } catch (error) {
      console.error(error);
      setMessage(settingsMessage, "Could not save settings.", "error");
    }
  });
}
