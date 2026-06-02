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
  type ProjectDashboardRead,
  type ProjectRead,
} from "../api/projects";
import { escapeHtml, fmtMinutes, formatDate, setMessage } from "../utils";
import {
  getCachedProjects,
  notifyProjectsUpdated,
  refreshProjects,
} from "./project-state";

let listEl: HTMLDivElement;
let formEl: HTMLFormElement;
let projectEditorDetails: HTMLDetailsElement;
let nameInput: HTMLInputElement;
let colorInput: HTMLInputElement;
let messageEl: HTMLParagraphElement;
let dashboardContainer: HTMLDivElement;
let listContainer: HTMLDivElement;
let onChangedCb: (() => Promise<void>) | null = null;
let openDashboardId: number | null = null;

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

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
      <button type="button" class="project-name-btn" data-action="open-dashboard"
              title="Open dashboard (double-click name to rename)">${escapeHtml(p.name)}</button>
      <div class="project-row-actions">
        <button type="button" class="link-btn" data-action="toggle-archive">
          ${p.is_archived ? "Unarchive" : "Archive"}
        </button>
        <button type="button" class="link-btn danger" data-action="delete">Delete</button>
      </div>
    </div>
  `;
}

function dashboardHtml(d: ProjectDashboardRead): string {
  const swatch = d.project.color
    ? `<span class="project-swatch" style="background:${escapeHtml(d.project.color)};"></span>`
    : "";
  const lastSeen = d.last_activity_at
    ? formatDate(d.last_activity_at)
    : "No work session yet";

  const openTasksHtml = d.open_tasks.length === 0
    ? `<p class="hint">No open task.</p>`
    : d.open_tasks.map((t) => `
        <div class="dashboard-task-row">
          <span class="dashboard-task-text">${escapeHtml(t.text)}</span>
          ${t.due_date ? `<span class="hint">📅 ${escapeHtml(t.due_date)}</span>` : ""}
        </div>
      `).join("");

  const notesHtml = d.paper_notes.length === 0
    ? `<p class="hint">No paper note yet.</p>`
    : d.paper_notes.map((n) => `
        <div class="dashboard-knowledge-row">
          <strong>${escapeHtml(n.title)}</strong>
          <span class="hint">${escapeHtml(n.authors || "—")}${n.year ? ` (${n.year})` : ""} · ${fmtMinutes(n.reading_minutes)}</span>
        </div>
      `).join("");

  const feynmanHtml = d.feynman_entries.length === 0
    ? `<p class="hint">No Feynman entry yet.</p>`
    : d.feynman_entries.map((f) => `
        <div class="dashboard-knowledge-row">
          <strong>${escapeHtml(f.concept)}</strong>
        </div>
      `).join("");

  const mentionsHtml = d.recent_reflections.length === 0
    ? `<p class="hint">No reflection has mentioned this project name in the last 30 days.</p>`
    : d.recent_reflections.map((m) => `
        <div class="dashboard-mention-row">
          <span class="hint">${escapeHtml(m.log_date)}</span>
          <span>${escapeHtml(m.snippet)}</span>
        </div>
      `).join("");

  const insightsHtml = d.recent_insights.length === 0
    ? `<p class="hint">Complete a focused reading session to capture an insight.</p>`
    : d.recent_insights.map((insight) => `
        <div class="dashboard-knowledge-row">
          <strong>${escapeHtml(insight.key_idea || insight.question || insight.next_step)}</strong>
          ${insight.question ? `<span class="hint">Question: ${escapeHtml(insight.question)}</span>` : ""}
          ${insight.next_step ? `<span class="hint">Next: ${escapeHtml(insight.next_step)}</span>` : ""}
        </div>
      `).join("");

  return `
    <section class="card">
      <div class="section-header">
        <h2>${swatch} ${escapeHtml(d.project.name)}</h2>
        <button type="button" class="link-btn" data-dashboard-action="back">← All projects</button>
      </div>
      <div class="dashboard-pulse">
        <div class="dashboard-stat"><span class="dashboard-stat-num">${fmtMinutes(d.minutes_7d)}</span><span class="hint">last 7d</span></div>
        <div class="dashboard-stat"><span class="dashboard-stat-num">${fmtMinutes(d.minutes_30d)}</span><span class="hint">last 30d</span></div>
        <div class="dashboard-stat"><span class="dashboard-stat-num">${d.done_tasks_7d}</span><span class="hint">tasks done 7d</span></div>
        <div class="dashboard-stat"><span class="dashboard-stat-num">${d.open_tasks_count}</span><span class="hint">open tasks</span></div>
        <div class="dashboard-stat"><span class="dashboard-stat-num dashboard-stat-small">${escapeHtml(lastSeen)}</span><span class="hint">last activity</span></div>
      </div>
    </section>

    <section class="card">
      <h2>Research context</h2>
      <form id="project-dashboard-form" class="form">
        <label>Current research question
          <textarea id="project-research-question" placeholder="What are you trying to answer right now?">${escapeHtml(d.project.research_question)}</textarea>
        </label>
        <label>Current milestone
          <input id="project-milestone" type="text" value="${escapeAttr(d.project.milestone)}" placeholder="e.g. Draft methods section" />
        </label>
        <div class="two-cols">
          <label>Next advisor meeting
            <input id="project-advisor-meeting" type="date" value="${escapeAttr(d.project.advisor_meeting_date ?? "")}" />
          </label>
          <label>Current blocker
            <input id="project-blocker" type="text" value="${escapeAttr(d.project.blocker)}" placeholder="What is slowing this thread down?" />
          </label>
        </div>
        <div class="button-row"><button type="submit">Save research context</button></div>
        <p id="project-dashboard-message" class="message"></p>
      </form>
    </section>

    <section class="card">
      <h2>Open work</h2>
      <div class="dashboard-block">${openTasksHtml}</div>
    </section>

    <section class="card">
      <h2>Knowledge</h2>
      <div class="two-cols">
        <div>
          <h3>Paper notes (${d.paper_notes.length})</h3>
          <div class="dashboard-block">${notesHtml}</div>
        </div>
        <div>
          <h3>Feynman (${d.feynman_entries.length})</h3>
          <div class="dashboard-block">${feynmanHtml}</div>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Mentions in reflection</h2>
      <p class="hint">Last 30 days, where your daily reflections mention "${escapeHtml(d.project.name)}".</p>
      <div class="dashboard-block">${mentionsHtml}</div>
    </section>

    <section class="card">
      <h2>Recent reading insights</h2>
      <div class="dashboard-block">${insightsHtml}</div>
    </section>
  `;
}

async function openDashboard(projectId: number): Promise<void> {
  openDashboardId = projectId;
  listContainer.classList.add("hidden");
  dashboardContainer.classList.remove("hidden");
  dashboardContainer.innerHTML = `<section class="card"><p>Loading…</p></section>`;
  try {
    const data = await getProjectDashboard(projectId);
    dashboardContainer.innerHTML = dashboardHtml(data);
  } catch (e) {
    console.error(e);
    dashboardContainer.innerHTML = `<section class="card"><p class="message error">Could not load project dashboard.</p></section>`;
  }
}

function closeDashboard(): void {
  openDashboardId = null;
  dashboardContainer.classList.add("hidden");
  dashboardContainer.innerHTML = "";
  listContainer.classList.remove("hidden");
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
  const nameSpan = row.querySelector<HTMLButtonElement>(".project-name-btn");
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
  projectEditorDetails = document.querySelector<HTMLDetailsElement>("#project-editor-details")!;
  nameInput = document.querySelector<HTMLInputElement>("#project-name-input")!;
  colorInput = document.querySelector<HTMLInputElement>("#project-color-input")!;
  messageEl = document.querySelector<HTMLParagraphElement>("#project-message")!;
  dashboardContainer = document.querySelector<HTMLDivElement>("#project-dashboard-container")!;
  listContainer = document.querySelector<HTMLDivElement>("#projects-list-container")!;

  // Dashboard back / actions (delegated on the container).
  dashboardContainer.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.dashboardAction === "back") closeDashboard();
  });
  dashboardContainer.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (openDashboardId === null) return;
    const researchQuestion = dashboardContainer.querySelector<HTMLTextAreaElement>("#project-research-question")!;
    const milestone = dashboardContainer.querySelector<HTMLInputElement>("#project-milestone")!;
    const advisorMeeting = dashboardContainer.querySelector<HTMLInputElement>("#project-advisor-meeting")!;
    const blocker = dashboardContainer.querySelector<HTMLInputElement>("#project-blocker")!;
    const formMessage = dashboardContainer.querySelector<HTMLParagraphElement>("#project-dashboard-message")!;
    try {
      await updateProject(openDashboardId, {
        research_question: researchQuestion.value.trim(),
        milestone: milestone.value.trim(),
        advisor_meeting_date: advisorMeeting.value || null,
        blocker: blocker.value.trim(),
      });
      setMessage(formMessage, "Research context saved.", "success");
      notifyProjectsUpdated();
      await refreshProjects(true);
      await openDashboard(openDashboardId);
      await onChangedCb?.();
    } catch (e) {
      console.error(e);
      setMessage(formMessage, "Could not save research context.", "error");
    }
  });

  formEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { setMessage(messageEl, "Name is required.", "error"); return; }
    try {
      await createProject({ name, color: colorInput.value || undefined });
      nameInput.value = "";
      projectEditorDetails.open = false;
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
    if (target.dataset.action !== "open-dashboard") return;
    if (openDashboardId !== null) return; // dashboard already opened the row
    const row = target.closest<HTMLElement>(".project-row");
    if (!row) return;
    const id = Number(row.dataset.id);
    const project = getCachedProjects().find((p) => p.id === id);
    if (project) {
      // Cancel the pending dashboard navigation we kicked off on the
      // first click — the user actually wanted to rename.
      closeDashboard();
      startInlineRename(row, project);
    }
  });

  listEl.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.action;
    if (!action) return;
    const row = target.closest<HTMLElement>(".project-row");
    if (!row) return;
    const id = Number(row.dataset.id);
    const project = getCachedProjects().find((p) => p.id === id);
    if (!project) return;

    if (action === "open-dashboard") {
      await openDashboard(id);
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
        notifyProjectsUpdated();
        await refresh();
        await onChangedCb?.();
      } catch (e) {
        console.error(e);
        setMessage(messageEl, "Could not delete project.", "error");
      }
    }
  });
  window.addEventListener("paper-insights:updated", () => {
    if (openDashboardId !== null) void openDashboard(openDashboardId);
  });
}
