/**
 * Reusable project <select> for forms (tasks, notes, feynman).
 *
 * Renders a labeled dropdown into a container element. Empty option =
 * "(no project)" maps to null in the payload. Auto-refreshes when the
 * projects:updated event fires (e.g. user renamed a project in another
 * view), so a picker that was already open stays in sync.
 */

import { escapeHtml } from "../utils";
import {
  findProject,
  getActiveProjects,
  refreshProjects,
} from "./project-state";

export interface ProjectPickerOptions {
  container: HTMLElement;
  selectedId: number | null;
  /** Label rendered above the select (e.g. "Project"). */
  label?: string;
  /** Called when the user picks a different project (or "(no project)"). */
  onChange: (projectId: number | null) => void;
  /** When true the select is disabled — used during in-flight saves. */
  disabled?: boolean;
}

const KNOWN_PICKERS = new WeakMap<HTMLElement, ProjectPickerOptions>();
let listenerAttached = false;

function attachGlobalListener(): void {
  if (listenerAttached) return;
  listenerAttached = true;
  // Re-render every picker whenever the cache changes. Cheap — pickers
  // are O(N projects).
  window.addEventListener("projects:updated", () => {
    KNOWN_PICKERS && document.querySelectorAll<HTMLElement>("[data-project-picker]").forEach((el) => {
      const opts = KNOWN_PICKERS.get(el);
      if (opts) renderProjectPicker(opts);
    });
  });
}

export async function renderProjectPicker(opts: ProjectPickerOptions): Promise<void> {
  attachGlobalListener();
  opts.container.dataset.projectPicker = "1";
  KNOWN_PICKERS.set(opts.container, opts);

  // Lazy first fetch — cheap when cached.
  if (getActiveProjects().length === 0) {
    try { await refreshProjects(); } catch { /* leave empty */ }
  }
  const projects = getActiveProjects();
  // If a task was already linked to an archived project, surface it as a
  // disabled-styled option so the user can see what it was tied to and
  // explicitly reassign or unassign.
  const selected = findProject(opts.selectedId);
  const showStale = selected !== undefined && selected.is_archived;

  const labelHtml = opts.label
    ? `<span class="project-picker-label">${escapeHtml(opts.label)}</span>`
    : "";
  const options = [
    `<option value="">(no project)</option>`,
    ...projects.map((p) => `
      <option value="${p.id}" ${opts.selectedId === p.id ? "selected" : ""}>
        ${escapeHtml(p.name)}
      </option>
    `),
    showStale
      ? `<option value="${selected.id}" selected>${escapeHtml(selected.name)} (archived)</option>`
      : "",
  ].join("");

  opts.container.innerHTML = `
    <label class="project-picker">
      ${labelHtml}
      <select class="project-picker-select" ${opts.disabled ? "disabled" : ""}>
        ${options}
      </select>
    </label>
  `;

  const select = opts.container.querySelector<HTMLSelectElement>(".project-picker-select")!;
  select.addEventListener("change", () => {
    const raw = select.value;
    opts.onChange(raw === "" ? null : Number(raw));
  });
}

/**
 * Render a small "Project: <name>" chip for cards/rows. Returns an HTML
 * string (caller decides where to drop it). Returns empty string when the
 * id is null or the project is unknown.
 */
export function projectChipHtml(projectId: number | null): string {
  if (projectId === null) return "";
  const p = findProject(projectId);
  if (!p) return "";
  const style = p.color ? ` style="background:${escapeHtml(p.color)}22;border-color:${escapeHtml(p.color)}44;"` : "";
  const archivedClass = p.is_archived ? " project-chip-archived" : "";
  return `<span class="project-chip${archivedClass}"${style}>📁 ${escapeHtml(p.name)}</span>`;
}
