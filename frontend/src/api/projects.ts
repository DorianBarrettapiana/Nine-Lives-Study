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
  research_question: string;
  milestone: string;
  advisor_meeting_date: string | null;
  blocker: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectCreate {
  name: string;
  color?: string;
  research_question?: string;
  milestone?: string;
  advisor_meeting_date?: string | null;
  blocker?: string;
}

export interface ProjectUpdate {
  name?: string;
  color?: string;
  is_archived?: boolean;
  research_question?: string;
  milestone?: string;
  advisor_meeting_date?: string | null;
  blocker?: string;
}

export interface ProjectDashboard {
  project: ProjectRead;
  weekly_focus_minutes: number;
  open_tasks: Array<{ id: number; text: string; planned_date: string | null; due_date: string | null }>;
  reading_queue: Array<{ id: number; title: string; reading_status: string; reading_minutes: number }>;
  unresolved_gaps: Array<{ id: number; concept: string; gaps: string }>;
  recent_insights: Array<{
    id: number;
    paper_note_id: number;
    key_idea: string;
    question: string;
    next_step: string;
    created_at: string;
  }>;
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

export async function getProjectDashboard(projectId: number): Promise<ProjectDashboard> {
  return apiFetch<ProjectDashboard>(`/projects/${projectId}/dashboard`);
}
