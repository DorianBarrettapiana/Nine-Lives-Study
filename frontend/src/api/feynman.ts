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
  created_at: string;
  updated_at: string;
}

export interface FeynmanEntryCreate {
  concept: string;
  explanation: string;
  gaps: string;
  analogy: string;
}

export interface FeynmanEntryUpdate {
  concept?: string;
  explanation?: string;
  gaps?: string;
  analogy?: string;
}

export async function listFeynmanEntries(userId: number): Promise<FeynmanEntryRead[]> {
  return apiFetch<FeynmanEntryRead[]>(`/users/${userId}/feynman`);
}

export async function createFeynmanEntry(
  userId: number,
  payload: FeynmanEntryCreate,
): Promise<FeynmanEntryRead> {
  return apiFetch<FeynmanEntryRead>(`/users/${userId}/feynman`, {
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