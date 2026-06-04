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

export interface WorkLabelStat {
  label: string;
  minutes: number;
}

export interface ProjectTimeStat {
  project_id: number | null;
  name: string;
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
  work_labels: WorkLabelStat[];
  time_per_project?: ProjectTimeStat[];
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
  today_work_minutes: number;
  today_work_minutes_goal: number;
  is_today_perfect: boolean;
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

export interface LabelRelabelResult {
  updated_sessions: number;
  from_label: string;
  to_label: string;
}

/**
 * Rename or merge a focus (time-usage) label across all sessions.
 * Passing an existing label as `to` merges the two buckets; a new name
 * just renames. Applied globally on the server.
 */
export async function relabelFocusLabel(
  from: string,
  to: string,
): Promise<LabelRelabelResult> {
  return apiFetch<LabelRelabelResult>("/stats/labels/relabel", {
    method: "POST",
    body: JSON.stringify({ from_label: from, to_label: to }),
  });
}
