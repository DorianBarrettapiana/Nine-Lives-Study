/**
 * Paper note API functions, plus the Zotero integration endpoints.
 */

import { ApiError, apiFetch } from "./client";
import type { TagSummary } from "./tags";

export type PaperReadingStatus = "inbox" | "reading" | "summarized" | "revisit";

export interface PaperNoteRead {
  id: number;
  user_id: number;
  title: string;
  authors: string;
  year: number | null;
  key_points: string;
  questions: string;
  tags: string;
  tag_list: TagSummary[];
  item_type: string | null;
  url: string | null;
  doi: string | null;
  abstract: string | null;
  zotero_key: string | null;
  zotero_version: number | null;
  source: string;
  feynman_entry_id: number | null;
  project_id: number | null;
  reading_status: PaperReadingStatus;
  reading_minutes: number;
  insight_count: number;
  latest_insight: PaperInsightRead | null;
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
  tag_names?: string[];
  item_type?: string | null;
  url?: string | null;
  doi?: string | null;
  abstract?: string | null;
  feynman_entry_id?: number | null;
  project_id?: number | null;
  reading_status?: PaperReadingStatus;
}

export type PaperNoteUpdate = Partial<PaperNoteCreate>;

export interface PaperInsightRead {
  id: number;
  paper_note_id: number;
  key_idea: string;
  question: string;
  next_step: string;
  created_at: string;
}

export interface ReadingContext {
  note_id: number;
  title: string;
  project_id: number | null;
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

export async function addNoteToToday(noteId: number): Promise<void> {
  await apiFetch(`/notes/${noteId}/add-to-today`, { method: "POST" });
}

export async function getReadingContext(taskId: number): Promise<ReadingContext | null> {
  try {
    return await apiFetch<ReadingContext>(`/notes/reading-context/${taskId}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function createPaperInsight(
  noteId: number,
  payload: { key_idea: string; question: string; next_step: string },
): Promise<PaperInsightRead> {
  return apiFetch<PaperInsightRead>(`/notes/${noteId}/insights`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// --- Zotero ----------------------------------------------------------------

export interface ZoteroConfig {
  connected: boolean;
  zotero_user_id: string | null;
}

export interface ZoteroItem {
  key: string;
  version: number;
  item_type: string;
  title: string;
  authors: string;
  year: number | null;
  tags: string;
  url: string;
  doi: string;
  abstract: string;
  already_imported: boolean;
}

export interface ZoteroItemsResponse {
  items: ZoteroItem[];
  total: number;
  start: number;
  limit: number;
}

export interface ZoteroImportResult {
  imported: number;
  updated: number;
  skipped: number;
  notes: PaperNoteRead[];
}

export async function getZoteroConfig(): Promise<ZoteroConfig> {
  return apiFetch<ZoteroConfig>("/notes/zotero/config");
}

export async function setZoteroConfig(
  zotero_user_id: string,
  api_key: string,
): Promise<ZoteroConfig> {
  return apiFetch<ZoteroConfig>("/notes/zotero/config", {
    method: "PUT",
    body: JSON.stringify({ zotero_user_id, api_key }),
    // Verifying creds against zotero.org adds a network hop on top of ours;
    // give it more headroom than the default 12s.
    timeoutMs: 25_000,
  });
}

export async function disconnectZotero(): Promise<void> {
  await apiFetch<void>("/notes/zotero/config", { method: "DELETE" });
}

export async function listZoteroItems(opts: {
  limit?: number;
  start?: number;
  q?: string;
} = {}): Promise<ZoteroItemsResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.start !== undefined) params.set("start", String(opts.start));
  if (opts.q) params.set("q", opts.q);
  const qs = params.toString();
  return apiFetch<ZoteroItemsResponse>(`/notes/zotero/items${qs ? `?${qs}` : ""}`, {
    timeoutMs: 25_000,
  });
}

export async function importZoteroItems(
  keys: string[],
  on_existing: "preserve" | "overwrite" = "preserve",
): Promise<ZoteroImportResult> {
  return apiFetch<ZoteroImportResult>("/notes/zotero/import", {
    method: "POST",
    body: JSON.stringify({ keys, on_existing }),
    timeoutMs: 30_000,
  });
}
