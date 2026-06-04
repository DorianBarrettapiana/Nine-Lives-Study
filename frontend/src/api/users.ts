/**
 * User & auth API functions.
 */

import { apiFetch } from "./client";

export interface UserRead {
  id: number;
  username: string;
  language: string;
  theme: string;
  is_active: boolean;

  pomodoro_work_minutes: number;
  pomodoro_short_break_minutes: number;
  pomodoro_long_break_minutes: number;
  pomodoro_sessions_before_long_break: number;

  cat_skin: string;
  cat_skin_minutes_accumulated: number;
  cat_skin_minutes_required: number;
  cat_skin_free_changes: number;
  daily_goal_minutes: number;
  motto: string;
  share_study_time: boolean;
  share_activity: boolean;
  share_project: boolean;
}

export interface RegisterPayload {
  username: string;
  password: string;
  invite_code: string;
  language?: string;
  theme?: string;
}

export interface LoginPayload {
  username: string;
  password: string;
}

export interface UserUpdate {
  language?: string;
  theme?: string;

  pomodoro_work_minutes?: number;
  pomodoro_short_break_minutes?: number;
  pomodoro_long_break_minutes?: number;
  pomodoro_sessions_before_long_break?: number;

  cat_skin?: string;

  daily_goal_minutes?: number;
  motto?: string;
  share_study_time?: boolean;
  share_activity?: boolean;
  share_project?: boolean;
}

export async function register(payload: RegisterPayload): Promise<UserRead> {
  return apiFetch<UserRead>("/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function login(payload: LoginPayload): Promise<UserRead> {
  return apiFetch<UserRead>("/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function logout(): Promise<void> {
  await apiFetch<void>("/auth/logout", { method: "POST" });
}

export async function getMe(): Promise<UserRead> {
  return apiFetch<UserRead>("/auth/me");
}

export async function updateMe(payload: UserUpdate): Promise<UserRead> {
  return apiFetch<UserRead>("/users/me", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteMe(): Promise<void> {
  await apiFetch<void>("/users/me", { method: "DELETE" });
}
