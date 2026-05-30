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
  linked_task_id: number | null;
}

export async function getActive(): Promise<StopwatchSessionRead | null> {
  return apiFetch<StopwatchSessionRead | null>("/stopwatch/active");
}

export async function startStopwatch(
  linkedTaskId: number | null = null,
): Promise<StopwatchSessionRead> {
  return apiFetch<StopwatchSessionRead>("/stopwatch/start", {
    method: "POST",
    body: JSON.stringify({ linked_task_id: linkedTaskId }),
  });
}

/** Mid-session task switch. Pass null to unlink. */
export async function updateStopwatchTask(
  sessionId: number,
  linkedTaskId: number | null,
): Promise<StopwatchSessionRead> {
  return apiFetch<StopwatchSessionRead>(`/stopwatch/${sessionId}/task`, {
    method: "PATCH",
    body: JSON.stringify({ linked_task_id: linkedTaskId }),
  });
}

export async function pauseStopwatch(
  sessionId: number,
  clientElapsedSeconds?: number,
): Promise<StopwatchSessionRead> {
  // We pass the client's idea of the running-segment length so the server
  // can cap accumulated_seconds at that value. Without this cap, a slow
  // network turns "click Pause, walk away" into "server thinks you kept
  // working until the request finally arrived" — inflating accumulated.
  const qs = clientElapsedSeconds !== undefined
    ? `?client_elapsed_seconds=${Math.max(0, Math.floor(clientElapsedSeconds))}`
    : "";
  return apiFetch<StopwatchSessionRead>(`/stopwatch/${sessionId}/pause${qs}`, { method: "POST" });
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
