/**
 * AI weekly-recap card inside the Stats view.
 *
 * Lifecycle:
 *  - init() runs once on app boot. It fetches /summaries/config and either
 *    reveals the card or leaves it hidden (no AI on the server → no UI).
 *  - On Generate click: first invocation flows through a consent modal
 *    (data-sharing notice). Subsequent invocations skip straight to the
 *    Claude call. Result renders as Markdown in-place.
 *
 * Markdown rendering is hand-rolled (no library) — the server emits a
 * narrow subset (h2/h3, bullets, **bold**, paragraphs). Adding marked or
 * markdown-it would balloon the bundle by ~30KB for this one feature.
 */

import {
  generateWeekly,
  getAiConfig,
  listSummaries,
  setAiOptIn,
  type AiConfigRead,
  type AiSummaryRead,
} from "../api/summaries";
import { ApiError } from "../api/client";
import { escapeHtml, flashMessage, parseApiDate, setMessage } from "../utils";

let cardEl: HTMLElement | null = null;
let generateBtn: HTMLButtonElement | null = null;
let contentEl: HTMLDivElement | null = null;
let metaEl: HTMLParagraphElement | null = null;
let messageEl: HTMLParagraphElement | null = null;

let config: AiConfigRead | null = null;

// --- Tiny markdown renderer -------------------------------------------------
// Supports: `## heading`, `### heading`, `**bold**`, `- bullet`, blank-line
// paragraphs. Everything is escapeHtml'd first, so user content from Claude
// can't inject script tags even if the model went rogue.

function renderMarkdown(md: string): string {
  const safe = escapeHtml(md);
  const lines = safe.split("\n");
  const out: string[] = [];
  let inList = false;

  const flushList = (): void => {
    if (inList) { out.push("</ul>"); inList = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushList(); continue; }

    // Bullet
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${applyInline(bullet[1])}</li>`);
      continue;
    }
    flushList();

    // Headings — match h2/h3 (model emits ## and ### per the prompts)
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) { out.push(`<h3>${applyInline(h3[1])}</h3>`); continue; }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) { out.push(`<h3>${applyInline(h2[1])}</h3>`); continue; }
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) { out.push(`<h3>${applyInline(h1[1])}</h3>`); continue; }

    // Plain paragraph
    out.push(`<p>${applyInline(line)}</p>`);
  }
  flushList();
  return out.join("\n");
}

function applyInline(text: string): string {
  // Bold (**...**) — already-escaped, so we're transforming `&amp;**x**` safely.
  return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// --- UI state helpers -------------------------------------------------------

function showSummary(s: AiSummaryRead, { expanded = false }: { expanded?: boolean } = {}): void {
  if (!contentEl || !metaEl) return;
  const when = parseApiDate(s.generated_at).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  // Wrap in <details> so re-opening the Stats view shows a compact one-line
  // summary instead of an unprompted wall of markdown. Just-generated
  // summaries open expanded (the user clicked Generate seconds ago and wants
  // to read the result without an extra click); historical ones stay folded.
  contentEl.innerHTML = `
    <details class="ai-summary-details" ${expanded ? "open" : ""}>
      <summary>Recap for ${s.period_key} · generated ${when}</summary>
      <div class="ai-summary-body">${renderMarkdown(s.content)}</div>
    </details>
  `;
  metaEl.textContent = `${s.model}`;
}

function clearSummary(): void {
  if (contentEl) contentEl.innerHTML = "";
  if (metaEl) metaEl.textContent = "";
}

// --- Consent modal ----------------------------------------------------------
// Built ad-hoc; if we add more modals later, lift to a shared util.

function showConsentModal(): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="ai-consent-title">
        <h3 id="ai-consent-title">Send your data to Claude?</h3>
        <p>To generate this summary, your week's <strong>work-time numbers, task counts, mood entries, and reflection text</strong> will be sent to Anthropic's Claude API.</p>
        <p class="hint">No passwords, paper notes, or Feynman entries are sent for the weekly recap. You can revoke consent later in settings.</p>
        <div class="modal-actions">
          <button type="button" class="secondary" data-ai-consent="cancel">Not now</button>
          <button type="button" data-ai-consent="ok">I agree, generate</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const close = (result: boolean): void => {
      backdrop.remove();
      resolve(result);
    };
    backdrop.addEventListener("click", (e) => {
      const t = e.target;
      if (t === backdrop) close(false);
      if (t instanceof HTMLElement && t.dataset.aiConsent) {
        close(t.dataset.aiConsent === "ok");
      }
    });
    document.addEventListener("keydown", function escHandler(e) {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", escHandler);
        close(false);
      }
    });
  });
}

// --- Main action ------------------------------------------------------------

async function onGenerateClick(): Promise<void> {
  if (!config || !generateBtn || !messageEl) return;

  // Ensure opt-in. First-time path goes through the consent modal.
  if (!config.user_opted_in) {
    const agreed = await showConsentModal();
    if (!agreed) return;
    try {
      config = await setAiOptIn(true);
    } catch (e) {
      setMessage(messageEl, parseError(e), "error");
      return;
    }
  }

  generateBtn.disabled = true;
  generateBtn.textContent = "Generating…";
  setMessage(messageEl, "Asking Claude to summarize this week…", "neutral");

  try {
    const tzOffset = -new Date().getTimezoneOffset();  // minutes east of UTC
    const summary = await generateWeekly(tzOffset);
    // Just-generated: auto-expand so the user reads it without another click.
    showSummary(summary, { expanded: true });
    flashMessage(messageEl, "Recap ready.", "success");
  } catch (e) {
    setMessage(messageEl, parseError(e), "error");
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate";
  }
}

function parseError(e: unknown): string {
  if (e instanceof ApiError) {
    try {
      const parsed = JSON.parse(e.body) as { detail?: string };
      if (parsed?.detail) return parsed.detail;
    } catch { /* fall through */ }
  }
  return "Could not generate summary.";
}

// --- Init ------------------------------------------------------------------

export async function init(): Promise<void> {
  cardEl = document.querySelector<HTMLElement>("#ai-summary-card");
  generateBtn = document.querySelector<HTMLButtonElement>("#ai-summary-generate");
  contentEl = document.querySelector<HTMLDivElement>("#ai-summary-content");
  metaEl = document.querySelector<HTMLParagraphElement>("#ai-summary-meta");
  messageEl = document.querySelector<HTMLParagraphElement>("#ai-summary-message");

  if (!cardEl || !generateBtn) return;

  try {
    config = await getAiConfig();
  } catch (e) {
    console.warn("AI config fetch failed; hiding section.", e);
    return;
  }

  if (!config.enabled) {
    // Server doesn't have ANTHROPIC_API_KEY — leave card hidden.
    return;
  }
  cardEl.classList.remove("hidden");

  generateBtn.addEventListener("click", () => void onGenerateClick());

  // Surface the most recent prior recap so re-opening the view doesn't show
  // a blank card. listSummaries is cheap (no AI call) — fine on init.
  let history: AiSummaryRead[] = [];
  try {
    history = await listSummaries("weekly");
    if (history.length > 0) showSummary(history[0]);
    else clearSummary();
  } catch (e) {
    console.warn("AI summary history fetch failed.", e);
  }

  // After history loads, decide whether to fire the weekly-ritual nudge.
  // Opted-in only — for un-opted users the always-visible Generate button
  // is enough discovery; we shouldn't surprise-prompt people who haven't
  // even tried the feature.
  if (config.user_opted_in) {
    maybePromptWeeklyRitual(history);
  }
}

// --- Weekly-ritual nudge ----------------------------------------------------
//
// Fires Sunday 18:00+ local time (ISO weeks end on Sunday, so this anchors
// the prompt at the natural end-of-week reflection point). The modal asks
// once per ISO week; localStorage carries the dismissal flag, and an
// already-generated summary for this period also suppresses it.
//
// Why client-side trigger instead of a server cron: the user's *local*
// Sunday evening is what matters (CEST 20:00 ≠ EST 14:00), and the app
// is the only place we know that. Server-side scheduling would need a
// per-user TZ field, plus delivery via email or push (we have neither).

const PROMPT_DISMISSED_PREFIX = "nl_ai_prompt_dismissed_";

function isoWeekKey(localDate: Date): string {
  // Match Python's isocalendar(): ISO 8601 weeks (Mon=1..Sun=7, week
  // containing Jan 4 is W01). We build a UTC date from the local Y/M/D
  // bytes — the standard trick to compute calendar weeks while sidestepping
  // DST drift inside arithmetic.
  const d = new Date(Date.UTC(localDate.getFullYear(), localDate.getMonth(), localDate.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function shouldPromptWeekly(now: Date): { periodKey: string } | null {
  // Sunday 18:00 local time onwards. Avoid prompting during work hours
  // earlier in the day — the ritual is an end-of-week reflection, not a
  // mid-afternoon interruption.
  if (now.getDay() !== 0) return null;
  if (now.getHours() < 18) return null;
  return { periodKey: isoWeekKey(now) };
}

function maybePromptWeeklyRitual(history: AiSummaryRead[]): void {
  const target = shouldPromptWeekly(new Date());
  if (target === null) return;

  // Dedupe layer 1: user already saw the modal this period and said "Not now".
  if (localStorage.getItem(PROMPT_DISMISSED_PREFIX + target.periodKey)) return;

  // Dedupe layer 2: a summary for this period already exists in history —
  // user already generated, no need to prompt again.
  if (history.some((s) => s.period_key === target.periodKey)) return;

  // Small delay so the prompt doesn't slam the user the millisecond the app
  // mounts — feels more like "the app noticed it's Sunday evening" than a
  // hostile popup.
  setTimeout(() => void showWeeklyRitualPrompt(target.periodKey), 1500);
}

async function showWeeklyRitualPrompt(periodKey: string): Promise<void> {
  const accepted = await new Promise<boolean>((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="ai-ritual-title">
        <h3 id="ai-ritual-title">It's Sunday evening — recap this week?</h3>
        <p>Claude can turn this week's data into a short narrative you can reflect on or share with your advisor.</p>
        <p class="hint">Takes about 10 seconds. We'll only ask once per week.</p>
        <div class="modal-actions">
          <button type="button" class="secondary" data-ai-ritual="cancel">Not now</button>
          <button type="button" data-ai-ritual="ok">Generate recap</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const close = (v: boolean): void => { backdrop.remove(); resolve(v); };
    backdrop.addEventListener("click", (e) => {
      const t = e.target;
      if (t === backdrop) close(false);
      if (t instanceof HTMLElement && t.dataset.aiRitual) {
        close(t.dataset.aiRitual === "ok");
      }
    });
    document.addEventListener("keydown", function escHandler(e) {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", escHandler);
        close(false);
      }
    });
  });

  if (!accepted) {
    // Remember the dismissal so we don't re-prompt them later the same
    // evening. Storage scoped per-period — next Sunday's prompt fires fresh.
    localStorage.setItem(PROMPT_DISMISSED_PREFIX + periodKey, "1");
    return;
  }

  // Bring the stats view into focus so the user actually sees the result
  // landing in the card, then trigger generation through the normal path.
  document.querySelector<HTMLButtonElement>('.feature-tab[data-view="stats"]')?.click();
  void onGenerateClick();
}
