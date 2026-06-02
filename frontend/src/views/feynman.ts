/**
 * Feynman method view.
 */

import {
  createFeynmanEntry, deleteFeynmanEntry, listFeynmanEntries,
  updateFeynmanEntry, type FeynmanEntryRead,
} from "../api/feynman";
import { listNotes, type PaperNoteRead } from "../api/notes";
import { generateFeynmanReview, listSummaries, type AiSummaryRead } from "../api/summaries";
import { escapeHtml, formatDate, setMessage } from "../utils";
import { aiErrorMessage, ensureAiConsent, isAiEnabled, renderAiMarkdown } from "./ai-tools";
import { renderEmptyStateWithCat } from "./icons";
import { projectChipHtml } from "./project-picker";

const FEYNMAN_STEPS = [
  { title: "1. Pick a concept", description: "Write down one concept or theory you want to understand deeply.", fieldLabel: "Concept", placeholder: "e.g. Monte Carlo ray tracing, separatrix, BRDF, heat flux..." },
  { title: "2. Teach it simply", description: "Explain it with the simplest possible words, as if teaching someone unfamiliar with it.", fieldLabel: "Simple explanation", placeholder: "Explain the concept without jargon..." },
  { title: "3. Find the gaps", description: "Identify vague parts, hidden assumptions, missing definitions or weak points.", fieldLabel: "Knowledge gaps", placeholder: "What remains unclear? What should you verify?" },
  { title: "4. Build an analogy", description: "Summarize the concept with a compact analogy or mental image.", fieldLabel: "Analogy", placeholder: "This is like..." },
] as const;

let feynmanStepsEl: HTMLDivElement;
let feynmanEditorDetails: HTMLDetailsElement;
let feynmanStepTitle: HTMLHeadingElement;
let feynmanStepDescription: HTMLParagraphElement;
let feynmanFieldLabel: HTMLSpanElement;
let feynmanInput: HTMLTextAreaElement;
let feynmanPrevButton: HTMLButtonElement;
let feynmanNextButton: HTMLButtonElement;
let feynmanResetButton: HTMLButtonElement;
let feynmanMessage: HTMLParagraphElement;
let feynmanList: HTMLDivElement;

let feynmanEntries: FeynmanEntryRead[] = [];
let feynmanStep = 0;
let feynmanDraft = ["", "", "", ""];
let editedFeynmanId: number | null = null;
let aiEnabled = false;
const aiReviews = new Map<number, AiSummaryRead>();
// Reverse-index of paper_notes.feynman_entry_id → note. Populated on
// refresh() so each Feynman card and the editor banner know whether they
// were spawned from a paper, without re-fetching notes on every render.
const sourceNoteByEntryId = new Map<number, PaperNoteRead>();
let switchToViewFn: ((view: string) => void) | null = null;

function renderStep(): void {
  const step = FEYNMAN_STEPS[feynmanStep];
  feynmanStepsEl.innerHTML = FEYNMAN_STEPS.map((_, i) => {
    const cls = i === feynmanStep ? "active" : i < feynmanStep ? "done" : "";
    return `<div class="step-dot ${cls}">${i + 1}</div>`;
  }).join("");
  feynmanStepTitle.textContent = step.title;
  feynmanStepDescription.textContent = step.description;
  feynmanFieldLabel.textContent = step.fieldLabel;
  feynmanInput.placeholder = step.placeholder;
  feynmanInput.value = feynmanDraft[feynmanStep] ?? "";
  feynmanPrevButton.disabled = feynmanStep === 0;
  feynmanNextButton.textContent = feynmanStep === FEYNMAN_STEPS.length - 1
    ? (editedFeynmanId === null ? "Save entry" : "Update entry") : "Next";
  if (editedFeynmanId !== null) setMessage(feynmanMessage, "Editing an existing Feynman record.", "neutral");
  renderSourceNoteBanner();
}

function renderSourceNoteBanner(): void {
  // When the editor is bound to an entry that was spawned from a paper
  // note, show the source paper's title + key ideas next to the input.
  // Most useful at step 2 ("teach it simply"): the user can glance at
  // the paper's own framing without context-switching tabs.
  const banner = document.querySelector<HTMLDivElement>("#feynman-source-note");
  if (banner === null) return;
  const note = editedFeynmanId !== null ? sourceNoteByEntryId.get(editedFeynmanId) : undefined;
  if (note === undefined) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }
  const keyIdeas = note.key_points.trim();
  const meta = [note.authors, note.year ? String(note.year) : ""].filter(Boolean).join(" · ");
  banner.classList.remove("hidden");
  banner.innerHTML = `
    <p class="eyebrow">📄 From paper</p>
    <p class="feynman-source-title">${escapeHtml(note.title)}</p>
    ${meta ? `<p class="hint">${escapeHtml(meta)}</p>` : ""}
    ${keyIdeas
      ? `<details class="feynman-source-key" open>
           <summary>Key ideas (from the note)</summary>
           <p>${escapeHtml(keyIdeas)}</p>
         </details>`
      : `<p class="hint">No key ideas captured yet on this note.</p>`}
  `;
}

export function clearDraft(): void {
  editedFeynmanId = null; feynmanStep = 0; feynmanDraft = ["", "", "", ""];
  setMessage(feynmanMessage, "", "neutral");
  renderStep();
}

export function renderInitial(): void { renderStep(); }

export function render(): void {
  if (feynmanEntries.length === 0) {
    feynmanList.innerHTML = renderEmptyStateWithCat("No Feynman record yet.");
    return;
  }
  feynmanList.innerHTML = feynmanEntries.map((entry) => {
    const source = sourceNoteByEntryId.get(entry.id);
    return `
    <article class="feynman-card">
      <div class="note-header">
        <div>
          <h3>${escapeHtml(entry.concept)}${projectChipHtml(entry.project_id)}</h3>
          <p class="note-meta">Updated ${formatDate(entry.updated_at)}${source ? ` · 📄 from <em>${escapeHtml(source.title)}</em>` : ""}</p>
        </div>
        <div class="note-actions">
          <button class="secondary" data-feynman-action="edit" data-id="${entry.id}">Edit</button>
          ${aiEnabled ? `<button class="secondary" data-feynman-action="review" data-id="${entry.id}">AI critique</button>` : ""}
          <button class="danger" data-feynman-action="delete" data-id="${entry.id}">Delete</button>
        </div>
      </div>
      ${entry.explanation ? `<p class="note-text"><strong>Simple explanation:</strong> ${escapeHtml(entry.explanation)}</p>` : ""}
      ${entry.gaps ? `<p class="note-text"><strong>Gaps:</strong> ${escapeHtml(entry.gaps)}</p>` : ""}
      ${entry.analogy ? `<p class="note-text"><strong>Analogy:</strong> ${escapeHtml(entry.analogy)}</p>` : ""}
      ${aiReviews.has(entry.id) ? `<div class="ai-summary-body">${renderAiMarkdown(aiReviews.get(entry.id)!.content)}</div>` : ""}
    </article>`;
  }).join("");
}

export async function refresh(): Promise<void> {
  try {
    const [entries, notes] = await Promise.all([
      listFeynmanEntries(),
      // Source-paper banner needs the notes' feynman_entry_id pointers.
      // Failure is non-fatal: we just lose the cross-link decoration.
      listNotes().catch(() => [] as PaperNoteRead[]),
    ]);
    feynmanEntries = entries;
    sourceNoteByEntryId.clear();
    for (const n of notes) {
      if (n.feynman_entry_id !== null) {
        sourceNoteByEntryId.set(n.feynman_entry_id, n);
      }
    }
    aiEnabled = await isAiEnabled();
    if (aiEnabled) {
      const summaries = await listSummaries("feynman_review");
      aiReviews.clear();
      for (const summary of summaries) {
        const match = summary.period_key.match(/^feynman:(\d+)$/);
        if (match && !aiReviews.has(Number(match[1]))) aiReviews.set(Number(match[1]), summary);
      }
    }
    render();
  } catch (error) {
    console.error(error);
    setMessage(feynmanMessage, "Could not load Feynman records.", "error");
  }
}

/**
 * Open the editor on an existing Feynman entry. Used by the paper-note
 * "Start Feynman from this paper" action so it can drive the same edit
 * flow that the in-list Edit button uses, without duplicating logic.
 */
export async function loadForEdit(entryId: number): Promise<void> {
  // Make sure the local cache (entries + source notes) reflects what the
  // caller just mutated, otherwise the source banner would be empty on
  // first paint.
  await refresh();
  const entry = feynmanEntries.find((e) => e.id === entryId);
  if (entry === undefined) return;
  editedFeynmanId = entry.id;
  feynmanStep = 0;
  feynmanDraft = [entry.concept, entry.explanation, entry.gaps, entry.analogy];
  feynmanEditorDetails.open = true;
  switchToViewFn?.("feynman");
  renderStep();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

export function init(onRefreshNeeded: () => Promise<void>, switchToView: (view: string) => void): void {
  switchToViewFn = switchToView;
  feynmanEditorDetails = document.querySelector<HTMLDetailsElement>("#feynman-editor-details")!;
  feynmanStepsEl = document.querySelector<HTMLDivElement>("#feynman-steps")!;
  feynmanStepTitle = document.querySelector<HTMLHeadingElement>("#feynman-step-title")!;
  feynmanStepDescription = document.querySelector<HTMLParagraphElement>("#feynman-step-description")!;
  feynmanFieldLabel = document.querySelector<HTMLSpanElement>("#feynman-field-label")!;
  feynmanInput = document.querySelector<HTMLTextAreaElement>("#feynman-input")!;
  feynmanPrevButton = document.querySelector<HTMLButtonElement>("#feynman-prev-button")!;
  feynmanNextButton = document.querySelector<HTMLButtonElement>("#feynman-next-button")!;
  feynmanResetButton = document.querySelector<HTMLButtonElement>("#feynman-reset-button")!;
  feynmanMessage = document.querySelector<HTMLParagraphElement>("#feynman-message")!;
  feynmanList = document.querySelector<HTMLDivElement>("#feynman-list")!;

  window.addEventListener("cat:skin-changed", () => render());

  feynmanInput.addEventListener("input", () => { feynmanDraft[feynmanStep] = feynmanInput.value; });
  feynmanPrevButton.addEventListener("click", () => {
    feynmanDraft[feynmanStep] = feynmanInput.value;
    if (feynmanStep > 0) { feynmanStep -= 1; renderStep(); }
  });
  feynmanNextButton.addEventListener("click", async () => {
    feynmanDraft[feynmanStep] = feynmanInput.value;
    if (feynmanStep < FEYNMAN_STEPS.length - 1) { feynmanStep += 1; renderStep(); return; }
    const concept = feynmanDraft[0].trim();
    if (!concept) { feynmanStep = 0; renderStep(); setMessage(feynmanMessage, "Concept is required.", "error"); return; }
    const payload = { concept, explanation: feynmanDraft[1].trim(), gaps: feynmanDraft[2].trim(), analogy: feynmanDraft[3].trim() };
    try {
      if (editedFeynmanId === null) {
        await createFeynmanEntry(payload);
        setMessage(feynmanMessage, "Feynman record created. +10 XP", "success");
      } else {
        await updateFeynmanEntry(editedFeynmanId, payload);
        setMessage(feynmanMessage, "Feynman record updated.", "success");
      }
      clearDraft();
      feynmanEditorDetails.open = false;
      await onRefreshNeeded();
    } catch (error) {
      console.error(error);
      setMessage(feynmanMessage, "Could not save Feynman record.", "error");
    }
  });
  feynmanResetButton.addEventListener("click", () => clearDraft());
  feynmanList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.feynmanAction;
    const entryId = Number(target.dataset.id);
    if (!action || !Number.isFinite(entryId)) return;
    const entry = feynmanEntries.find((e) => e.id === entryId);
    if (!entry) return;
    if (action === "edit") {
      editedFeynmanId = entry.id; feynmanStep = 0;
      feynmanDraft = [entry.concept, entry.explanation, entry.gaps, entry.analogy];
      feynmanEditorDetails.open = true;
      switchToView("feynman"); renderStep(); window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (action === "review") {
      try {
        if (!await ensureAiConsent("This Feynman explanation, your listed gaps, and analogy")) return;
        target.textContent = "Reviewing...";
        const summary = await generateFeynmanReview(entry.id);
        aiReviews.set(entry.id, summary);
        render();
      } catch (error) {
        setMessage(feynmanMessage, aiErrorMessage(error), "error");
      }
    } else if (action === "delete") {
      if (!window.confirm(`Delete Feynman record "${entry.concept}"?`)) return;
      try {
        await deleteFeynmanEntry(entry.id);
        setMessage(feynmanMessage, "Feynman record deleted.", "success");
        await onRefreshNeeded();
      } catch (error) {
        console.error(error);
        setMessage(feynmanMessage, "Could not delete Feynman record.", "error");
      }
    }
  });
}
