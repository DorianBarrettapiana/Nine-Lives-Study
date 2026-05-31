/**
 * Daily tracker API functions.
 */

import { apiFetch } from "./client";

export interface DailyTaskRead {
  id: number;
  user_id: number;
  task_date: string;
  // New scheduling fields. `planned_date` mirrors `task_date` for legacy
  // rows; the UI should migrate to reading planned_date in a follow-up PR.
  planned_date: string | null;
  due_date: string | null;
  text: string;
  is_done: boolean;
  sort_order: number;
  project_id: number | null;
  paper_note_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface DailyLogRead {
  id: number;
  user_id: number;
  log_date: string;
  main_goal: string;
  main_goal_task_id: number | null;
  mood: string;
  reflection: string;
  created_at: string;
  updated_at: string;
}

export interface DailyStateRead {
  date: string;
  tasks: DailyTaskRead[];
  log: DailyLogRead | null;
  done_count: number;
  total_count: number;
  completion_percent: number;
}

export interface DailyTaskCreate {
  text: string;
  task_date?: string | null;
  planned_date?: string | null;
  due_date?: string | null;
  project_id?: number | null;
  paper_note_id?: number | null;
}

export interface DailyTaskUpdate {
  text?: string;
  is_done?: boolean;
  sort_order?: number;
  planned_date?: string | null;
  due_date?: string | null;
  project_id?: number | null;
}

export interface DailyLogUpsert {
  log_date?: string | null;
  main_goal?: string | null;
  // Pass an id to set, or 0 to unassign. Omit to leave unchanged.
  main_goal_task_id?: number | null;
  mood: string;
  reflection: string;
}

export async function listUpcomingTasks(opts: {
  horizon_days?: number;
  include_overdue?: boolean;
} = {}): Promise<DailyTaskRead[]> {
  const params = new URLSearchParams();
  if (opts.horizon_days !== undefined) params.set("horizon_days", String(opts.horizon_days));
  if (opts.include_overdue !== undefined) params.set("include_overdue", String(opts.include_overdue));
  const qs = params.toString();
  return apiFetch<DailyTaskRead[]>(`/daily/tasks/upcoming${qs ? `?${qs}` : ""}`);
}

export async function getDailyState(date?: string): Promise<DailyStateRead> {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  return apiFetch<DailyStateRead>(`/daily${query}`);
}

export async function createDailyTask(payload: DailyTaskCreate): Promise<DailyTaskRead> {
  return apiFetch<DailyTaskRead>("/daily/tasks", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateDailyTask(
  taskId: number,
  payload: DailyTaskUpdate,
): Promise<DailyTaskRead> {
  return apiFetch<DailyTaskRead>(`/daily/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteDailyTask(taskId: number): Promise<void> {
  await apiFetch<void>(`/daily/tasks/${taskId}`, {
    method: "DELETE",
  });
}

export async function carryDailyTask(taskId: number): Promise<DailyTaskRead> {
  return apiFetch<DailyTaskRead>(`/daily/tasks/${taskId}/carry-forward`, {
    method: "POST",
  });
}

export async function saveDailyLog(payload: DailyLogUpsert): Promise<DailyLogRead> {
  return apiFetch<DailyLogRead>("/daily/log", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}
