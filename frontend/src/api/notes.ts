/**
 * Paper note API functions.
 */

import { apiFetch } from "./client";

export interface PaperNoteRead {
  id: number;
  user_id: number;
  title: string;
  authors: string;
  year: number | null;
  key_points: string;
  questions: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface PaperNoteCreate {
  title: string;
  authors: string;
  year: number | null;
  key_points: string;
  questions: string;
  tags: string;
}

export interface PaperNoteUpdate {
  title?: string;
  authors?: string;
  year?: number | null;
  key_points?: string;
  questions?: string;
  tags?: string;
}

export async function listNotes(): Promise<PaperNoteRead[]> {
  return apiFetch<PaperNoteRead[]>("/notes");
}

export async function createNote(payload: PaperNoteCreate): Promise<PaperNoteRead> {
  return apiFetch<PaperNoteRead>("/notes", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateNote(
  noteId: number,
  payload: PaperNoteUpdate,
): Promise<PaperNoteRead> {
  return apiFetch<PaperNoteRead>(`/notes/${noteId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteNote(noteId: number): Promise<void> {
  await apiFetch<void>(`/notes/${noteId}`, {
    method: "DELETE",
  });
}
