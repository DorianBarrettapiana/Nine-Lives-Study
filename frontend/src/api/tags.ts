/**
 * Cross-module tag API.
 *
 * Tags are user-scoped labels reused across paper notes, Feynman entries,
 * and daily tasks. Most write operations happen implicitly: send
 * `tag_names: string[]` on item create/update and the backend will
 * resolve-or-create. This client only covers the explicit tag CRUD +
 * the per-tag drill-down view.
 */

import { apiFetch } from "./client";
import type { PaperNoteRead } from "./notes";

export interface TagSummary {
  id: number;
  name: string;
  color: string;
}

export interface TagRead {
  id: number;
  user_id: number;
  name: string;
  color: string;
  use_count: number;
  paper_note_count: number;
  feynman_entry_count: number;
  daily_task_count: number;
  created_at: string;
  updated_at: string;
}

// Minimal shapes to keep the drill-down typed without circular imports.
export interface TagFeynmanItem {
  id: number;
  concept: string;
  tag_list: TagSummary[];
}

export interface TagTaskItem {
  id: number;
  text: string;
  task_date: string;
  is_done: boolean;
  tag_list: TagSummary[];
}

export interface TagItemsRead {
  tag: TagRead;
  paper_notes: PaperNoteRead[];
  feynman_entries: TagFeynmanItem[];
  daily_tasks: TagTaskItem[];
}

export async function listTags(): Promise<TagRead[]> {
  return apiFetch<TagRead[]>("/tags");
}

export async function createTag(name: string, color: string = ""): Promise<TagRead> {
  return apiFetch<TagRead>("/tags", {
    method: "POST",
    body: JSON.stringify({ name, color }),
  });
}

export async function updateTag(
  tagId: number,
  payload: { name?: string; color?: string },
): Promise<TagRead> {
  return apiFetch<TagRead>(`/tags/${tagId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteTag(tagId: number): Promise<void> {
  await apiFetch<void>(`/tags/${tagId}`, { method: "DELETE" });
}

export async function getTagItems(tagId: number): Promise<TagItemsRead> {
  return apiFetch<TagItemsRead>(`/tags/${tagId}/items`);
}
