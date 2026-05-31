/**
 * Projects management view.
 *
 * MVP: list all projects (active + archived), inline-create, rename
 * (double-click), archive, delete (with confirmation that explains
 * dependent items get unassigned, not deleted).
 */

import {
  createProject,
  deleteProject,
  updateProject,
  type ProjectRead,
} from "../api/projects";
import { escapeHtml, setMessage } from "../utils";
import {
  getCachedProjects,
  notifyProjectsUpdated,
  refreshProjects,
} from "./project-state";

let listEl: HTMLDivElement;
let formEl: HTMLFormElement;
let nameInput: HTMLInputElement;
let colorInput: HTMLInputElement;
let messageEl: HTMLParagraphElement;
let onChangedCb: (() => Promise<void>) | null = null;

function render(): void {
  const projects = getCachedProjects();
  if (projects.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No project yet. Create one above to start grouping tasks, notes, and Feynman entries.</div>`;
    return;
  }
  const active = projects.filter((p) => !p.is_archived);
  const archived = projects.filter((p) => p.is_archived);
  listEl.innerHTML = `
    ${renderGroup(active, "Active")}
    ${archived.length > 0 ? `<details class="project-archived-block"><summary>Archived (${archived.length})</summary>${renderGroup(archived, "Archived")}</details>` : ""}
  `;
}

function renderGroup(projects: ProjectRead[], _label: string): string {
  if (projects.length === 0) return "";
  return `
    <div class="project-list">
      ${projects.map(renderRow).join("")}
    </div>
  `;
}

function renderRow(p: ProjectRead): string {
  const swatchStyle = p.color
    ? ` style="background:${escapeHtml(p.color)};"`
    : "";
  return `
    <div class="project-row${p.is_archived ? " is-archived" : ""}" data-id="${p.id}">
      <span class="project-swatch"${swatchStyle}></span>
      <span class="project-name" data-action="edit-name" title="Double-click to rename">${escapeHtml(p.name)}</span>
      <div class="project-row-actions">
        <button type="button" class="link-btn" data-action="toggle-archive">
          ${p.is_archived ? "Unarchive" : "Archive"}
        </button>
        <button type="button" class="link-btn danger" data-action="delete">Delete</button>
      </div>
    </div>
  `;
}

export async function refresh(): Promise<void> {
  try {
    await refreshProjects(true);
    render();
  } catch (e) {
    console.warn("refreshProjects failed", e);
    if (messageEl) setMessage(messageEl, "Could not load projects.", "error");
  }
}

function startInlineRename(row: HTMLElement, project: ProjectRead): void {
  const nameSpan = row.querySelector<HTMLSpanElement>(".project-name");
  if (!nameSpan) return;
  const input = document.createElement("input");
  input.type = "text";
  input.value = project.name;
  input.className = "project-edit-input";
  input.maxLength = 100;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  const cancel = (): void => {
    if (committed) return;
    committed = true;
    input.replaceWith(nameSpan);
  };
  const commit = async (): Promise<void> => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (!newName || newName === project.name) {
      input.replaceWith(nameSpan);
      return;
    }
    try {
      await updateProject(project.id, { name: newName });
      notifyProjectsUpdated();
      await refresh();
      await onChangedCb?.();
    } catch (e) {
      console.error(e);
      setMessage(messageEl, "Could not rename project.", "error");
      input.replaceWith(nameSpan);
    }
  };
  input.addEventListener("blur", () => void commit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
}

export function init(onChanged?: () => Promise<void>): void {
  onChangedCb = onChanged ?? null;
  listEl = document.querySelector<HTMLDivElement>("#projects-list")!;
  formEl = document.querySelector<HTMLFormElement>("#project-form")!;
  nameInput = document.querySelector<HTMLInputElement>("#project-name-input")!;
  colorInput = document.querySelector<HTMLInputElement>("#project-color-input")!;
  messageEl = document.querySelector<HTMLParagraphElement>("#project-message")!;

  formEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { setMessage(messageEl, "Name is required.", "error"); return; }
    try {
      await createProject({ name, color: colorInput.value || undefined });
      nameInput.value = "";
      // Don't clear color — most users want to keep their palette in mind.
      setMessage(messageEl, "Project created.", "success");
      notifyProjectsUpdated();
      await refresh();
      await onChangedCb?.();
    } catch (e) {
      console.error(e);
      setMessage(messageEl, "Could not create project.", "error");
    }
  });

  listEl.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.action !== "edit-name") return;
    const row = target.closest<HTMLElement>(".project-row");
    if (!row) return;
    const id = Number(row.dataset.id);
    const project = getCachedProjects().find((p) => p.id === id);
    if (project) startInlineRename(row, project);
  });

  listEl.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.action;
    if (!action || action === "edit-name") return;
    const row = target.closest<HTMLElement>(".project-row");
    if (!row) return;
    const id = Number(row.dataset.id);
    const project = getCachedProjects().find((p) => p.id === id);
    if (!project) return;

    if (action === "toggle-archive") {
      try {
        await updateProject(id, { is_archived: !project.is_archived });
        notifyProjectsUpdated();
        await refresh();
        await onChangedCb?.();
      } catch (e) {
        console.error(e);
        setMessage(messageEl, "Could not update project.", "error");
      }
    } else if (action === "delete") {
      if (!window.confirm(
        `Delete project "${project.name}"?\n\n` +
        `Tasks, paper notes, and Feynman entries that belonged to this ` +
        `project will be kept (they become unassigned).`,
      )) return;
      try {
        await deleteProject(id);
        notifyProjectsUpdated();
        await refresh();
        await onChangedCb?.();
      } catch (e) {
        console.error(e);
        setMessage(messageEl, "Could not delete project.", "error");
      }
    }
  });
}
