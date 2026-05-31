/**
 * Paper notes view.
 */

import { createNote, deleteNote, listNotes, updateNote, type PaperNoteRead } from "../api/notes";
import { listFeynmanEntries, type FeynmanEntryRead } from "../api/feynman";
import { generatePaperNoteThemes } from "../api/summaries";
import { escapeHtml, setMessage } from "../utils";
import { aiErrorMessage, ensureAiConsent, isAiEnabled, renderAiMarkdown } from "./ai-tools";
import { renderEmptyStateWithCat } from "./icons";

let notesList: HTMLDivElement;
let noteForm: HTMLFormElement;
let noteTitleInput: HTMLInputElement;
let noteAuthorsInput: HTMLInputElement;
let noteYearInput: HTMLInputElement;
let noteKeyPointsInput: HTMLTextAreaElement;
let noteQuestionsInput: HTMLTextAreaElement;
let noteTagsInput: HTMLInputElement;
let noteDoiInput: HTMLInputElement;
let noteUrlInput: HTMLInputElement;
let noteFeynmanLink: HTMLSelectElement;
let noteSearchInput: HTMLInputElement;
let noteTagFilterInput: HTMLInputElement;
let noteAiThemesButton: HTMLButtonElement;
let noteAiOutput: HTMLDivElement;
let noteSubmitButton: HTMLButtonElement;
let noteCancelButton: HTMLButtonElement;
let noteMessage: HTMLParagraphElement;

let notes: PaperNoteRead[] = [];
let feynmanEntries: FeynmanEntryRead[] = [];
let editedNoteId: number | null = null;

export function getNotes(): PaperNoteRead[] { return notes; }

function clearNoteForm(): void {
  editedNoteId = null;
  noteTitleInput.value = "";
  noteAuthorsInput.value = "";
  noteYearInput.value = "";
  noteKeyPointsInput.value = "";
  noteQuestionsInput.value = "";
  noteTagsInput.value = "";
  noteDoiInput.value = "";
  noteUrlInput.value = "";
  noteFeynmanLink.value = "";
  noteSubmitButton.textContent = "Add note";
  noteCancelButton.classList.add("hidden");
}

export function render(): void {
  const query = noteSearchInput?.value.trim().toLowerCase() ?? "";
  const tagQuery = noteTagFilterInput?.value.trim().toLowerCase() ?? "";
  const visibleNotes = notes.filter((note) => {
    const haystack = [
      note.title, note.authors, note.doi, note.url, note.key_points, note.questions,
    ].join(" ").toLowerCase();
    const tags = note.tags.toLowerCase();
    return (!query || haystack.includes(query)) && (!tagQuery || tags.includes(tagQuery));
  });
  if (visibleNotes.length === 0) {
    notesList.innerHTML = renderEmptyStateWithCat("No paper note yet.");
    return;
  }
  notesList.innerHTML = visibleNotes.map((note) => {
    const tags = note.tags.split(",").map((t) => t.trim()).filter(Boolean)
      .map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
    return `
      <article class="note-card">
        <div class="note-header">
          <div>
            <h3>${escapeHtml(note.title)}</h3>
            <p class="note-meta">${escapeHtml(note.authors || "Unknown authors")}${note.year ? ` (${note.year})` : ""}</p>
          </div>
          <div class="note-actions">
            <button class="secondary" data-action="edit" data-id="${note.id}">Edit</button>
            <button class="danger" data-action="delete" data-id="${note.id}">Delete</button>
          </div>
        </div>
        ${note.key_points ? `<p class="note-text"><strong>Key ideas:</strong> ${escapeHtml(note.key_points)}</p>` : ""}
        ${note.questions ? `<p class="note-text"><strong>Questions:</strong> ${escapeHtml(note.questions)}</p>` : ""}
        ${note.doi ? `<p class="note-meta"><strong>DOI:</strong> ${escapeHtml(note.doi)}</p>` : ""}
        ${note.url ? `<p class="note-meta"><a href="${escapeHtml(note.url)}" target="_blank" rel="noopener">Open source URL</a></p>` : ""}
        ${note.feynman_entry_id ? `<p class="note-meta"><strong>Feynman link:</strong> ${escapeHtml(feynmanEntries.find((entry) => entry.id === note.feynman_entry_id)?.concept ?? "Linked record")}</p>` : ""}
        ${tags ? `<div class="tags">${tags}</div>` : ""}
      </article>`;
  }).join("");
}

export async function refresh(): Promise<void> {
  try {
    [notes, feynmanEntries] = await Promise.all([listNotes(), listFeynmanEntries()]);
    noteFeynmanLink.innerHTML = `<option value="">None</option>` + feynmanEntries.map((entry) =>
      `<option value="${entry.id}">${escapeHtml(entry.concept)}</option>`
    ).join("");
    noteAiThemesButton.classList.toggle("hidden", !(await isAiEnabled()));
    render();
  } catch (error) {
    console.error(error);
    setMessage(noteMessage, "Could not load notes.", "error");
  }
}

export function init(onRefreshNeeded: () => Promise<void>, switchToView: (view: string) => void): void {
  notesList = document.querySelector<HTMLDivElement>("#notes-list")!;
  noteForm = document.querySelector<HTMLFormElement>("#note-form")!;
  noteTitleInput = document.querySelector<HTMLInputElement>("#note-title")!;
  noteAuthorsInput = document.querySelector<HTMLInputElement>("#note-authors")!;
  noteYearInput = document.querySelector<HTMLInputElement>("#note-year")!;
  noteKeyPointsInput = document.querySelector<HTMLTextAreaElement>("#note-key-points")!;
  noteQuestionsInput = document.querySelector<HTMLTextAreaElement>("#note-questions")!;
  noteTagsInput = document.querySelector<HTMLInputElement>("#note-tags")!;
  noteDoiInput = document.querySelector<HTMLInputElement>("#note-doi")!;
  noteUrlInput = document.querySelector<HTMLInputElement>("#note-url")!;
  noteFeynmanLink = document.querySelector<HTMLSelectElement>("#note-feynman-link")!;
  noteSearchInput = document.querySelector<HTMLInputElement>("#note-search")!;
  noteTagFilterInput = document.querySelector<HTMLInputElement>("#note-tag-filter")!;
  noteAiThemesButton = document.querySelector<HTMLButtonElement>("#note-ai-themes")!;
  noteAiOutput = document.querySelector<HTMLDivElement>("#note-ai-output")!;
  noteSubmitButton = document.querySelector<HTMLButtonElement>("#note-submit-button")!;
  noteCancelButton = document.querySelector<HTMLButtonElement>("#note-cancel-button")!;
  noteMessage = document.querySelector<HTMLParagraphElement>("#note-message")!;

  // Re-tint the sleeping-cat empty state when the user picks a new skin.
  window.addEventListener("cat:skin-changed", () => render());

  noteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = noteTitleInput.value.trim();
    if (!title) { setMessage(noteMessage, "Paper title is required.", "error"); return; }
    const yearRaw = noteYearInput.value.trim();
    const year = yearRaw ? Number(yearRaw) : null;
    if (year !== null && !Number.isFinite(year)) { setMessage(noteMessage, "Year must be a valid number.", "error"); return; }
    const payload = {
      title, authors: noteAuthorsInput.value.trim(), year,
      key_points: noteKeyPointsInput.value.trim(),
      questions: noteQuestionsInput.value.trim(),
      tags: noteTagsInput.value.trim(),
      doi: noteDoiInput.value.trim(),
      url: noteUrlInput.value.trim(),
      feynman_entry_id: noteFeynmanLink.value ? Number(noteFeynmanLink.value) : null,
    };
    try {
      if (editedNoteId === null) {
        await createNote(payload);
        setMessage(noteMessage, "Note created. +10 XP", "success");
      } else {
        await updateNote(editedNoteId, payload);
        setMessage(noteMessage, "Note updated.", "success");
      }
      clearNoteForm();
      await onRefreshNeeded();
    } catch (error) {
      console.error(error);
      setMessage(noteMessage, "Could not save note.", "error");
    }
  });

  noteCancelButton.addEventListener("click", () => { clearNoteForm(); setMessage(noteMessage, "", "neutral"); });

  notesList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.action;
    const noteId = Number(target.dataset.id);
    if (!action || !Number.isFinite(noteId)) return;
    const note = notes.find((n) => n.id === noteId);
    if (!note) return;
    if (action === "edit") {
      editedNoteId = note.id;
      noteTitleInput.value = note.title;
      noteAuthorsInput.value = note.authors;
      noteYearInput.value = note.year === null ? "" : String(note.year);
      noteKeyPointsInput.value = note.key_points;
      noteQuestionsInput.value = note.questions;
      noteTagsInput.value = note.tags;
      noteDoiInput.value = note.doi;
      noteUrlInput.value = note.url;
      noteFeynmanLink.value = note.feynman_entry_id === null ? "" : String(note.feynman_entry_id);
      noteSubmitButton.textContent = "Update note";
      noteCancelButton.classList.remove("hidden");
      switchToView("notes");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (action === "delete") {
      if (!window.confirm(`Delete note "${note.title}"?`)) return;
      try {
        await deleteNote(note.id);
        setMessage(noteMessage, "Note deleted.", "success");
        await onRefreshNeeded();
      } catch (error) {
        console.error(error);
        setMessage(noteMessage, "Could not delete note.", "error");
      }
    }
  });

  noteSearchInput.addEventListener("input", () => render());
  noteTagFilterInput.addEventListener("input", () => render());
  noteAiThemesButton.addEventListener("click", async () => {
    try {
      if (!await ensureAiConsent("Your paper-note titles, tags, key ideas, and questions")) return;
      noteAiThemesButton.disabled = true;
      noteAiThemesButton.textContent = "Finding themes...";
      const summary = await generatePaperNoteThemes();
      noteAiOutput.innerHTML = `<div class="ai-summary-body">${renderAiMarkdown(summary.content)}</div>`;
    } catch (error) {
      setMessage(noteMessage, aiErrorMessage(error), "error");
    } finally {
      noteAiThemesButton.disabled = false;
      noteAiThemesButton.textContent = "Find AI themes";
    }
  });
}
