/**
 * AI summary API.
 *
 * The deployment may or may not have ANTHROPIC_API_KEY configured server-side.
 * `getConfig()` is the source of truth for whether to show AI UI at all.
 * Routes 503 when the key is missing; the frontend hides the section instead
 * of letting the user click into a dead button.
 */

import { apiFetch } from "./client";

export type SummaryKind = "weekly" | "monthly" | "stage" | "feynman_review" | "reflections";
export type ProgressSummaryKind = "monthly" | "stage";

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
  // After the Tuesday slot was dropped, this is always "Friday" — kept
  // as a string for forward-compat with future slot additions.
  slot?: string;
  // Present in most responses: which (kind, period_key) this slot would write.
  period_key?: string;
  // "off_day" — today isn't a slot day; `next_slot` names the next available.
  // "already_generated" — this slot's row already exists in the DB.
  reason?: "off_day" | "already_generated";
  next_slot?: string;
}

export interface MonthlyAvailability {
  can_generate: boolean;
  period_key?: string;          // YYYY-MM
  reason?: "off_window" | "already_generated";
  next_available?: string;      // YYYY-MM-DD — first day the window reopens
  window_days?: number;         // how many end-of-month days are eligible
}

export interface StageAvailability {
  can_generate: boolean;
  reason?: "cooldown";
  next_available?: string;      // YYYY-MM-DD — when the 90-day cooldown ends
  cooldown_days: number;
}

export async function getWeeklyAvailability(
  tzOffsetMinutes: number,
): Promise<WeeklyAvailability> {
  return apiFetch<WeeklyAvailability>(
    `/summaries/weekly/availability?tz_offset=${tzOffsetMinutes}`,
  );
}

export async function getMonthlyAvailability(
  tzOffsetMinutes: number,
): Promise<MonthlyAvailability> {
  return apiFetch<MonthlyAvailability>(
    `/summaries/monthly/availability?tz_offset=${tzOffsetMinutes}`,
  );
}

export async function getStageAvailability(): Promise<StageAvailability> {
  return apiFetch<StageAvailability>("/summaries/stage/availability");
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

export async function generateProgressRecap(
  period: ProgressSummaryKind,
  tzOffsetMinutes: number,
  days = 90,
): Promise<AiSummaryRead> {
  return apiFetch<AiSummaryRead>(
    `/summaries/progress/${period}/generate?tz_offset=${tzOffsetMinutes}&days=${days}`,
    { method: "POST", timeoutMs: 60_000 },
  );
}

export async function generateFeynmanReview(entryId: number): Promise<AiSummaryRead> {
  return apiFetch<AiSummaryRead>(`/summaries/feynman/${entryId}/generate`, {
    method: "POST",
    timeoutMs: 60_000,
  });
}
