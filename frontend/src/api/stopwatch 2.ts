/**
 * Stopwatch ("positive timing") API functions.
 */

import { apiFetch } from "./client";

export interface StopwatchSessionRead {
  id: number;
  started_at: string;
  ended_at: string | null;
  accumulated_seconds: number;
  last_started_at: string | null;
  is_running: boolean;
  elapsed_seconds: number;
}

export async function getActive(): Promise<StopwatchSessionRead | null> {
  return apiFetch<StopwatchSessionRead | null>("/stopwatch/active");
}

export async function startStopwatch(): Promise<StopwatchSessionRead> {
  return apiFetch<StopwatchSessionRead>("/stopwatch/start", { method: "POST" });
}

export async function pauseStopwatch(sessionId: number): Promise<StopwatchSessionRead> {
  return apiFetch<StopwatchSessionRead>(`/stopwatch/${sessionId}/pause`, { method: "POST" });
}

export async function resumeStopwatch(sessionId: number): Promise<StopwatchSessionRead> {
  return apiFetch<StopwatchSessionRead>(`/stopwatch/${sessionId}/resume`, { method: "POST" });
}

export async function endStopwatch(sessionId: number): Promise<StopwatchSessionRead> {
  return apiFetch<StopwatchSessionRead>(`/stopwatch/${sessionId}/end`, { method: "POST" });
}

export async function deleteStopwatch(sessionId: number): Promise<void> {
  await apiFetch<void>(`/stopwatch/${sessionId}`, { method: "DELETE" });
}
