/**
 * Paper notes view.
 */

import { createNote, deleteNote, listNotes, updateNote, type PaperNoteRead } from "../api/notes";
import { escapeHtml, setMessage } from "../utils";
import type { UserRead } from "../api/users";

let notesList: HTMLDivElement;
let noteForm: HTMLFormElement;
let noteTitleInput: HTMLInputElement;
let noteAuthorsInput: HTMLInputElement;
let noteYearInput: HTMLInputElement;
let noteKeyPointsInput: HTMLTextAreaElement;
let noteQuestionsInput: HTMLTextAreaElement;
let noteTagsInput: HTMLInputElement;
let noteSubmitButton: HTMLButtonElement;
let noteCancelButton: HTMLButtonElement;
let noteMessage: HTMLParagraphElement;
let refreshNotesButton: HTMLButtonElement;

let notes: PaperNoteRead[] = [];
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
  noteSubmitButton.textContent = "Add note";
  noteCancelButton.classList.add("hidden");
}

export function render(currentUser: UserRead | null): void {
  if (!currentUser) {
    notesList.innerHTML = `<div class="empty-state">Select or create a user before managing paper notes.</div>`;
    return;
  }
  if (notes.length === 0) {
    notesList.innerHTML = `<div class="empty-state">No paper note yet.</div>`;
    return;
  }
  notesList.innerHTML = notes.map((note) => {
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
        ${tags ? `<div class="tags">${tags}</div>` : ""}
      </article>`;
  }).join("");
}

export async function refresh(currentUser: UserRead | null): Promise<void> {
  if (!currentUser) { notes = []; render(null); return; }
  try {
    notes = await listNotes(currentUser.id);
    render(currentUser);
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
  noteSubmitButton = document.querySelector<HTMLButtonElement>("#note-submit-button")!;
  noteCancelButton = document.querySelector<HTMLButtonElement>("#note-cancel-button")!;
  noteMessage = document.querySelector<HTMLParagraphElement>("#note-message")!;
  refreshNotesButton = document.querySelector<HTMLButtonElement>("#refresh-notes-button")!;

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
    };
    try {
      if (editedNoteId === null) {
        const user = (await import("../views/users")).getCurrentUser();
        if (!user) { setMessage(noteMessage, "Select or create a user first.", "error"); return; }
        await createNote(user.id, payload);
        setMessage(noteMessage, "Note created.", "success");
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
  refreshNotesButton.addEventListener("click", async () => { await onRefreshNeeded(); });

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
}
