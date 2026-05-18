/**
 * Pomodoro session API functions.
 */

import { apiFetch } from "./client";

export interface PomodoroSessionRead {
  id: number;
  user_id: number;
  session_type: "work" | "break";
  duration_minutes: number;
  is_completed: boolean;
  started_at: string;
  ended_at: string | null;
}

export async function listSessions(): Promise<PomodoroSessionRead[]> {
  return apiFetch<PomodoroSessionRead[]>("/pomodoro");
}

export async function startSession(
  sessionType: "work" | "break",
  durationMinutes: number,
): Promise<PomodoroSessionRead> {
  return apiFetch<PomodoroSessionRead>("/pomodoro", {
    method: "POST",
    body: JSON.stringify({ session_type: sessionType, duration_minutes: durationMinutes }),
  });
}

export async function completeSession(sessionId: number): Promise<PomodoroSessionRead> {
  return apiFetch<PomodoroSessionRead>(`/pomodoro/${sessionId}/complete`, {
    method: "PATCH",
    body: JSON.stringify({}),
  });
}

export async function deleteSession(sessionId: number): Promise<void> {
  await apiFetch<void>(`/pomodoro/${sessionId}`, { method: "DELETE" });
}
