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

export function makeDateLabel(dateStr: string): string {
  return new Date(dateStr + "T12:00:00").toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
}
