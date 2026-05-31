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
