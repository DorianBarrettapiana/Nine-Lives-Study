/**
 * AI summary API.
 *
 * The deployment may or may not have ANTHROPIC_API_KEY configured server-side.
 * `getConfig()` is the source of truth for whether to show AI UI at all.
 * Routes 503 when the key is missing; the frontend hides the section instead
 * of letting the user click into a dead button.
 */

import { apiFetch } from "./client";

export type SummaryKind = "weekly" | "paper_notes" | "feynman_review" | "reflections";

export interface AiSummaryRead {
  id: number;
  kind: SummaryKind;
  period_key: string;
  content: string;  // markdown
  model: string;
  generated_at: string;  // ISO 8601 with Z
}

export interface AiConfigRead {
  enabled: boolean;        // server has ANTHROPIC_API_KEY
  user_opted_in: boolean;  // user has accepted the data-sharing notice
}

export async function getAiConfig(): Promise<AiConfigRead> {
  return apiFetch<AiConfigRead>("/summaries/config");
}

export async function setAiOptIn(optedIn: boolean): Promise<AiConfigRead> {
  return apiFetch<AiConfigRead>("/summaries/opt-in", {
    method: "POST",
    body: JSON.stringify({ opted_in: optedIn }),
  });
}

export async function listSummaries(kind: SummaryKind): Promise<AiSummaryRead[]> {
  return apiFetch<AiSummaryRead[]>(`/summaries/${kind}`);
}

export interface WeeklyAvailability {
  can_generate: boolean;
  // Present when can_generate=true: human label of the current slot.
  slot?: "Tuesday" | "Friday";
  // Present in most responses: which (kind, period_key) this slot would write.
  period_key?: string;
  // "off_day" — today isn't Tue/Fri; `next_slot` names the next available day.
  // "already_generated" — this slot's row already exists in the DB.
  reason?: "off_day" | "already_generated";
  next_slot?: "Tuesday" | "Friday";
}

export async function getWeeklyAvailability(
  tzOffsetMinutes: number,
): Promise<WeeklyAvailability> {
  return apiFetch<WeeklyAvailability>(
    `/summaries/weekly/availability?tz_offset=${tzOffsetMinutes}`,
  );
}

export async function generateWeekly(tzOffsetMinutes: number): Promise<AiSummaryRead> {
  // The server anchors the week on the caller's local Monday — same
  // convention stats uses (minutes east of UTC, JS sign-flipped).
  return apiFetch<AiSummaryRead>(
    `/summaries/weekly/generate?tz_offset=${tzOffsetMinutes}`,
    {
      method: "POST",
      // Allow extra time: the Claude call streams thinking + ~250 words.
      // Typical generation takes 5-15s; give 60s headroom for cold paths.
      timeoutMs: 60_000,
    },
  );
}

export async function generateFeynmanReview(entryId: number): Promise<AiSummaryRead> {
  return apiFetch<AiSummaryRead>(`/summaries/feynman/${entryId}/generate`, {
    method: "POST",
    timeoutMs: 60_000,
  });
}

export async function generatePaperNoteThemes(days = 30): Promise<AiSummaryRead> {
  return apiFetch<AiSummaryRead>(`/summaries/paper-notes/generate?days=${days}`, {
    method: "POST",
    timeoutMs: 60_000,
  });
}
