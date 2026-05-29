/**
 * Shared utility functions.
 */

export function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

// The server now always emits ISO-8601 datetimes with an explicit UTC suffix
// (`...Z`) — see `app/schemas/_base.py`. This helper used to compensate for
// the old naive-without-suffix format; today it's effectively `new Date(...)`
// but we keep it as a single chokepoint so any future format change is
// localized to one place.
export function parseApiDate(value: string): Date {
  return new Date(value);
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function setMessage(
  element: HTMLElement,
  text: string,
  kind: "success" | "error" | "neutral" = "neutral",
): void {
  element.textContent = text;
  element.className = `message ${kind}`;
}

/** Like setMessage, but auto-clears the element after `ms` (default 3 s)
 *  so success/neutral toasts don't linger forever in the UI.
 *  If called again before the timer fires, the prior timeout is cancelled
 *  so the message stays visible for the full duration each time.
 *  Use setMessage (not this) for errors that should persist until the user
 *  takes an action. */
const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
export function flashMessage(
  element: HTMLElement,
  text: string,
  kind: "success" | "error" | "neutral" = "neutral",
  ms: number = 3000,
): void {
  setMessage(element, text, kind);
  const prev = flashTimers.get(element);
  if (prev !== undefined) clearTimeout(prev);
  const id = setTimeout(() => {
    setMessage(element, "", "neutral");
    flashTimers.delete(element);
  }, ms);
  flashTimers.set(element, id);
}

export function fmtMinutes(mins: number): string {
  if (mins === 0) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

export function makeDateLabel(dateStr: string): string {
  return new Date(dateStr + "T12:00:00").toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
}
