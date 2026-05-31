/**
 * Feynman entry API functions.
 */

import { apiFetch } from "./client";

export interface FeynmanEntryRead {
  id: number;
  user_id: number;
  concept: string;
  explanation: string;
  gaps: string;
  analogy: string;
  project_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface FeynmanEntryCreate {
  concept: string;
  explanation: string;
  gaps: string;
  analogy: string;
  project_id?: number | null;
}

export interface FeynmanEntryUpdate {
  concept?: string;
  explanation?: string;
  gaps?: string;
  analogy?: string;
  project_id?: number | null;
}

export async function listFeynmanEntries(): Promise<FeynmanEntryRead[]> {
  return apiFetch<FeynmanEntryRead[]>("/feynman");
}

export async function createFeynmanEntry(
  payload: FeynmanEntryCreate,
): Promise<FeynmanEntryRead> {
  return apiFetch<FeynmanEntryRead>("/feynman", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateFeynmanEntry(
  entryId: number,
  payload: FeynmanEntryUpdate,
): Promise<FeynmanEntryRead> {
  return apiFetch<FeynmanEntryRead>(`/feynman/${entryId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteFeynmanEntry(entryId: number): Promise<void> {
  await apiFetch<void>(`/feynman/${entryId}`, {
    method: "DELETE",
  });
}