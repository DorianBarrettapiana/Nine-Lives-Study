/**
 * Project (research-thread) API functions.
 */

import { apiFetch } from "./client";

export interface ProjectRead {
  id: number;
  user_id: number;
  name: string;
  color: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectCreate {
  name: string;
  color?: string;
}

export interface ProjectUpdate {
  name?: string;
  color?: string;
  is_archived?: boolean;
}

// --- Dashboard ----------------------------------------------------------

import type { DailyTaskRead } from "./tracker";
import type { PaperNoteRead } from "./notes";
import type { FeynmanEntryRead } from "./feynman";

export interface ReflectionMention {
  log_date: string;
  snippet: string;
}

export interface ProjectDashboardRead {
  project: ProjectRead;
  minutes_7d: number;
  minutes_30d: number;
  done_tasks_7d: number;
  open_tasks_count: number;
  last_activity_at: string | null;
  open_tasks: DailyTaskRead[];
  paper_notes: PaperNoteRead[];
  feynman_entries: FeynmanEntryRead[];
  recent_reflections: ReflectionMention[];
}

export async function getProjectDashboard(projectId: number): Promise<ProjectDashboardRead> {
  return apiFetch<ProjectDashboardRead>(`/projects/${projectId}/dashboard`);
}

export async function listProjects(includeArchived = false): Promise<ProjectRead[]> {
  const qs = includeArchived ? "?include_archived=true" : "";
  return apiFetch<ProjectRead[]>(`/projects${qs}`);
}

export async function createProject(payload: ProjectCreate): Promise<ProjectRead> {
  return apiFetch<ProjectRead>("/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateProject(
  projectId: number,
  payload: ProjectUpdate,
): Promise<ProjectRead> {
  return apiFetch<ProjectRead>(`/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteProject(projectId: number): Promise<void> {
  await apiFetch<void>(`/projects/${projectId}`, { method: "DELETE" });
}
