/**
 * Pomodoro timer view.
 *
 * Features beyond a basic timer:
 *  - Cycle work → short break → work → ... → long break (every Nth) → work
 *  - Audible beep + browser Notification when a phase ends
 *  - Auto-start the next phase so the user doesn't have to click between
 *    sessions (the whole point of pomodoro is uninterrupted flow)
 *  - Per-user configurable durations (work/short/long/sessions-before-long)
 *    persisted via PATCH /users/me
 *  - Delete past sessions from the history list
 */

import { completeSession, deleteSession, listSessions, startSession, type PomodoroSessionRead } from "../api/pomodoro";
import { renderTaskPicker } from "./taskPicker";
import { updateMe, type UserRead } from "../api/users";
import { escapeHtml, flashMessage, fmtMinutes, formatTime, parseApiDate, setMessage } from "../utils";
import { renderEmptyStateWithCat } from "./icons";
import { getTodayWorkMinutes } from "./stats";
import { renderAnalogClockSvg } from "./clock";
import { getMode as getTimerMode } from "./timerMode";

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
let settingsAutoStartInput: HTMLInputElement | null;
let settingsMessage: HTMLParagraphElement;
let modeHintEl: HTMLParagraphElement;

let user: UserRead | null = null;
let catSkin = "tabby";
let clockEl: HTMLDivElement | null = null;

/** Called from main.ts when the user picks a new avatar so the pomodoro
 *  side of the shared pixel clock stays color-matched. */
export function setCatSkin(skin: string): void {
  catSkin = skin;
  if (getTimerMode() === "pomodoro") renderClock();
}

/** Inner-tick update — runs at 500 ms inside the running interval and on
 *  visibility-change. Cheaper than the full render(): only refreshes the
 *  digital display and the pixel-clock SVG, not the buttons / history list. */
function tickDisplay(): void {
  pomodoroDisplay.textContent = formatTime(pomodoroTimeLeft);
  if (getTimerMode() === "pomodoro") renderClock();
}

function renderClock(): void {
  if (!clockEl) clockEl = document.querySelector<HTMLDivElement>("#stopwatch-clock");
  if (!clockEl) return;
  // Elapsed within the current phase — hands sweep forward as the phase
  // progresses. Idle (no session) → 0s, paused color.
  const total = modeDurationSeconds(pomodoroMode);
  const elapsed = pomodoroRunning ? Math.max(0, total - pomodoroTimeLeft) : 0;
  clockEl.innerHTML = renderAnalogClockSvg({
    seconds: elapsed,
    running: pomodoroRunning,
    catSkin,
  });
}
let sessions: PomodoroSessionRead[] = [];
let pomodoroMode: Mode = "work";
let pomodoroTimeLeft = 25 * 60;
let pomodoroEndTime: number | null = null;
let pomodoroRunning = false;
// True while the user has an active (in-progress) work pomodoro on the
// server — used to mutex with the stopwatch (frontend hint; backend also
// enforces). "Active" = either running locally OR the server has an
// open session that resume-on-refresh will pick up.
let pomodoroActive = false;

function broadcastPomodoroState(): void {
  pomodoroActive = activeSessionId !== null || pomodoroRunning;
  window.dispatchEvent(new CustomEvent("pomodoro:state", {
    detail: { active: pomodoroActive, running: pomodoroRunning },
  }));
  // Picker enable/disable mirrors session-in-progress state; refresh
  // is cheap (cached task list, no network).
  void refreshTaskPickerUI();
}

// True if the stopwatch view has told us a session is running on the server.
let stopwatchBlocking = false;

async function refreshTaskPickerUI(): Promise<void> {
  if (taskPickerEl === null) return;
  // Disable picker while a session is in flight — pomodoro is commit-and-go,
  // unlike stopwatch's "discover what I'm doing" model. To change tasks
  // mid-pomodoro: Reset → pick → Start.
  await renderTaskPicker({
    container: taskPickerEl,
    selectedTaskId: pendingTaskId,
    label: "Focus",
    disabled: activeSessionId !== null,
    onChange: (taskId) => { pendingTaskId = taskId; },
  });
}

function updateStartButtonLock(): void {
  // Centralised disable rule. Called from both the stopwatch:state listener
  // AND `render()` so the button state stays correct after local actions
  // (Reset, onComplete, etc.) — not just after stopwatch events.
  if (typeof pomodoroStartButton === "undefined" || !pomodoroStartButton) return;
  // Lock only when we'd actually fire a server `startSession` on the next
  // click: idle pomodoro (no in-progress session, not running) AND a
  // stopwatch is active server-side. Pause / Resume of an existing session
  // doesn't hit the mutex, so we leave the button alone in those states.
  const wouldHitMutex = stopwatchBlocking && !pomodoroRunning && activeSessionId === null;
  pomodoroStartButton.disabled = wouldHitMutex;
  pomodoroStartButton.title = wouldHitMutex
    ? "Stop the work timer first to start a pomodoro"
    : "";
}

window.addEventListener("stopwatch:state", (e: Event) => {
  const ce = e as CustomEvent<{ active: boolean; running: boolean }>;
  stopwatchBlocking = !!(ce.detail?.active);
  updateStartButtonLock();
});
let pomodoroIntervalId: ReturnType<typeof setInterval> | null = null;
let activeSessionId: number | null = null;
let onDataChangedCb: (() => Promise<void>) | null = null;
let taskPickerEl: HTMLDivElement | null = null;
// Stages the user's task choice between picker change and Start click.
// Once a work session is in progress, this is no longer the source of
// truth — the server row's linked_task_id is. Pomodoro doesn't support
// mid-session retag (unlike stopwatch); use Reset to redo.
let pendingTaskId: number | null = null;

// User preference, persisted in localStorage. Default ON so the cycle is
// usable without configuration. Toggle in the settings panel.
const AUTO_START_KEY = "nl_pomodoro_auto_start";
function getAutoStart(): boolean {
  const raw = localStorage.getItem(AUTO_START_KEY);
  return raw === null ? true : raw === "1";
}
function setAutoStart(value: boolean): void {
  localStorage.setItem(AUTO_START_KEY, value ? "1" : "0");
}

function workSeconds():        number { return (user?.pomodoro_work_minutes        ?? 25) * 60; }
function shortBreakSeconds():  number { return (user?.pomodoro_short_break_minutes ??  5) * 60; }
function longBreakSeconds():   number { return (user?.pomodoro_long_break_minutes  ?? 15) * 60; }
function sessionsBeforeLong(): number { return user?.pomodoro_sessions_before_long_break ?? 4; }

function todayCompletedWorkCount(): number {
  const today = new Date().toDateString();
  return sessions.filter(
    (s) => s.is_completed && s.session_type === "work" &&
      parseApiDate(s.started_at).toDateString() === today,
  ).length;
}

// `justFinishedWork` accounts for a work session that has just ended but
// hasn't been persisted/refetched yet, so the count reflects it.
function nextBreakMode(justFinishedWork: boolean = false): Mode {
  const completedToday = todayCompletedWorkCount() + (justFinishedWork ? 1 : 0);
  return completedToday > 0 && completedToday % sessionsBeforeLong() === 0
    ? "long_break"
    : "short_break";
}

function modeDurationSeconds(m: Mode): number {
  if (m === "work")       return workSeconds();
  if (m === "long_break") return longBreakSeconds();
  return shortBreakSeconds();
}

function modeLabel(m: Mode): string {
  if (m === "work")       return "Work";
  if (m === "long_break") return "Long break";
  return "Short break";
}

function modeApiType(m: Mode): "work" | "break" {
  return m === "work" ? "work" : "break";
}

// --- Notifications & sounds -------------------------------------------------

let audioCtx: AudioContext | null = null;

function beep(durationMs: number = 350, frequency: number = 880): void {
  try {
    if (!audioCtx) {
      const Ctx = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      audioCtx = new Ctx();
    }
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.value = 0.001;
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000 + 0.05);
  } catch (e) {
    console.warn("Audio cue failed", e);
  }
}

function notify(title: string, body: string): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "granted") {
    try { new Notification(title, { body }); } catch (e) { console.warn(e); }
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then((perm) => {
      if (perm === "granted") {
        try { new Notification(title, { body }); } catch (e) { console.warn(e); }
      }
    });
  }
}

function celebrate(modeFinished: Mode, nextMode: Mode): void {
  // 2 short beeps so it's clearly different from a single timer tick
  beep(300, modeFinished === "work" ? 660 : 880);
  setTimeout(() => beep(300, modeFinished === "work" ? 880 : 660), 380);
  const title = modeFinished === "work" ? "Work session done!" : `${modeLabel(modeFinished)} over!`;
  const body  = `Time for a ${modeLabel(nextMode).toLowerCase()}.`;
  notify(title, body);
}

// --- Render -----------------------------------------------------------------

export function render(): void {
  pomodoroDisplay.textContent = formatTime(pomodoroTimeLeft);
  if (getTimerMode() === "pomodoro") renderClock();
  pomodoroStartButton.textContent = pomodoroRunning ? "⏸ Pause" : "▶ Start";
  pomodoroStartButton.classList.toggle("pomo-running", pomodoroRunning);
  // Re-evaluate the mutex lock on every render so Reset / Complete / etc.
  // promptly reflect the current "would clicking Start hit the server?"
  // answer without waiting for the next stopwatch:state event.
  updateStartButtonLock();
  pomodoroModeBadge.textContent = modeLabel(pomodoroMode);
  pomodoroModeBadge.className = `tag ${pomodoroMode === "work" ? "" : "tag-break"}`;

  if (modeHintEl) {
    const completedToday = todayCompletedWorkCount();
    const remainderInCycle = completedToday % sessionsBeforeLong();
    const untilLong = remainderInCycle === 0 && completedToday > 0 ? sessionsBeforeLong()
                    : sessionsBeforeLong() - remainderInCycle;
    modeHintEl.textContent =
      `${workSeconds() / 60} min work · ${shortBreakSeconds() / 60} min short break · ` +
      `${longBreakSeconds() / 60} min long break every ${sessionsBeforeLong()} ` +
      `(next long break in ${untilLong} work session${untilLong === 1 ? "" : "s"})`;
  }

  // History list shows today's sessions only; older sessions stay in the
  // backend (used for stats and historical analysis) but aren't rendered here.
  const today = new Date().toDateString();
  const todaySessions = sessions.filter(
    (s) => parseApiDate(s.started_at).toDateString() === today,
  );

  if (todaySessions.length === 0) {
    pomodoroList.innerHTML = renderEmptyStateWithCat("No sessions today yet.");
    return;
  }
  pomodoroList.innerHTML = [
    `<p class="hint">Today: <strong>${todayCompletedWorkCount()}</strong> work session(s) · <strong>${fmtMinutes(getTodayWorkMinutes())}</strong> work time</p>`,
    ...todaySessions.map((s) => {
      const when = parseApiDate(s.started_at).toLocaleString(undefined,
        { hour: "2-digit", minute: "2-digit" });
      return `
      <div class="task-item">
        <span class="tag">${s.session_type === "work" ? "Work" : "Break"}</span>
        <span class="task-text ${s.is_completed ? "done" : ""}">${s.duration_minutes} min · ${when} · ${s.is_completed ? "completed" : "in progress"}${s.work_label ? ` · ${escapeHtml(s.work_label)}` : ""}</span>
        <button class="task-delete" data-pomo-action="delete" data-id="${s.id}" title="Delete session">×</button>
      </div>`;
    }),
  ].join("");
}

function renderSettings(): void {
  if (!user) return;
  settingsWorkInput.value       = String(user.pomodoro_work_minutes);
  settingsShortInput.value      = String(user.pomodoro_short_break_minutes);
  settingsLongInput.value       = String(user.pomodoro_long_break_minutes);
  settingsBeforeLongInput.value = String(user.pomodoro_sessions_before_long_break);
  if (settingsAutoStartInput) settingsAutoStartInput.checked = getAutoStart();
}

export function setUser(currentUser: UserRead): void {
  user = currentUser;
  if (!pomodoroRunning && activeSessionId === null) {
    pomodoroTimeLeft = modeDurationSeconds(pomodoroMode);
  }
  renderSettings();
  render();
}

// If the server still holds an in-progress session (e.g. user refreshed the
// page or closed the tab mid-pomodoro), pick it back up so the countdown
// continues from `started_at + duration` instead of leaving an orphan
// "in progress" row in the history.
async function resumeIfInProgress(): Promise<void> {
  // Only attempt on a cold local state; if a timer is already running we
  // must not stomp on it.
  if (pomodoroRunning || activeSessionId !== null) return;

  const inProgress = sessions
    .filter((s) => !s.is_completed)
    .sort((a, b) => parseApiDate(b.started_at).getTime() - parseApiDate(a.started_at).getTime());
  if (inProgress.length === 0) return;

  const active = inProgress[0];
  // Defensive: delete any older orphans so the list stays clean.
  for (let i = 1; i < inProgress.length; i++) {
    try { await deleteSession(inProgress[i].id); } catch (e) { console.warn(e); }
  }

  const startMs = parseApiDate(active.started_at).getTime();
  const durationMs = active.duration_minutes * 60_000;
  const elapsedMs = Date.now() - startMs;
  const graceMs = 5 * 60_000;

  // Abandoned long ago — discard without awarding XP.
  if (elapsedMs >= durationMs + graceMs) {
    try { await deleteSession(active.id); } catch (e) { console.warn(e); }
    return;
  }

  activeSessionId = active.id;
  pendingTaskId = active.linked_task_id;
  broadcastPomodoroState();
  if (active.session_type === "work") {
    pomodoroMode = "work";
  } else {
    // session_type stored only as "work"|"break"; recover short vs long
    // from the duration the user had configured at start time.
    pomodoroMode = active.duration_minutes === longBreakSeconds() / 60
      ? "long_break"
      : "short_break";
  }

  // Within grace but past the duration → auto-complete as if it just ended.
  if (elapsedMs >= durationMs) {
    pomodoroTimeLeft = 0;
    await onComplete();
    return;
  }

  // Still ticking — resume the countdown silently. No new startSession call
  // because the server row already exists.
  pomodoroTimeLeft = Math.ceil((durationMs - elapsedMs) / 1000);
  pomodoroEndTime = Date.now() + pomodoroTimeLeft * 1000;
  pomodoroRunning = true;
  broadcastPomodoroState();
  pomodoroIntervalId = setInterval(async () => {
    pomodoroTimeLeft = Math.max(0, Math.ceil((pomodoroEndTime! - Date.now()) / 1000));
    tickDisplay();
    if (pomodoroTimeLeft <= 0) await onComplete();
  }, 500);
  setMessage(pomodoroMessage, "Resumed session in progress.", "neutral");
}

export async function refresh(): Promise<void> {
  try {
    sessions = await listSessions();
    await resumeIfInProgress();
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
  broadcastPomodoroState();
}

async function startCurrentMode(): Promise<void> {
  if (activeSessionId === null) {
    try {
      const s = await startSession(
        modeApiType(pomodoroMode),
        modeDurationSeconds(pomodoroMode) / 60,
        "",
        pomodoroMode === "work" ? pendingTaskId : null,
      );
      activeSessionId = s.id;
    } catch (error) {
      console.error(error);
      setMessage(pomodoroMessage, "Could not start session.", "error");
      return;
    }
  }
  pomodoroEndTime = Date.now() + pomodoroTimeLeft * 1000;
  pomodoroRunning = true;
  broadcastPomodoroState();
  pomodoroIntervalId = setInterval(async () => {
    pomodoroTimeLeft = Math.max(0, Math.ceil((pomodoroEndTime! - Date.now()) / 1000));
    tickDisplay();
    if (pomodoroTimeLeft <= 0) await onComplete();
  }, 500);
  render();
}

export async function startForFocus(taskId: number | null): Promise<boolean> {
  if (pomodoroRunning || activeSessionId !== null) {
    setMessage(pomodoroMessage, "A pomodoro is already in progress.", "error");
    return false;
  }
  pendingTaskId = taskId;
  await startCurrentMode();
  await onDataChangedCb?.();
  return activeSessionId !== null;
}

async function onComplete(): Promise<void> {
  stopTimer();
  const finished = pomodoroMode;
  const next = finished === "work" ? nextBreakMode(true) : "work";

  if (activeSessionId !== null) {
    try {
      const completedSession = await completeSession(activeSessionId);
      const earnedXp = modeDurationSeconds(finished) / 60;
      const msg = finished === "work"
        ? `Work session done! +${earnedXp} XP`
        : `${modeLabel(finished)} over!`;
      // Toast-style: fade after a few seconds so the bottom of the card
      // doesn't carry stale text into the next session.
      flashMessage(pomodoroMessage, msg, "success");
      await refresh();  // refresh the session list (used for stats counting too)
      if (finished === "work" && completedSession.linked_task_id !== null) {
        window.dispatchEvent(new CustomEvent("reading-focus:completed", {
          detail: { linkedTaskId: completedSession.linked_task_id },
        }));
      }
    } catch (error) {
      console.error(error);
      setMessage(pomodoroMessage, "Could not save completed session.", "error");
    } finally {
      // Always clear so the next phase opens a fresh server-side session;
      // otherwise a failed complete would attach the next phase to a stale id.
      activeSessionId = null;
      broadcastPomodoroState();
    }
  }

  celebrate(finished, next);

  // Tell the sidebar cat to react. Only animate on real work completions —
  // breaks are not an achievement worth celebrating with a wiggle.
  if (finished === "work") {
    window.dispatchEvent(new CustomEvent("cat:cheer"));
  }

  // Advance to next phase
  pomodoroMode = next;
  pomodoroTimeLeft = modeDurationSeconds(pomodoroMode);
  pomodoroEndTime = null;
  render();

  // Auto-start next phase so cycles flow without manual clicking
  if (getAutoStart()) {
    await startCurrentMode();
  }
}

// --- Init -------------------------------------------------------------------

export function init(onDataChanged: () => Promise<void>): void {
  onDataChangedCb = onDataChanged;
  pomodoroDisplay          = document.querySelector<HTMLDivElement>("#pomodoro-display")!;
  pomodoroStartButton      = document.querySelector<HTMLButtonElement>("#pomodoro-start-button")!;
  pomodoroResetButton      = document.querySelector<HTMLButtonElement>("#pomodoro-reset-button")!;
  pomodoroModeBadge        = document.querySelector<HTMLSpanElement>("#pomodoro-mode-badge")!;
  pomodoroMessage          = document.querySelector<HTMLParagraphElement>("#pomodoro-message")!;
  pomodoroList             = document.querySelector<HTMLDivElement>("#pomodoro-list")!;
  settingsToggle           = document.querySelector<HTMLButtonElement>("#pomodoro-settings-toggle")!;
  settingsPanel            = document.querySelector<HTMLDivElement>("#pomodoro-settings-panel")!;
  settingsForm             = document.querySelector<HTMLFormElement>("#pomodoro-settings-form")!;
  settingsWorkInput        = document.querySelector<HTMLInputElement>("#pomodoro-setting-work")!;
  settingsShortInput       = document.querySelector<HTMLInputElement>("#pomodoro-setting-short")!;
  settingsLongInput        = document.querySelector<HTMLInputElement>("#pomodoro-setting-long")!;
  settingsBeforeLongInput  = document.querySelector<HTMLInputElement>("#pomodoro-setting-before-long")!;
  settingsAutoStartInput   = document.querySelector<HTMLInputElement>("#pomodoro-setting-auto-start");
  settingsMessage          = document.querySelector<HTMLParagraphElement>("#pomodoro-settings-message")!;
  modeHintEl               = document.querySelector<HTMLParagraphElement>("#pomodoro-mode-hint")!;
  taskPickerEl             = document.querySelector<HTMLDivElement>("#pomodoro-task-picker");

  // Render the task picker so the user can pick before clicking Start.
  // Pomodoro doesn't support mid-session retag — the picker disables
  // once activeSessionId is non-null (i.e. a session is in flight).
  void refreshTaskPickerUI();
  window.addEventListener("task-list:updated", () => void refreshTaskPickerUI());

  // Today's-work-minutes line in the session list reads from the stats
  // module's cache; re-render when that cache is refreshed.
  window.addEventListener("progress:updated", () => render());
  // Sleeping-cat empty state needs to re-tint on skin change.
  window.addEventListener("cat:skin-changed", () => render());
  // Re-paint when the user toggles back into pomodoro mode (the clock was
  // owned by the stopwatch side while hidden).
  window.addEventListener("timer-mode:changed", () => render());

  pomodoroStartButton.addEventListener("click", async () => {
    if (pomodoroRunning) { stopTimer(); render(); return; }
    // Asking once on first user gesture keeps Notification.requestPermission
    // happy (it requires a user activation context).
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    await startCurrentMode();
    // Refresh from server so the session list reflects the new in-progress row
    await onDataChanged();
  });

  pomodoroResetButton.addEventListener("click", async () => {
    stopTimer();
    // Discard the server-side in-progress row so Reset doesn't leave orphan
    // "in progress" sessions in the history list.
    const orphanId = activeSessionId;
    activeSessionId = null;
    broadcastPomodoroState();
    pomodoroMode = "work";
    pomodoroTimeLeft = modeDurationSeconds("work");
    pomodoroEndTime = null;
    setMessage(pomodoroMessage, "", "neutral");
    render();
    if (orphanId !== null) {
      try {
        await deleteSession(orphanId);
        await onDataChanged();
      } catch (error) {
        console.error(error);
        setMessage(pomodoroMessage, "Reset locally, but could not discard server session.", "error");
      }
    }
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
    if (!(work >= 1 && work <= 240))            errors.push("Work: 1-240 min");
    if (!(shortBrk >= 1 && shortBrk <= 60))     errors.push("Short break: 1-60 min");
    if (!(longBrk >= 1 && longBrk <= 60))       errors.push("Long break: 1-60 min");
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
      if (settingsAutoStartInput) setAutoStart(settingsAutoStartInput.checked);
      setUser(updated);
      setMessage(settingsMessage, "Settings saved.", "success");
    } catch (error) {
      console.error(error);
      setMessage(settingsMessage, "Could not save settings.", "error");
    }
  });

  // Delete from session list (event-delegated)
  pomodoroList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.pomoAction !== "delete") return;
    const sid = Number(target.dataset.id);
    if (!Number.isFinite(sid)) return;
    if (!window.confirm("Delete this session?")) return;
    try {
      await deleteSession(sid);
      setMessage(pomodoroMessage, "Session deleted.", "success");
      // Refresh local list AND stats (deletion doesn't affect xp_events history)
      await onDataChanged();
    } catch (error) {
      console.error(error);
      setMessage(pomodoroMessage, "Could not delete session.", "error");
    }
  });
}
