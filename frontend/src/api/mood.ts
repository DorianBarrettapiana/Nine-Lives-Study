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

export async function listMoodEntries(days = 30): Promise<MoodEntryRead[]> {
  return apiFetch<MoodEntryRead[]>(`/mood?days=${days}`);
}

export async function createMoodEntry(
  payload: { mood: string; reflection: string },
): Promise<MoodEntryRead> {
  return apiFetch<MoodEntryRead>("/mood", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteMoodEntry(entryId: number): Promise<void> {
  return apiFetch<void>(`/mood/${entryId}`, { method: "DELETE" });
}
