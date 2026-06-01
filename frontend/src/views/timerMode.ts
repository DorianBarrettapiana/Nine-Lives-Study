/**
 * Coordinates the two panels inside the unified sidebar timer card.
 *
 * The pixel clock and "today total" line sit OUTSIDE both panels and stay
 * visible regardless of mode. Pomodoro and stopwatch keep their own
 * independent state machines (and the server enforces mutex), so this
 * module only handles UI visibility + persistence of the user's last
 * picked mode.
 */

export type TimerMode = "pomodoro" | "free";

const STORAGE_KEY = "nl_timer_mode";
// Lazily initialised so module load doesn't depend on `localStorage` being
// available at import time (matters in test envs where jsdom is set up
// after some imports may already have resolved).
let currentMode: TimerMode | null = null;

function readStoredMode(): TimerMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "free" ? "free" : "pomodoro";
  } catch {
    return "pomodoro";
  }
}

export function getMode(): TimerMode {
  if (currentMode === null) currentMode = readStoredMode();
  return currentMode;
}

/** Switch the visible panel. Idempotent — safe to call when already in mode. */
export function setMode(mode: TimerMode): void {
  currentMode = mode;
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* private mode */ }

  const pomoPanel = document.getElementById("timer-panel-pomodoro");
  const freePanel = document.getElementById("timer-panel-free");
  pomoPanel?.classList.toggle("hidden", mode !== "pomodoro");
  freePanel?.classList.toggle("hidden", mode !== "free");

  document.querySelectorAll<HTMLButtonElement>(".timer-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.timerMode === mode);
  });

  window.dispatchEvent(new CustomEvent("timer-mode:changed", { detail: { mode } }));
}

export function init(): void {
  document.querySelectorAll<HTMLButtonElement>(".timer-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.timerMode as TimerMode | undefined;
      if (next === "pomodoro" || next === "free") setMode(next);
    });
  });
  // Apply persisted choice on first paint.
  setMode(currentMode);
}
