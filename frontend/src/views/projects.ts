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
  getProjectDashboard,
  updateProject,
  type ProjectDashboard,
  type ProjectRead,
} from "../api/projects";
import { escapeHtml, fmtMinutes, setMessage } from "../utils";
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
let dashboardCardEl: HTMLElement;
let dashboardContentEl: HTMLDivElement;
let dashboardMessageEl: HTMLParagraphElement;
let onChangedCb: (() => Promise<void>) | null = null;
let selectedDashboardId: number | null = null;
let dashboard: ProjectDashboard | null = null;

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
        <button type="button" class="link-btn" data-action="dashboard">Dashboard</button>
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
    if (selectedDashboardId !== null) await loadDashboard(selectedDashboardId);
  } catch (e) {
    console.warn("refreshProjects failed", e);
    if (messageEl) setMessage(messageEl, "Could not load projects.", "error");
  }
}

function listOrEmpty(items: string[], empty: string): string {
  return items.length > 0 ? items.join("") : `<div class="empty-state compact">${escapeHtml(empty)}</div>`;
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function renderDashboard(): void {
  if (!dashboard) return;
  const p = dashboard.project;
  dashboardCardEl.classList.remove("hidden");
  dashboardContentEl.innerHTML = `
    <div class="section-header">
      <div>
        <p class="eyebrow">Research thread</p>
        <h2>${escapeHtml(p.name)} dashboard</h2>
      </div>
      <button type="button" class="secondary compact-btn" data-dashboard-action="close">Close</button>
    </div>
    <div class="project-dashboard-stats">
      <div class="stat-card"><strong>${fmtMinutes(dashboard.weekly_focus_minutes)}</strong><span>focused this week</span></div>
      <div class="stat-card"><strong>${dashboard.open_tasks.length}</strong><span>open tasks</span></div>
      <div class="stat-card"><strong>${dashboard.reading_queue.length}</strong><span>papers in queue</span></div>
      <div class="stat-card"><strong>${dashboard.unresolved_gaps.length}</strong><span>open gaps</span></div>
    </div>
    <form id="project-dashboard-form" class="form project-context-form">
      <label>Current research question
        <textarea id="project-research-question" placeholder="What are you trying to answer right now?">${escapeHtml(p.research_question)}</textarea>
      </label>
      <label>Current milestone
        <input id="project-milestone" type="text" value="${escapeAttr(p.milestone)}" placeholder="e.g. Draft methods section" />
      </label>
      <div class="two-cols">
        <label>Next advisor meeting
          <input id="project-advisor-meeting" type="date" value="${escapeAttr(p.advisor_meeting_date ?? "")}" />
        </label>
        <label>Current blocker
          <input id="project-blocker" type="text" value="${escapeAttr(p.blocker)}" placeholder="What is slowing this thread down?" />
        </label>
      </div>
      <div class="button-row"><button type="submit">Save research context</button></div>
    </form>
    <div class="project-dashboard-grid">
      <section>
        <h3>Open tasks</h3>
        ${listOrEmpty(dashboard.open_tasks.map((task) => `
          <div class="dashboard-list-row">
            <span>${escapeHtml(task.text)}</span>
            ${task.due_date ? `<span class="hint">Due ${escapeHtml(task.due_date)}</span>` : ""}
          </div>`), "No open task in this thread.")}
      </section>
      <section>
        <h3>Reading queue</h3>
        ${listOrEmpty(dashboard.reading_queue.map((note) => `
          <div class="dashboard-list-row">
            <span>${escapeHtml(note.title)}</span>
            <span class="hint">${escapeHtml(note.reading_status)} · ${fmtMinutes(note.reading_minutes)}</span>
          </div>`), "No paper waiting for attention.")}
      </section>
      <section>
        <h3>Unresolved Feynman gaps</h3>
        ${listOrEmpty(dashboard.unresolved_gaps.map((gap) => `
          <div class="dashboard-list-row stacked">
            <strong>${escapeHtml(gap.concept)}</strong>
            <span class="hint">${escapeHtml(gap.gaps)}</span>
          </div>`), "No unresolved gap recorded.")}
      </section>
      <section>
        <h3>Recent reading insights</h3>
        ${listOrEmpty(dashboard.recent_insights.map((insight) => `
          <div class="dashboard-list-row stacked">
            <strong>${escapeHtml(insight.key_idea || insight.question || insight.next_step)}</strong>
            ${insight.next_step ? `<span class="hint">Next: ${escapeHtml(insight.next_step)}</span>` : ""}
          </div>`), "Complete a reading focus to capture an insight.")}
      </section>
    </div>
  `;
}

async function loadDashboard(projectId: number): Promise<void> {
  selectedDashboardId = projectId;
  dashboardCardEl.classList.remove("hidden");
  dashboardContentEl.innerHTML = `<div class="hint">Loading dashboard...</div>`;
  try {
    dashboard = await getProjectDashboard(projectId);
    renderDashboard();
  } catch (e) {
    console.error(e);
    setMessage(dashboardMessageEl, "Could not load project dashboard.", "error");
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
  dashboardCardEl = document.querySelector<HTMLElement>("#project-dashboard-card")!;
  dashboardContentEl = document.querySelector<HTMLDivElement>("#project-dashboard-content")!;
  dashboardMessageEl = document.querySelector<HTMLParagraphElement>("#project-dashboard-message")!;

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

    if (action === "dashboard") {
      await loadDashboard(id);
    } else if (action === "toggle-archive") {
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
        if (selectedDashboardId === id) {
          selectedDashboardId = null;
          dashboard = null;
          dashboardCardEl.classList.add("hidden");
        }
        notifyProjectsUpdated();
        await refresh();
        await onChangedCb?.();
      } catch (e) {
        console.error(e);
        setMessage(messageEl, "Could not delete project.", "error");
      }
    }
  });

  dashboardContentEl.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.dataset.dashboardAction !== "close") return;
    selectedDashboardId = null;
    dashboard = null;
    dashboardCardEl.classList.add("hidden");
  });

  dashboardContentEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (selectedDashboardId === null) return;
    const researchQuestion = dashboardContentEl.querySelector<HTMLTextAreaElement>("#project-research-question")!;
    const milestone = dashboardContentEl.querySelector<HTMLInputElement>("#project-milestone")!;
    const advisorMeeting = dashboardContentEl.querySelector<HTMLInputElement>("#project-advisor-meeting")!;
    const blocker = dashboardContentEl.querySelector<HTMLInputElement>("#project-blocker")!;
    try {
      await updateProject(selectedDashboardId, {
        research_question: researchQuestion.value.trim(),
        milestone: milestone.value.trim(),
        advisor_meeting_date: advisorMeeting.value || null,
        blocker: blocker.value.trim(),
      });
      setMessage(dashboardMessageEl, "Research context saved.", "success");
      notifyProjectsUpdated();
      await refreshProjects(true);
      render();
      await loadDashboard(selectedDashboardId);
      await onChangedCb?.();
    } catch (e) {
      console.error(e);
      setMessage(dashboardMessageEl, "Could not save research context.", "error");
    }
  });
  window.addEventListener("paper-insights:updated", () => {
    if (selectedDashboardId !== null) void loadDashboard(selectedDashboardId);
  });
}
