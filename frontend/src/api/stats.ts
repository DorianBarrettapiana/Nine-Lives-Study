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

export interface DailyWorkStat {
  date: string;
  minutes: number;
}

export interface WeeklySummaryCounts {
  work_minutes: number;
  tasks_done: number;
  notes: number;
  feynman: number;
  moods: number;
}

export interface WeeklySummary {
  this_week: WeeklySummaryCounts;
  prev_week: WeeklySummaryCounts;
}

export interface UserStatsRead {
  days: number;
  daily_tasks: DailyTaskStat[];
  daily_moods: DailyMoodStat[];
  daily_work_minutes: DailyWorkStat[];
  total_tasks_done: number;
  total_work_minutes: number;
  total_notes: number;
  total_feynman: number;
  total_moods?: number;
  weekly_summary?: WeeklySummary | null;
}

export interface UserProgressRead {
  user_id: number;
  xp: number;
  level: number;
  xp_in_level: number;
  xp_to_next_level: number;
  streak_days: number;
  streak_active_today: boolean;
}

export async function getUserStats(days = 7): Promise<UserStatsRead> {
  // tz_offset = minutes east of UTC, so the server can bucket events by the
  // caller's local day instead of UTC.
  const tz = new Date().getTimezoneOffset() * -1;
  return apiFetch<UserStatsRead>(`/stats?days=${days}&tz_offset=${tz}`);
}

export async function getUserXp(): Promise<UserProgressRead> {
  const tz = new Date().getTimezoneOffset() * -1;
  return apiFetch<UserProgressRead>(`/xp?tz_offset=${tz}`);
}
