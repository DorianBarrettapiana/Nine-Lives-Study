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
  task_time_breakdown: Array<{
    id: number;
    text: string;
    is_done: boolean;
    direct_minutes: number;
    total_minutes: number;
    children: Array<{
      id: number;
      text: string;
      is_done: boolean;
      minutes: number;
    }>;
  }>;
  paper_notes: PaperNoteRead[];
  feynman_entries: FeynmanEntryRead[];
  recent_reflections: ReflectionMention[];
  recent_insights: Array<{
    id: number;
    paper_note_id: number;
    key_idea: string;
    question: string;
    next_step: string;
    created_at: string;
  }>;
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
