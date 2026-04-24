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
  created_at: string;
  updated_at: string;
}

export interface DailyLogRead {
  id: number;
  user_id: number;
  log_date: string;
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
}

export interface DailyLogUpsert {
  log_date?: string | null;
  mood: string;
  reflection: string;
}

export async function getDailyState(
  userId: number,
  date?: string,
): Promise<DailyStateRead> {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  return apiFetch<DailyStateRead>(`/users/${userId}/daily${query}`);
}

export async function createDailyTask(
  userId: number,
  payload: DailyTaskCreate,
): Promise<DailyTaskRead> {
  return apiFetch<DailyTaskRead>(`/users/${userId}/daily/tasks`, {
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

export async function saveDailyLog(
  userId: number,
  payload: DailyLogUpsert,
): Promise<DailyLogRead> {
  return apiFetch<DailyLogRead>(`/users/${userId}/daily/log`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}