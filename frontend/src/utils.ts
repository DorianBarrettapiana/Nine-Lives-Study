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

// SQLite returns naive datetime strings (no "Z"/"+00:00" suffix) even though
// the values are always UTC. Without a suffix, JS treats the string as LOCAL
// time, so UTC 10:30 would display as 10:30 instead of 12:30 in France (CEST).
// This helper appends "Z" when no timezone info is present.
export function parseApiDate(value: string): Date {
  return new Date(/[Z+]/.test(value) ? value : value + "Z");
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
