/**
 * Milestone API functions.
 *
 * A milestone is a date-anchored target (conference deadline, defense,
 * chapter due). Lives at the week/month timescale — distinct from a
 * daily task. Optionally bound to a Project.
 */

import { apiFetch } from "./client";

export interface MilestoneRead {
  id: number;
  user_id: number;
  title: string;
  due_date: string;        // YYYY-MM-DD
  project_id: number | null;
  notes: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface MilestoneCreate {
  title: string;
  due_date: string;
  project_id?: number | null;
  notes?: string;
}

export interface MilestoneUpdate {
  title?: string;
  due_date?: string;
  project_id?: number | null;
  notes?: string;
  is_archived?: boolean;
}

export async function listMilestones(opts: {
  includeArchived?: boolean;
  onlyFuture?: boolean;
} = {}): Promise<MilestoneRead[]> {
  const params = new URLSearchParams();
  if (opts.includeArchived) params.set("include_archived", "true");
  if (opts.onlyFuture) params.set("only_future", "true");
  const qs = params.toString();
  return apiFetch<MilestoneRead[]>(`/milestones${qs ? `?${qs}` : ""}`);
}

export async function createMilestone(payload: MilestoneCreate): Promise<MilestoneRead> {
  return apiFetch<MilestoneRead>("/milestones", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateMilestone(
  id: number,
  payload: MilestoneUpdate,
): Promise<MilestoneRead> {
  return apiFetch<MilestoneRead>(`/milestones/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteMilestone(id: number): Promise<void> {
  await apiFetch<void>(`/milestones/${id}`, { method: "DELETE" });
}
