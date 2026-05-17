/**
 * Mood entry API functions.
 */

import { apiFetch } from "./client";

export interface MoodEntryRead {
  id: number;
  user_id: number;
  mood: string;
  reflection: string;
  created_at: string;
}

export async function listMoodEntries(userId: number, days = 30): Promise<MoodEntryRead[]> {
  return apiFetch<MoodEntryRead[]>(`/users/${userId}/mood?days=${days}`);
}

export async function createMoodEntry(
  userId: number,
  payload: { mood: string; reflection: string },
): Promise<MoodEntryRead> {
  return apiFetch<MoodEntryRead>(`/users/${userId}/mood`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteMoodEntry(entryId: number): Promise<void> {
  return apiFetch<void>(`/mood/${entryId}`, { method: "DELETE" });
}
