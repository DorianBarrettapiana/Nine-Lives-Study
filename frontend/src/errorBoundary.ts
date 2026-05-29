/**
 * Last-resort error UI.
 *
 * The app is a hand-rolled SPA without a framework's ErrorBoundary, so when
 * a view's `init()` throws (most commonly: `document.querySelector(...)!`
 * resolves to null because the markup drifted), the page goes silent and
 * only the console shows what happened. From the user's seat it just feels
 * broken.
 *
 * This module installs two safety nets:
 *   1. `window.error` and `window.unhandledrejection` listeners that pop a
 *      visible banner at the top of the page with the error and a reload
 *      button.
 *   2. `withFallback(fn)` to wrap any synchronous or async init function
 *      so the same banner appears if it throws / rejects.
 *
 * The banner uses inline styles so it works even if CSS failed to load.
 */

let bannerEl: HTMLDivElement | null = null;

function showBanner(message: string): void {
  if (bannerEl) {
    // Only keep the first error so we don't pile up identical banners.
    return;
  }
  bannerEl = document.createElement("div");
  bannerEl.setAttribute("role", "alert");
  bannerEl.style.cssText = [
    "position:fixed", "top:0", "left:0", "right:0", "z-index:99999",
    "background:#7f1d1d", "color:#fee2e2",
    "padding:12px 16px", "font:14px system-ui,sans-serif",
    "display:flex", "align-items:center", "gap:12px",
    "box-shadow:0 2px 8px rgba(0,0,0,0.3)",
  ].join(";");

  const text = document.createElement("span");
  text.style.flex = "1";
  text.textContent = `Something broke: ${message}. The app may not work correctly.`;

  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.style.cssText = [
    "background:#fee2e2", "color:#7f1d1d", "border:0",
    "padding:6px 12px", "border-radius:4px", "cursor:pointer",
    "font:inherit", "font-weight:600",
  ].join(";");
  reload.addEventListener("click", () => window.location.reload());

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  dismiss.style.cssText = [
    "background:transparent", "color:inherit",
    "border:1px solid currentColor",
    "padding:6px 12px", "border-radius:4px", "cursor:pointer",
    "font:inherit",
  ].join(";");
  dismiss.addEventListener("click", () => {
    bannerEl?.remove();
    bannerEl = null;
  });

  bannerEl.append(text, reload, dismiss);
  document.body.appendChild(bannerEl);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export function installErrorBoundary(): void {
  window.addEventListener("error", (event) => {
    // Skip noise from cross-origin scripts (message: "Script error.").
    if (!event.error && event.message === "Script error.") return;
    console.error("Unhandled error:", event.error ?? event.message);
    showBanner(describe(event.error ?? event.message));
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("Unhandled promise rejection:", event.reason);
    showBanner(describe(event.reason));
  });
}

/** Run `fn`; if it throws / rejects, show the fallback banner and rethrow. */
export async function withFallback<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    showBanner(describe(e));
    throw e;
  }
}
