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

function showSummary(s: AiSummaryRead): void {
  if (!contentEl || !metaEl) return;
  contentEl.innerHTML = renderMarkdown(s.content);
  const when = parseApiDate(s.generated_at).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  metaEl.textContent = `Generated ${when} · ${s.period_key} · ${s.model}`;
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
    showSummary(summary);
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
  try {
    const history = await listSummaries("weekly");
    if (history.length > 0) showSummary(history[0]);
    else clearSummary();
  } catch (e) {
    console.warn("AI summary history fetch failed.", e);
  }
}
