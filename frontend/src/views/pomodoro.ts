/**
 * Pomodoro timer view.
 */

import { completeSession, listSessions, startSession, type PomodoroSessionRead } from "../api/pomodoro";
import { formatTime, setMessage } from "../utils";
import type { UserRead } from "../api/users";

const WORK_DURATION = 25 * 60;
const BREAK_DURATION = 5 * 60;

let pomodoroDisplay: HTMLDivElement;
let pomodoroStartButton: HTMLButtonElement;
let pomodoroResetButton: HTMLButtonElement;
let pomodoroModeBadge: HTMLSpanElement;
let pomodoroMessage: HTMLParagraphElement;
let pomodoroList: HTMLDivElement;

let sessions: PomodoroSessionRead[] = [];
let pomodoroMode: "work" | "break" = "work";
let pomodoroTimeLeft = WORK_DURATION;   // seconds remaining (updated on pause/reset)
let pomodoroEndTime: number | null = null; // Date.now() ms when timer should reach 0
let pomodoroRunning = false;
let pomodoroIntervalId: ReturnType<typeof setInterval> | null = null;
let activeSessionId: number | null = null;

export function render(currentUser: UserRead | null): void {
  pomodoroDisplay.textContent = formatTime(pomodoroTimeLeft);
  pomodoroStartButton.textContent = pomodoroRunning ? "⏸ Pause" : "▶ Start";
  pomodoroStartButton.classList.toggle("pomo-running", pomodoroRunning);
  pomodoroModeBadge.textContent = pomodoroMode === "work" ? "Work" : "Break";
  pomodoroModeBadge.className = `tag ${pomodoroMode === "work" ? "" : "tag-break"}`;

  if (!currentUser || sessions.length === 0) {
    pomodoroList.innerHTML = `<div class="empty-state">${currentUser ? "No sessions yet." : "Select a user first."}</div>`;
    return;
  }
  const todayCount = sessions.filter(
    (s) => s.is_completed && s.session_type === "work" &&
      new Date(s.started_at).toDateString() === new Date().toDateString(),
  ).length;
  pomodoroList.innerHTML = [
    `<p class="hint">Today: <strong>${todayCount}</strong> work session(s) completed</p>`,
    ...sessions.slice(0, 10).map((s) => `
      <div class="task-item">
        <span class="tag">${s.session_type === "work" ? "Work" : "Break"}</span>
        <span class="task-text ${s.is_completed ? "done" : ""}">${s.duration_minutes} min — ${s.is_completed ? "completed" : "in progress"}</span>
      </div>`),
  ].join("");
}

export async function refresh(currentUser: UserRead | null): Promise<void> {
  if (!currentUser) { sessions = []; render(null); return; }
  try {
    sessions = await listSessions(currentUser.id);
    render(currentUser);
  } catch (error) {
    console.error(error);
    setMessage(pomodoroMessage, "Could not load sessions.", "error");
  }
}

function stopTimer(): void {
  if (pomodoroIntervalId !== null) { clearInterval(pomodoroIntervalId); pomodoroIntervalId = null; }
  // Snapshot remaining time from wall clock so resume/reset uses accurate value
  if (pomodoroEndTime !== null) {
    pomodoroTimeLeft = Math.max(0, Math.ceil((pomodoroEndTime - Date.now()) / 1000));
  }
  pomodoroRunning = false;
}

export function init(onDataChanged: () => Promise<void>): void {
  pomodoroDisplay = document.querySelector<HTMLDivElement>("#pomodoro-display")!;
  pomodoroStartButton = document.querySelector<HTMLButtonElement>("#pomodoro-start-button")!;
  pomodoroResetButton = document.querySelector<HTMLButtonElement>("#pomodoro-reset-button")!;
  pomodoroModeBadge = document.querySelector<HTMLSpanElement>("#pomodoro-mode-badge")!;
  pomodoroMessage = document.querySelector<HTMLParagraphElement>("#pomodoro-message")!;
  pomodoroList = document.querySelector<HTMLDivElement>("#pomodoro-list")!;

  async function onComplete(): Promise<void> {
    stopTimer();
    if (activeSessionId !== null) {
      const { getCurrentUser } = await import("../views/users");
      const user = getCurrentUser();
      if (user) {
        try {
          await completeSession(activeSessionId);
          activeSessionId = null;
          const msg = pomodoroMode === "work" ? "Work session done! +25 XP" : "Break over!";
          setMessage(pomodoroMessage, msg, "success");
          await onDataChanged();
        } catch (error) { console.error(error); }
      }
    }
    pomodoroMode = pomodoroMode === "work" ? "break" : "work";
    pomodoroTimeLeft = pomodoroMode === "work" ? WORK_DURATION : BREAK_DURATION;
    render(null);
  }

  pomodoroStartButton.addEventListener("click", async () => {
    const { getCurrentUser } = await import("../views/users");
    const user = getCurrentUser();
    if (!user) { setMessage(pomodoroMessage, "Select a user first.", "error"); return; }
    if (pomodoroRunning) { stopTimer(); render(user); return; }
    if (activeSessionId === null) {
      try {
        const s = await startSession(user.id, pomodoroMode, pomodoroMode === "work" ? 25 : 5);
        activeSessionId = s.id;
      } catch (error) { console.error(error); setMessage(pomodoroMessage, "Could not start session.", "error"); return; }
    }
    // Set absolute end time from current remaining seconds
    pomodoroEndTime = Date.now() + pomodoroTimeLeft * 1000;
    pomodoroRunning = true;
    pomodoroIntervalId = setInterval(async () => {
      pomodoroTimeLeft = Math.max(0, Math.ceil((pomodoroEndTime! - Date.now()) / 1000));
      pomodoroDisplay.textContent = formatTime(pomodoroTimeLeft);
      if (pomodoroTimeLeft <= 0) await onComplete();
    }, 500); // poll at 500ms so display stays crisp even after background throttling
    render(user);
  });

  pomodoroResetButton.addEventListener("click", () => {
    stopTimer(); activeSessionId = null; pomodoroMode = "work";
    pomodoroTimeLeft = WORK_DURATION; pomodoroEndTime = null;
    setMessage(pomodoroMessage, "", "neutral"); render(null);
  });

  // When user returns to this tab, immediately sync display to wall clock
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && pomodoroRunning && pomodoroEndTime !== null) {
      pomodoroTimeLeft = Math.max(0, Math.ceil((pomodoroEndTime - Date.now()) / 1000));
      pomodoroDisplay.textContent = formatTime(pomodoroTimeLeft);
      if (pomodoroTimeLeft <= 0) await onComplete();
    }
  });

}
