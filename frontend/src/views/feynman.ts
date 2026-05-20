/**
 * Feynman method view.
 */

import {
  createFeynmanEntry, deleteFeynmanEntry, listFeynmanEntries,
  updateFeynmanEntry, type FeynmanEntryRead,
} from "../api/feynman";
import { escapeHtml, formatDate, setMessage } from "../utils";
import { renderEmptyStateWithCat } from "./icons";

const FEYNMAN_STEPS = [
  { title: "1. Pick a concept", description: "Write down one concept or theory you want to understand deeply.", fieldLabel: "Concept", placeholder: "e.g. Monte Carlo ray tracing, separatrix, BRDF, heat flux..." },
  { title: "2. Teach it simply", description: "Explain it with the simplest possible words, as if teaching someone unfamiliar with it.", fieldLabel: "Simple explanation", placeholder: "Explain the concept without jargon..." },
  { title: "3. Find the gaps", description: "Identify vague parts, hidden assumptions, missing definitions or weak points.", fieldLabel: "Knowledge gaps", placeholder: "What remains unclear? What should you verify?" },
  { title: "4. Build an analogy", description: "Summarize the concept with a compact analogy or mental image.", fieldLabel: "Analogy", placeholder: "This is like..." },
] as const;

let feynmanStepsEl: HTMLDivElement;
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
  feynmanList.innerHTML = feynmanEntries.map((entry) => `
    <article class="feynman-card">
      <div class="note-header">
        <div>
          <h3>${escapeHtml(entry.concept)}</h3>
          <p class="note-meta">Updated ${formatDate(entry.updated_at)}</p>
        </div>
        <div class="note-actions">
          <button class="secondary" data-feynman-action="edit" data-id="${entry.id}">Edit</button>
          <button class="danger" data-feynman-action="delete" data-id="${entry.id}">Delete</button>
        </div>
      </div>
      ${entry.explanation ? `<p class="note-text"><strong>Simple explanation:</strong> ${escapeHtml(entry.explanation)}</p>` : ""}
      ${entry.gaps ? `<p class="note-text"><strong>Gaps:</strong> ${escapeHtml(entry.gaps)}</p>` : ""}
      ${entry.analogy ? `<p class="note-text"><strong>Analogy:</strong> ${escapeHtml(entry.analogy)}</p>` : ""}
    </article>`).join("");
}

export async function refresh(): Promise<void> {
  try {
    feynmanEntries = await listFeynmanEntries();
    render();
  } catch (error) {
    console.error(error);
    setMessage(feynmanMessage, "Could not load Feynman records.", "error");
  }
}

export function init(onRefreshNeeded: () => Promise<void>, switchToView: (view: string) => void): void {
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
        setMessage(feynmanMessage, "Feynman record created. +15 XP", "success");
      } else {
        await updateFeynmanEntry(editedFeynmanId, payload);
        setMessage(feynmanMessage, "Feynman record updated.", "success");
      }
      clearDraft();
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
      switchToView("feynman"); renderStep(); window.scrollTo({ top: 0, behavior: "smooth" });
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
