/**
 * Daily tracker API functions.
 */

import { apiFetch } from "./client";

export interface DailyTaskRead {
  id: number;
  user_id: number;
  task_date: string;
  text: string;
  is_done: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface DailyLogRead {
  id: number;
  user_id: number;
  log_date: string;
  main_goal: string;
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
}

export interface DailyTaskUpdate {
  text?: string;
  is_done?: boolean;
  sort_order?: number;
}

export interface DailyLogUpsert {
  log_date?: string | null;
  main_goal?: string | null;
  mood: string;
  reflection: string;
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
