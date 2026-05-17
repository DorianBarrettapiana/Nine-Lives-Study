/**
 * Theme management.
 */

export function applyTheme(theme: string): void {
  document.body.classList.remove("theme-dark", "theme-light");
  document.body.classList.add(`theme-${theme}`);
}
