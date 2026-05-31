/**
 * Shared helpers for the small, contextual AI actions.
 */

import { ApiError } from "../api/client";
import { getAiConfig, setAiOptIn } from "../api/summaries";
import { escapeHtml } from "../utils";

export async function isAiEnabled(): Promise<boolean> {
  try {
    return (await getAiConfig()).enabled;
  } catch {
    return false;
  }
}

export async function ensureAiConsent(dataDescription: string): Promise<boolean> {
  const config = await getAiConfig();
  if (!config.enabled) throw new Error("AI feedback is not configured on this server.");
  if (config.user_opted_in) return true;
  const agreed = window.confirm(
    `Generate AI feedback?\n\n${dataDescription} will be sent to Anthropic's Claude API. ` +
    "No password or account data is included.",
  );
  if (!agreed) return false;
  await setAiOptIn(true);
  return true;
}

export function aiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.body) as { detail?: string };
      if (parsed.detail) return parsed.detail;
    } catch { /* use fallback */ }
  }
  return error instanceof Error ? error.message : "Could not generate AI feedback.";
}

export function renderAiMarkdown(markdown: string): string {
  const safe = escapeHtml(markdown);
  const lines = safe.split("\n");
  const html: string[] = [];
  let inList = false;
  const closeList = (): void => {
    if (inList) { html.push("</ul>"); inList = false; }
  };
  const inline = (text: string): string =>
    text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) { html.push("<ul>"); inList = true; }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    closeList();
    const heading = line.match(/^#{1,3}\s+(.*)$/);
    html.push(heading ? `<h3>${inline(heading[1])}</h3>` : `<p>${inline(line)}</p>`);
  }
  closeList();
  return html.join("\n");
}
