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
  generateProgressRecap,
  getAiConfig,
  getMonthlyAvailability,
  getStageAvailability,
  getWeeklyAvailability,
  listSummaries,
  setAiOptIn,
  type AiConfigRead,
  type AiSummaryRead,
  type MonthlyAvailability,
  type StageAvailability,
  type WeeklyAvailability,
  type ProgressSummaryKind,
} from "../api/summaries";
import { ApiError } from "../api/client";
import { createDailyTask } from "../api/tracker";
import { escapeHtml, flashMessage, parseApiDate, setMessage } from "../utils";
import { getCachedProjects } from "./project-state";

let cardEl: HTMLElement | null = null;
let generateBtn: HTMLButtonElement | null = null;
let monthlyBtn: HTMLButtonElement | null = null;
let stageBtn: HTMLButtonElement | null = null;
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

// Match the trailing `**Next step:** <action>` line the prompt asks Claude
// to emit. Group 1 is the action text (max ~80 chars per the prompt). We
// strip that line from the body and render it as an action button below
// the markdown — turns a passive recap into a one-click follow-through.
const NEXT_STEP_RE = /\*\*Next step:\*\*\s*(.+?)\s*$/m;
const NEXT_DUE_RE = /^\*\*Due:\*\*\s*(\d{4}-\d{2}-\d{2})\s*$/m;
const NEXT_PROJECT_RE = /^\*\*Project:\*\*\s*(.+?)\s*$/m;

interface NextStep {
  text: string;
  dueDate: string | null;
  projectName: string | null;
}

function extractNextStep(md: string): { body: string; nextStep: NextStep | null } {
  const match = md.match(NEXT_STEP_RE);
  if (match === null) return { body: md, nextStep: null };
  const due = md.match(NEXT_DUE_RE);
  const project = md.match(NEXT_PROJECT_RE);
  const body = md
    .replace(NEXT_STEP_RE, "")
    .replace(NEXT_DUE_RE, "")
    .replace(NEXT_PROJECT_RE, "")
    .trimEnd();
  return {
    body,
    nextStep: {
      text: match[1].trim(),
      dueDate: due?.[1] ?? null,
      projectName: project?.[1]?.trim() ?? null,
    },
  };
}

function showSummary(s: AiSummaryRead, { expanded = false }: { expanded?: boolean } = {}): void {
  if (!contentEl || !metaEl) return;
  const when = parseApiDate(s.generated_at).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const { body, nextStep } = extractNextStep(s.content);
  // Wrap in <details> so re-opening the Stats view shows a compact one-line
  // summary instead of an unprompted wall of markdown. Just-generated
  // summaries open expanded (the user clicked Generate seconds ago and wants
  // to read the result without an extra click); historical ones stay folded.
  contentEl.innerHTML = `
    <details class="ai-summary-details" ${expanded ? "open" : ""}>
      <summary>Recap for ${s.period_key} · generated ${when}</summary>
      <div class="ai-summary-body">${renderMarkdown(body)}</div>
      ${nextStep !== null ? renderNextStepAction(nextStep) : ""}
      <div class="ai-summary-actions">
        <button type="button" class="secondary" data-ai-action="copy-markdown">Copy Markdown</button>
      </div>
    </details>
  `;
  if (nextStep !== null) wireNextStepButton(nextStep);
  wireCopyMarkdownButton(s.content);
  metaEl.textContent = `${s.model}`;
}

function wireCopyMarkdownButton(markdown: string): void {
  if (contentEl === null) return;
  const btn = contentEl.querySelector<HTMLButtonElement>('[data-ai-action="copy-markdown"]');
  if (btn === null) return;
  btn.addEventListener("click", () => {
    void copyMarkdown(markdown, btn);
  });
}

async function copyMarkdown(markdown: string, btn: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(markdown);
    btn.textContent = "✓ Copied";
  } catch {
    const area = document.createElement("textarea");
    area.value = markdown;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    btn.textContent = "✓ Copied";
  }
}

function renderNextStepAction(nextStep: NextStep): string {
  // Render the suggestion as a quote-styled block with an inline action.
  // No state-tracking for "already added" — the button is one-shot per
  // page load; multiple clicks create duplicate tasks, but the user
  // would notice immediately in the tracker view.
  return `
    <div class="ai-next-step">
      <div class="ai-next-step-label">Next step</div>
      <div class="ai-next-step-text">${escapeHtml(nextStep.text)}</div>
      ${nextStep.dueDate ? `<div class="hint">Due ${escapeHtml(nextStep.dueDate)}</div>` : ""}
      ${nextStep.projectName ? `<div class="hint">Project: ${escapeHtml(nextStep.projectName)}</div>` : ""}
      <button type="button" class="ai-next-step-btn" data-ai-action="add-task">
        + Add to today's tasks
      </button>
    </div>
  `;
}

function wireNextStepButton(nextStep: NextStep): void {
  if (contentEl === null) return;
  const btn = contentEl.querySelector<HTMLButtonElement>('[data-ai-action="add-task"]');
  if (btn === null) return;
  btn.addEventListener("click", () => {
    void onAddNextStepAsTask(nextStep, btn);
  });
}

async function onAddNextStepAsTask(nextStep: NextStep, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    const project = getCachedProjects().find(
      (item) => item.name.toLowerCase() === nextStep.projectName?.toLowerCase(),
    );
    await createDailyTask({
      text: nextStep.text,
      due_date: nextStep.dueDate,
      project_id: project?.id ?? null,
    });
    btn.textContent = "✓ Added";
    // Other open task pickers (stopwatch/pomodoro) refresh themselves
    // when this fires — keeps the new task visible without a reload.
    window.dispatchEvent(new CustomEvent("task-list:updated"));
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "+ Add to today's tasks";
    if (messageEl !== null) setMessage(messageEl, parseError(e), "error");
  }
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
        <p>To generate this summary, your <strong>focus-time numbers, task counts, paper titles touched, open Feynman gaps, mood entries, and reflection text</strong> will be sent to Anthropic's Claude API.</p>
        <p class="hint">No passwords or Zotero credentials are sent. You can revoke consent later in settings.</p>
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

async function onGenerateProgressClick(period: ProgressSummaryKind): Promise<void> {
  if (!config || !messageEl) return;
  const btn = period === "monthly" ? monthlyBtn : stageBtn;
  if (btn === null) return;
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
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Generating…";
  try {
    const summary = await generateProgressRecap(
      period, -new Date().getTimezoneOffset(),
    );
    showSummary(summary, { expanded: true });
    flashMessage(messageEl, "Recap ready.", "success");
  } catch (e) {
    setMessage(messageEl, parseError(e), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
    // Re-check availability so the freshly-generated kind flips to its
    // disabled "already done" state without requiring a page reload.
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
  monthlyBtn = document.querySelector<HTMLButtonElement>("#ai-summary-monthly");
  stageBtn = document.querySelector<HTMLButtonElement>("#ai-summary-stage");
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
  monthlyBtn?.addEventListener("click", () => void onGenerateProgressClick("monthly"));
  stageBtn?.addEventListener("click", () => void onGenerateProgressClick("stage"));

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
  // Run the three availability fetches in parallel; failures degrade
  // gracefully — a dead availability endpoint shouldn't grey out an
  // otherwise-usable button, the backend's hard checks will still
  // 400/429 on bad clicks.
  const tz = -new Date().getTimezoneOffset();
  const [weekly, monthly, stage] = await Promise.all([
    getWeeklyAvailability(tz).catch((e) => { console.warn("weekly avail", e); return null; }),
    getMonthlyAvailability(tz).catch((e) => { console.warn("monthly avail", e); return null; }),
    getStageAvailability().catch((e) => { console.warn("stage avail", e); return null; }),
  ]);
  if (weekly) applyWeeklyAvailability(weekly);
  if (monthly) applyMonthlyAvailability(monthly);
  if (stage) applyStageAvailability(stage);
}

function applyWeeklyAvailability(avail: WeeklyAvailability): void {
  if (!generateBtn) return;
  if (avail.can_generate) {
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate last week recap";
    generateBtn.title = `Friday slot · creates ${avail.period_key}`;
  } else if (avail.reason === "off_day") {
    generateBtn.disabled = true;
    // Tell the user WHY in the button text — tooltips don't show on mobile.
    generateBtn.textContent = `Available ${avail.next_slot ?? "Friday"}`;
    generateBtn.title =
      `Weekly recap is available on Fridays only. ` +
      `Next available: ${avail.next_slot ?? "Friday"}.`;
  } else if (avail.reason === "already_generated") {
    generateBtn.disabled = true;
    generateBtn.textContent = "Already generated this week";
    generateBtn.title = `You've already generated ${avail.period_key}. ` +
      `Next Friday unlocks the button.`;
  }
}

function applyMonthlyAvailability(avail: MonthlyAvailability): void {
  if (!monthlyBtn) return;
  if (avail.can_generate) {
    monthlyBtn.disabled = false;
    monthlyBtn.textContent = "Monthly";
    monthlyBtn.title = `End-of-month window · creates ${avail.period_key}`;
  } else if (avail.reason === "off_window") {
    monthlyBtn.disabled = true;
    monthlyBtn.textContent = `Monthly · ${avail.next_available ?? ""}`;
    monthlyBtn.title =
      `Monthly recap is available only in the last ` +
      `${avail.window_days ?? 3} days of the month. ` +
      `Next available: ${avail.next_available ?? "end of month"}.`;
  } else if (avail.reason === "already_generated") {
    monthlyBtn.disabled = true;
    monthlyBtn.textContent = "Monthly · done";
    monthlyBtn.title = `You've already generated ${avail.period_key}.`;
  }
}

function applyStageAvailability(avail: StageAvailability): void {
  if (!stageBtn) return;
  if (avail.can_generate) {
    stageBtn.disabled = false;
    stageBtn.textContent = "90-day stage";
    stageBtn.title = `Available now (next call locked for ${avail.cooldown_days} days)`;
  } else if (avail.reason === "cooldown") {
    stageBtn.disabled = true;
    stageBtn.textContent = `90-day · ${avail.next_available ?? ""}`;
    stageBtn.title =
      `Stage recap is limited to once every ${avail.cooldown_days} days. ` +
      `Next available: ${avail.next_available ?? "later"}.`;
  }
}

// --- Weekly-ritual nudge ----------------------------------------------------
//
// Fires Friday 18:00+ local time — the only day the server now lets the
// user generate. Modal asks once per week; localStorage carries the
// dismissal flag per period_key so next Friday fires fresh.
//
// Server-side state is the source of truth via `getWeeklyAvailability()`:
// if the slot is already generated, no prompt. We still gate on
// time-of-day so morning lectures aren't interrupted by an evening
// reflection nudge.

const PROMPT_DISMISSED_PREFIX = "nl_ai_prompt_dismissed_";

async function maybePromptWeeklyRitual(): Promise<void> {
  const now = new Date();
  // Fri=5 in JS getDay() (Sun=0). Single ritual day after the Tuesday
  // slot was retired — fewer interrupts, one consolidated review.
  if (now.getDay() !== 5) return;
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
