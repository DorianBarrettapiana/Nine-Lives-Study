/**
 * Stats API functions.
 */

import { apiFetch } from "./client";

export interface DailyTaskStat {
  date: string;
  total: number;
  done: number;
}

export interface DailyMoodStat {
  date: string;
  mood: string;
}

export interface DailyPomodoroStat {
  date: string;
  count: number;
}

export interface UserStatsRead {
  days: number;
  daily_tasks: DailyTaskStat[];
  daily_moods: DailyMoodStat[];
  daily_pomodoros: DailyPomodoroStat[];
  total_tasks_done: number;
  total_pomodoros: number;
  total_notes: number;
  total_feynman: number;
  total_moods?: number;
}

export interface UserProgressRead {
  user_id: number;
  xp: number;
  level: number;
  xp_in_level: number;
  xp_to_next_level: number;
}

export async function getUserStats(days = 7): Promise<UserStatsRead> {
  return apiFetch<UserStatsRead>(`/stats?days=${days}`);
}

export async function getUserXp(): Promise<UserProgressRead> {
  return apiFetch<UserProgressRead>("/xp");
}
