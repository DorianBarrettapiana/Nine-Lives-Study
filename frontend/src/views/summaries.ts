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
  getWeeklyAvailability,
  listSummaries,
  setAiOptIn,
  type AiConfigRead,
  type AiSummaryRead,
  type WeeklyAvailability,
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
    // refreshAvailability decides the final button state — "Already
    // generated" on success, normal/off-day on failure — so we don't
    // hard-code anything here.
    void refreshAvailability();
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

  // Day-gate the Generate button. Server returns the same answer (so the
  // 429/400 keeps it honest), but doing the check up front turns a wrong
  // click into a greyed-out button with a helpful tooltip.
  await refreshAvailability();

  // After history loads, decide whether to fire the Tue/Fri ritual nudge.
  // Opted-in only — for un-opted users the always-visible button is enough
  // discovery; we shouldn't surprise-prompt people who haven't tried the
  // feature.
  if (config.user_opted_in) {
    maybePromptWeeklyRitual();
  }
}

async function refreshAvailability(): Promise<void> {
  if (!generateBtn) return;
  let avail: WeeklyAvailability;
  try {
    avail = await getWeeklyAvailability(-new Date().getTimezoneOffset());
  } catch (e) {
    console.warn("availability fetch failed", e);
    return;
  }
  if (avail.can_generate) {
    generateBtn.disabled = false;
    generateBtn.textContent = `Generate (${avail.slot})`;
    generateBtn.title = `${avail.slot} slot · creates ${avail.period_key}`;
  } else if (avail.reason === "off_day") {
    generateBtn.disabled = true;
    generateBtn.textContent = "Generate";
    generateBtn.title =
      `Weekly recap is available Tuesdays and Fridays. ` +
      `Next slot: ${avail.next_slot ?? "Tuesday"}.`;
  } else if (avail.reason === "already_generated") {
    generateBtn.disabled = true;
    generateBtn.textContent = "Already generated";
    generateBtn.title = `You've already generated ${avail.period_key}. ` +
      `The other slot or next week unlocks the button.`;
  }
}

// --- Weekly-ritual nudge ----------------------------------------------------
//
// Fires Tuesday 18:00+ and Friday 18:00+ local time — matching the only two
// days the server lets the user generate. Modal asks once per slot;
// localStorage carries the dismissal flag (per period_key, so next week's
// matching day fires fresh).
//
// Server-side state is the source of truth via `getWeeklyAvailability()`:
// if the slot is already generated, no prompt. We don't replicate the
// server's day check on the client (it's redundant with the availability
// fetch), but we still gate on time-of-day so morning lectures aren't
// interrupted by an evening-reflection nudge.

const PROMPT_DISMISSED_PREFIX = "nl_ai_prompt_dismissed_";

async function maybePromptWeeklyRitual(): Promise<void> {
  const now = new Date();
  // Tue=2, Fri=5 in JS getDay() (Sun=0).
  const isRitualDay = now.getDay() === 2 || now.getDay() === 5;
  if (!isRitualDay) return;
  if (now.getHours() < 18) return;

  // Server tells us whether this slot is still open. If it isn't (or it's
  // an off-day per the server — should agree with our local check, but
  // server is authoritative), no prompt.
  let avail: WeeklyAvailability;
  try {
    avail = await getWeeklyAvailability(-now.getTimezoneOffset());
  } catch {
    return;
  }
  if (!avail.can_generate || !avail.period_key || !avail.slot) return;

  // Dedupe: user dismissed this slot already.
  if (localStorage.getItem(PROMPT_DISMISSED_PREFIX + avail.period_key)) return;

  setTimeout(
    () => void showWeeklyRitualPrompt(avail.period_key!, avail.slot!),
    1500,
  );
}

async function showWeeklyRitualPrompt(periodKey: string, slot: string): Promise<void> {
  const accepted = await new Promise<boolean>((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="ai-ritual-title">
        <h3 id="ai-ritual-title">${escapeHtml(slot)} evening — recap this week?</h3>
        <p>Claude can turn this week's data into a short narrative you can reflect on or share with your advisor.</p>
        <p class="hint">Takes about 10 seconds. We'll only ask once per ${escapeHtml(slot)} slot.</p>
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
