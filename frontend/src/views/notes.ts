/**
 * Paper notes view.
 *
 * In addition to the manual CRUD form, this view hosts the Zotero
 * integration UI:
 *   - Settings modal to paste user_id + API key (verified server-side).
 *   - Import modal to browse the user's Zotero library, search, and
 *     bulk-import (or re-sync) selected items.
 *
 * Zotero-imported notes get a small "Zotero" badge and a deep link back
 * into the user's library. Editing them locally never pushes back to
 * Zotero — see the route docstring for the rationale.
 */

import {
  addNoteToToday,
  createNote,
  deleteNote,
  disconnectZotero,
  getZoteroConfig,
  importZoteroItems,
  listNotes,
  listZoteroItems,
  setZoteroConfig,
  updateNote,
  type PaperNoteRead,
  type PaperReadingStatus,
  type ZoteroConfig,
  type ZoteroItem,
} from "../api/notes";
import { ApiError } from "../api/client";
import { createFeynmanEntry, listFeynmanEntries, type FeynmanEntryRead } from "../api/feynman";
import { getLinks, type BacklinksRead } from "../api/links";
import * as FeynmanView from "./feynman";
import { escapeHtml, setMessage } from "../utils";
import { renderEmptyStateWithCat } from "./icons";
import { projectChipHtml, renderProjectPicker } from "./project-picker";
import { mountTagInput, refreshTagCache, type TagInputController } from "./tagInput";

let notesList: HTMLDivElement;
let noteForm: HTMLFormElement;
let noteEditorDetails: HTMLDetailsElement;
let noteTitleInput: HTMLInputElement;
let noteAuthorsInput: HTMLInputElement;
let noteYearInput: HTMLInputElement;
let noteKeyPointsInput: HTMLTextAreaElement;
let noteQuestionsInput: HTMLTextAreaElement;
let noteTagsInput: HTMLInputElement;
let noteTagInput: TagInputController | null = null;
// Click-to-filter chip: when the user clicks a tag chip on a saved note,
// stuff that name in here and re-render. Cleared by the "All" chip the
// filter row injects when active.
let activeTagFilter: string | null = null;
let noteUrlInput: HTMLInputElement;
let noteDoiInput: HTMLInputElement;
let noteAbstractInput: HTMLTextAreaElement;
let noteFeynmanLink: HTMLSelectElement;
let noteReadingStatus: HTMLSelectElement;
let noteSearchInput: HTMLInputElement;
let noteTagFilterInput: HTMLInputElement;
let noteSubmitButton: HTMLButtonElement;
let noteCancelButton: HTMLButtonElement;
let noteMessage: HTMLParagraphElement;
let zoteroSettingsButton: HTMLButtonElement;
let zoteroImportButton: HTMLButtonElement;

let notes: PaperNoteRead[] = [];
let feynmanEntries: FeynmanEntryRead[] = [];
let editedNoteId: number | null = null;
let zoteroConfig: ZoteroConfig = { connected: false, zotero_user_id: null };
// Project chosen for the note currently being edited/created. Sticky for
// new notes (same behaviour as the tracker task picker).
let pendingProjectId: number | null = null;

export function getNotes(): PaperNoteRead[] { return notes; }

function clearNoteForm(): void {
  editedNoteId = null;
  noteTitleInput.value = "";
  noteAuthorsInput.value = "";
  noteYearInput.value = "";
  noteKeyPointsInput.value = "";
  noteQuestionsInput.value = "";
  noteTagsInput.value = "";
  if (noteTagInput) noteTagInput.clear();
  noteUrlInput.value = "";
  noteDoiInput.value = "";
  noteAbstractInput.value = "";
  noteFeynmanLink.value = "";
  noteReadingStatus.value = "inbox";
  // Don't reset pendingProjectId here — sticky across saves so the user
  // can add a string of notes against one project without re-picking.
  void rerenderNoteProjectPicker();
  noteSubmitButton.textContent = "Add note";
  noteCancelButton.classList.add("hidden");
  noteEditorDetails.open = false;
}

async function rerenderNoteProjectPicker(): Promise<void> {
  const container = document.querySelector<HTMLDivElement>("#note-project-picker");
  if (container === null) return;
  await renderProjectPicker({
    container,
    selectedId: pendingProjectId,
    label: "Project (optional)",
    onChange: (id) => { pendingProjectId = id; },
  });
}

function zoteroDeepLink(note: PaperNoteRead): string | null {
  if (!note.zotero_key || !zoteroConfig.zotero_user_id) return null;
  // The web library URL accepts the per-item key directly. Falls back to
  // the user's overall library if the item was deleted on Zotero's side.
  return `https://www.zotero.org/users/${zoteroConfig.zotero_user_id}/items/${note.zotero_key}`;
}

function noteTagNames(note: PaperNoteRead): string[] {
  // Prefer the authoritative tag_list (from the link table). Fall back to
  // splitting the CSV mirror so notes whose backfill hasn't run yet still
  // render some tags instead of nothing.
  if (note.tag_list && note.tag_list.length > 0) {
    return note.tag_list.map((t) => t.name);
  }
  return note.tags.split(",").map((t) => t.trim()).filter(Boolean);
}

export function render(): void {
  const query = noteSearchInput?.value.trim().toLowerCase() ?? "";
  const tagQuery = noteTagFilterInput?.value.trim().toLowerCase() ?? "";
  const activeFilter = activeTagFilter?.toLowerCase() ?? "";
  const visibleNotes = notes.filter((note) => {
    const haystack = [
      note.title, note.authors, note.doi, note.url, note.key_points, note.questions,
    ].join(" ").toLowerCase();
    const names = noteTagNames(note).map((n) => n.toLowerCase());
    const tagsBlob = [note.tags.toLowerCase(), ...names].join(" ");
    const matchesActive = !activeFilter || names.includes(activeFilter);
    return (!query || haystack.includes(query))
      && (!tagQuery || tagsBlob.includes(tagQuery))
      && matchesActive;
  });
  if (visibleNotes.length === 0) {
    notesList.innerHTML = activeTagFilter
      ? `<p class="hint">No paper note tagged <strong>${escapeHtml(activeTagFilter)}</strong>. <button class="link-btn" data-action="clear-tag-filter" type="button">Show all</button></p>`
      : renderEmptyStateWithCat("No paper note yet.");
    return;
  }
  const filterBanner = activeTagFilter
    ? `<p class="hint tag-filter-banner">Filtering by tag <span class="tag">#${escapeHtml(activeTagFilter)}</span> <button class="link-btn" data-action="clear-tag-filter" type="button">clear</button></p>`
    : "";
  notesList.innerHTML = filterBanner + visibleNotes.map((note) => {
    const tags = noteTagNames(note)
      .map((t) => `<button type="button" class="tag tag-clickable" data-action="filter-tag" data-tag="${escapeHtml(t)}" title="Filter notes by #${escapeHtml(t)}">${escapeHtml(t)}</button>`)
      .join("");
    const zoteroLink = zoteroDeepLink(note);
    const sourceBadge = note.source === "zotero"
      ? `<span class="source-badge zotero-badge" title="Imported from Zotero">📚 Zotero</span>`
      : "";
    const readingStatus = humanReadingStatus(note.reading_status);
    const externalLinks: string[] = [];
    if (note.doi) {
      externalLinks.push(
        `<a href="https://doi.org/${encodeURIComponent(note.doi)}" target="_blank" rel="noopener">DOI</a>`,
      );
    }
    if (note.url) {
      externalLinks.push(
        `<a href="${escapeHtml(note.url)}" target="_blank" rel="noopener">URL</a>`,
      );
    }
    if (zoteroLink !== null) {
      externalLinks.push(
        `<a href="${escapeHtml(zoteroLink)}" target="_blank" rel="noopener">Open in Zotero</a>`,
      );
    }
    const linksHtml = externalLinks.length > 0
      ? `<p class="note-links">${externalLinks.join(" · ")}</p>`
      : "";
    const abstractHtml = note.abstract
      ? `<details class="note-abstract"><summary>Abstract</summary><p>${escapeHtml(note.abstract)}</p></details>`
      : "";
    const latestInsight = note.latest_insight;
    const insightHtml = latestInsight
      ? `<div class="note-insight">
          <strong>Latest reading insight</strong>
          ${latestInsight.key_idea ? `<p>${escapeHtml(latestInsight.key_idea)}</p>` : ""}
          ${latestInsight.question ? `<p class="hint">Question: ${escapeHtml(latestInsight.question)}</p>` : ""}
          ${latestInsight.next_step ? `<p class="hint">Next: ${escapeHtml(latestInsight.next_step)}</p>` : ""}
          ${note.insight_count > 1 ? `<span class="hint">${note.insight_count} insights captured</span>` : ""}
        </div>`
      : "";
    return `
      <article class="note-card">
        <div class="note-header">
          <div>
            <h3>${escapeHtml(note.title)}${sourceBadge}${projectChipHtml(note.project_id)}</h3>
            <p class="note-meta">${escapeHtml(note.authors || "Unknown authors")}${note.year ? ` (${note.year})` : ""}${note.item_type ? ` · ${escapeHtml(humanItemType(note.item_type))}` : ""}</p>
          </div>
          <div class="note-actions">
            <button class="secondary" data-action="read-today" data-id="${note.id}">+ Read today</button>
            <button class="secondary" data-action="edit" data-id="${note.id}">Edit</button>
            ${note.feynman_entry_id === null
              ? `<button class="secondary" data-action="start-feynman" data-id="${note.id}" title="Spawn a Feynman record from this paper and link it">🧠 Start Feynman</button>`
              : `<button class="link-btn" data-action="open-feynman" data-id="${note.id}" title="Open the linked Feynman record">🧠 Open Feynman</button>`}
            <button class="danger" data-action="delete" data-id="${note.id}">Delete</button>
          </div>
        </div>
        ${linksHtml}
        <div class="note-workflow-row">
          <span class="source-badge reading-status-${note.reading_status}">${escapeHtml(readingStatus)}</span>
          <span class="note-meta">${note.reading_minutes} min focused reading</span>
          <label class="note-status-control">Move to
            <select data-note-status="${note.id}">
              ${readingStatusOptions(note.reading_status)}
            </select>
          </label>
        </div>
        ${note.key_points ? `<p class="note-text"><strong>Key ideas:</strong> ${escapeHtml(note.key_points)}</p>` : ""}
        ${note.questions ? `<p class="note-text"><strong>Questions:</strong> ${escapeHtml(note.questions)}</p>` : ""}
        ${note.feynman_entry_id ? `<p class="note-meta"><strong>Feynman link:</strong> ${escapeHtml(feynmanEntries.find((entry) => entry.id === note.feynman_entry_id)?.concept ?? "Linked record")}</p>` : ""}
        ${insightHtml}
        ${abstractHtml}
        ${tags ? `<div class="tags">${tags}</div>` : ""}
        <details class="note-backlinks" data-backlinks="${note.id}">
          <summary>🔗 Links</summary>
          <div class="note-backlinks-body"><p class="hint">Open to load.</p></div>
        </details>
      </article>`;
  }).join("");
}

function renderBacklinksHtml(data: BacklinksRead): string {
  if (data.backlinks.length === 0 && data.outgoing.length === 0) {
    return `<p class="hint">No links yet. Mention another note as <code>[[Its title]]</code> in the body to create one.</p>`;
  }
  const fmtRef = (label: string, title: string, kind: string): string =>
    `<li><span class="link-kind tag-chip" data-kind="${kind}">${kind === "feynman_entry" ? "Feynman" : "Paper"}</span> <strong>${escapeHtml(title)}</strong>${label && label.toLowerCase() !== title.toLowerCase() ? ` <span class="hint">(as “${escapeHtml(label)}”)</span>` : ""}</li>`;
  const inHtml = data.backlinks.length
    ? `<div class="note-backlinks-section"><h4>Backlinks (${data.backlinks.length})</h4><ul class="link-list">${data.backlinks.map((b) => fmtRef(b.label, b.source.title, b.source.item_type)).join("")}</ul></div>`
    : "";
  const outHtml = data.outgoing.length
    ? `<div class="note-backlinks-section"><h4>Outgoing (${data.outgoing.length})</h4><ul class="link-list">${data.outgoing.map((o) => fmtRef(o.label, o.target.title, o.target.item_type)).join("")}</ul></div>`
    : "";
  return inHtml + outHtml;
}

function humanReadingStatus(status: PaperReadingStatus): string {
  return {
    inbox: "Inbox",
    reading: "Reading",
    summarized: "Summarized",
    revisit: "Revisit",
  }[status];
}

function readingStatusOptions(selected: PaperReadingStatus): string {
  return (["inbox", "reading", "summarized", "revisit"] as const)
    .map((status) => `<option value="${status}" ${status === selected ? "selected" : ""}>${humanReadingStatus(status)}</option>`)
    .join("");
}

function humanItemType(itemType: string): string {
  // Zotero camel-cases its item types. Display them with a space.
  return itemType.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

export async function refresh(): Promise<void> {
  try {
    [notes, feynmanEntries] = await Promise.all([listNotes(), listFeynmanEntries()]);
    noteFeynmanLink.innerHTML = `<option value="">None</option>` + feynmanEntries.map((entry) =>
      `<option value="${entry.id}">${escapeHtml(entry.concept)}</option>`
    ).join("");
    render();
  } catch (error) {
    console.error(error);
    setMessage(noteMessage, "Could not load notes.", "error");
  }
}

async function refreshZoteroState(): Promise<void> {
  try {
    zoteroConfig = await getZoteroConfig();
  } catch (e) {
    console.warn("Zotero config fetch failed", e);
    zoteroConfig = { connected: false, zotero_user_id: null };
  }
  zoteroImportButton.classList.toggle("hidden", !zoteroConfig.connected);
  zoteroSettingsButton.textContent = zoteroConfig.connected
    ? "Zotero settings"
    : "Connect Zotero";
}

export function init(onRefreshNeeded: () => Promise<void>, switchToView: (view: string) => void): void {
  notesList = document.querySelector<HTMLDivElement>("#notes-list")!;
  noteForm = document.querySelector<HTMLFormElement>("#note-form")!;
  noteEditorDetails = document.querySelector<HTMLDetailsElement>("#note-editor-details")!;
  noteTitleInput = document.querySelector<HTMLInputElement>("#note-title")!;
  noteAuthorsInput = document.querySelector<HTMLInputElement>("#note-authors")!;
  noteYearInput = document.querySelector<HTMLInputElement>("#note-year")!;
  noteKeyPointsInput = document.querySelector<HTMLTextAreaElement>("#note-key-points")!;
  noteQuestionsInput = document.querySelector<HTMLTextAreaElement>("#note-questions")!;
  noteTagsInput = document.querySelector<HTMLInputElement>("#note-tags")!;
  noteUrlInput = document.querySelector<HTMLInputElement>("#note-url")!;
  noteDoiInput = document.querySelector<HTMLInputElement>("#note-doi")!;
  noteAbstractInput = document.querySelector<HTMLTextAreaElement>("#note-abstract")!;
  noteFeynmanLink = document.querySelector<HTMLSelectElement>("#note-feynman-link")!;
  noteReadingStatus = document.querySelector<HTMLSelectElement>("#note-reading-status")!;
  noteSearchInput = document.querySelector<HTMLInputElement>("#note-search")!;
  noteTagFilterInput = document.querySelector<HTMLInputElement>("#note-tag-filter")!;
  noteSubmitButton = document.querySelector<HTMLButtonElement>("#note-submit-button")!;
  noteCancelButton = document.querySelector<HTMLButtonElement>("#note-cancel-button")!;
  noteMessage = document.querySelector<HTMLParagraphElement>("#note-message")!;
  zoteroSettingsButton = document.querySelector<HTMLButtonElement>("#zotero-settings-button")!;
  zoteroImportButton = document.querySelector<HTMLButtonElement>("#zotero-import-button")!;

  // Mount the chip-style tag control next to the legacy free-text input
  // (which stays around so legacy reads keep working until the link table
  // is fully populated). We host it inside the existing label by
  // appending a sibling div — the text input remains usable as a fallback
  // for power users who want to paste a CSV.
  const tagLabel = noteTagsInput.closest("label");
  if (tagLabel) {
    const chipHost = document.createElement("div");
    chipHost.className = "note-tag-input-host";
    tagLabel.appendChild(chipHost);
    noteTagInput = mountTagInput(chipHost, {
      placeholder: "Add tag and press Enter…",
      onChange: () => {
        // Keep the legacy CSV box loosely in sync so users who eyeball
        // it see what's being saved. The form submit reads from chips.
        noteTagsInput.value = (noteTagInput?.getNames() ?? []).join(", ");
      },
    });
    // Hide the raw input visually but keep it focusable for "Tab from
    // year → into tags" power users (they can still type comma-separated
    // and pick it up via blur → submit). Display: none would skip a11y
    // labelling so we make it sr-only-ish.
    noteTagsInput.classList.add("note-tags-legacy-input");
  }

  // Re-tint the sleeping-cat empty state when the user picks a new skin.
  window.addEventListener("cat:skin-changed", () => render());

  noteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = noteTitleInput.value.trim();
    if (!title) { setMessage(noteMessage, "Paper title is required.", "error"); return; }
    const yearRaw = noteYearInput.value.trim();
    const year = yearRaw ? Number(yearRaw) : null;
    if (year !== null && !Number.isFinite(year)) { setMessage(noteMessage, "Year must be a valid number.", "error"); return; }
    // Chip control is authoritative; if it has any chips use those,
    // otherwise fall back to splitting whatever the user typed into the
    // legacy CSV box (so a quick "tag1, tag2 <submit>" still works).
    const chipNames = noteTagInput?.getNames() ?? [];
    const tagNames = chipNames.length > 0
      ? chipNames
      : noteTagsInput.value.split(",").map((t) => t.trim()).filter(Boolean);
    const payload = {
      title, authors: noteAuthorsInput.value.trim(), year,
      key_points: noteKeyPointsInput.value.trim(),
      questions: noteQuestionsInput.value.trim(),
      tags: tagNames.join(", "),
      tag_names: tagNames,
      url: noteUrlInput.value.trim() || null,
      doi: noteDoiInput.value.trim() || null,
      abstract: noteAbstractInput.value.trim() || null,
      feynman_entry_id: noteFeynmanLink.value ? Number(noteFeynmanLink.value) : null,
      project_id: pendingProjectId,
      reading_status: noteReadingStatus.value as PaperReadingStatus,
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
      // Refresh autocomplete cache so any brand-new tags become
      // suggestable in subsequent inputs without a page reload.
      void refreshTagCache();
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
    // Lazy-load the backlinks panel on first open. The <summary> click
    // is what toggles the <details>; we hook before the default action
    // so the fetch starts immediately, then the user sees the spinner
    // when the panel opens. Loaded marker dedupes re-clicks (close+open).
    if (target.tagName === "SUMMARY") {
      const details = target.closest<HTMLDetailsElement>("details.note-backlinks");
      if (details && details.dataset.loaded !== "true") {
        const noteId = Number(details.dataset.backlinks);
        const body = details.querySelector<HTMLDivElement>(".note-backlinks-body");
        if (Number.isFinite(noteId) && body) {
          details.dataset.loaded = "true";
          body.innerHTML = `<p class="hint">Loading…</p>`;
          try {
            const data = await getLinks("paper_note", noteId);
            body.innerHTML = renderBacklinksHtml(data);
          } catch (e) {
            console.error(e);
            details.dataset.loaded = "";  // allow retry
            body.innerHTML = `<p class="message error">Could not load links.</p>`;
          }
        }
      }
      // Fall through — we don't return so the native toggle still happens.
    }
    const action = target.dataset.action;
    // Tag-filter actions don't need a note id — handle them before the
    // generic per-note dispatch.
    if (action === "filter-tag") {
      activeTagFilter = target.dataset.tag ?? null;
      render();
      return;
    }
    if (action === "clear-tag-filter") {
      activeTagFilter = null;
      render();
      return;
    }
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
      if (noteTagInput) {
        const names = note.tag_list && note.tag_list.length > 0
          ? note.tag_list.map((t) => t.name)
          : note.tags.split(",").map((t) => t.trim()).filter(Boolean);
        noteTagInput.setNames(names);
      }
      noteUrlInput.value = note.url ?? "";
      noteDoiInput.value = note.doi ?? "";
      noteAbstractInput.value = note.abstract ?? "";
      noteFeynmanLink.value = note.feynman_entry_id === null ? "" : String(note.feynman_entry_id);
      pendingProjectId = note.project_id;
      void rerenderNoteProjectPicker();
      noteReadingStatus.value = note.reading_status;
      noteSubmitButton.textContent = "Update note";
      noteCancelButton.classList.remove("hidden");
      noteEditorDetails.open = true;
      switchToView("notes");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (action === "read-today") {
      try {
        await addNoteToToday(note.id);
        setMessage(noteMessage, `"${note.title}" added under today's Reading list.`, "success");
        window.dispatchEvent(new CustomEvent("task-list:updated"));
        await onRefreshNeeded();
      } catch (error) {
        console.error(error);
        setMessage(noteMessage, "Could not add reading task.", "error");
      }
    } else if (action === "start-feynman") {
      try {
        // Same "concept seed" pattern as manual creation: prefill from the
        // paper title, leave the rest blank — the user will write step 2-4.
        const entry = await createFeynmanEntry({
          concept: note.title,
          explanation: "",
          gaps: "",
          analogy: "",
          project_id: note.project_id,
        });
        await updateNote(note.id, { feynman_entry_id: entry.id });
        setMessage(noteMessage, "Feynman record created and linked.", "success");
        await onRefreshNeeded();
        switchToView("feynman");
        await FeynmanView.loadForEdit(entry.id);
      } catch (error) {
        console.error(error);
        setMessage(noteMessage, "Could not start Feynman.", "error");
      }
    } else if (action === "open-feynman") {
      if (note.feynman_entry_id === null) return;
      switchToView("feynman");
      await FeynmanView.loadForEdit(note.feynman_entry_id);
    } else if (action === "delete") {
      const extra = note.source === "zotero"
        ? "\n(The item stays in your Zotero library — only this local note is removed.)"
        : "";
      if (!window.confirm(`Delete note "${note.title}"?${extra}`)) return;
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

  notesList.addEventListener("change", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !target.dataset.noteStatus) return;
    const noteId = Number(target.dataset.noteStatus);
    try {
      await updateNote(noteId, { reading_status: target.value as PaperReadingStatus });
      await onRefreshNeeded();
    } catch (error) {
      console.error(error);
      setMessage(noteMessage, "Could not update reading status.", "error");
    }
  });

  noteSearchInput.addEventListener("input", () => render());
  noteTagFilterInput.addEventListener("input", () => render());

  zoteroSettingsButton.addEventListener("click", () => {
    void showZoteroSettingsModal(onRefreshNeeded);
  });
  zoteroImportButton.addEventListener("click", () => {
    void showZoteroImportModal(onRefreshNeeded);
  });

  void refreshZoteroState();
  // First-paint the project picker; re-paints itself on projects:updated.
  void rerenderNoteProjectPicker();
  // Re-render cards when project metadata changes so chips reflect renames.
  window.addEventListener("projects:updated", () => render());
  window.addEventListener("paper-insights:updated", () => void refresh());
}

// ---------------------------------------------------------------------------
// Zotero: settings modal
// ---------------------------------------------------------------------------

async function showZoteroSettingsModal(onRefreshNeeded: () => Promise<void>): Promise<void> {
  // Re-fetch in case another tab disconnected meanwhile.
  await refreshZoteroState();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal-card modal-wide" role="dialog" aria-modal="true" aria-labelledby="zotero-settings-title">
      <h3 id="zotero-settings-title">Connect to Zotero</h3>
      ${zoteroConfig.connected ? `
        <p class="hint">Connected as user <strong>${escapeHtml(zoteroConfig.zotero_user_id ?? "")}</strong>.</p>
      ` : ""}
      <p>Zotero gives every user a personal API key. We use yours to read your library — your key is encrypted at rest and only you can use it.</p>
      <ol class="zotero-howto">
        <li>Go to <a href="https://www.zotero.org/settings/keys" target="_blank" rel="noopener">zotero.org/settings/keys</a></li>
        <li>Click <em>Create new private key</em> · check <em>Allow library access</em></li>
        <li>Copy the key, and copy your numeric <em>userID</em> from the same page</li>
      </ol>
      <label>Zotero user ID
        <input id="zotero-user-id" type="text" inputmode="numeric" placeholder="e.g. 1234567"
               value="${escapeHtml(zoteroConfig.zotero_user_id ?? "")}" />
      </label>
      <label>API key
        <input id="zotero-api-key" type="password" autocomplete="off"
               placeholder="${zoteroConfig.connected ? "Enter to replace existing key" : "P9..."}" />
      </label>
      <p id="zotero-settings-message" class="message"></p>
      <div class="modal-actions">
        ${zoteroConfig.connected
          ? `<button type="button" class="danger" data-zotero-action="disconnect">Disconnect</button>`
          : ""}
        <button type="button" class="secondary" data-zotero-action="cancel">Close</button>
        <button type="button" data-zotero-action="save">Save &amp; verify</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = (): void => backdrop.remove();
  const msg = backdrop.querySelector<HTMLParagraphElement>("#zotero-settings-message")!;
  const userIdInput = backdrop.querySelector<HTMLInputElement>("#zotero-user-id")!;
  const apiKeyInput = backdrop.querySelector<HTMLInputElement>("#zotero-api-key")!;

  backdrop.addEventListener("click", async (e) => {
    const t = e.target;
    if (t === backdrop) { close(); return; }
    if (!(t instanceof HTMLElement) || !t.dataset.zoteroAction) return;
    const action = t.dataset.zoteroAction;
    if (action === "cancel") { close(); return; }

    if (action === "disconnect") {
      if (!window.confirm("Disconnect Zotero? Previously-imported notes will stay.")) return;
      try {
        await disconnectZotero();
        setMessage(msg, "Disconnected.", "success");
        await refreshZoteroState();
        await onRefreshNeeded();
        setTimeout(close, 500);
      } catch (err) {
        setMessage(msg, parseError(err, "Could not disconnect."), "error");
      }
      return;
    }

    if (action === "save") {
      const userId = userIdInput.value.trim();
      const apiKey = apiKeyInput.value.trim();
      if (!userId || !/^[0-9]+$/.test(userId)) {
        setMessage(msg, "Zotero user ID must be numeric.", "error");
        return;
      }
      if (!apiKey) {
        setMessage(msg, "Paste your API key first.", "error");
        return;
      }
      const saveBtn = t as HTMLButtonElement;
      saveBtn.disabled = true;
      saveBtn.textContent = "Verifying…";
      try {
        await setZoteroConfig(userId, apiKey);
        setMessage(msg, "Connected.", "success");
        await refreshZoteroState();
        await onRefreshNeeded();
        setTimeout(close, 400);
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save & verify";
        setMessage(msg, parseError(err, "Zotero verification failed."), "error");
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Zotero: import modal
// ---------------------------------------------------------------------------

interface ImportState {
  items: ZoteroItem[];
  total: number;
  start: number;
  limit: number;
  query: string;
  selected: Set<string>;
  loading: boolean;
}

async function showZoteroImportModal(onRefreshNeeded: () => Promise<void>): Promise<void> {
  const state: ImportState = {
    items: [],
    total: 0,
    start: 0,
    limit: 25,
    query: "",
    selected: new Set(),
    loading: false,
  };

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal-card modal-wide modal-tall" role="dialog" aria-modal="true" aria-labelledby="zotero-import-title">
      <div class="modal-header-row">
        <h3 id="zotero-import-title">Import from Zotero</h3>
        <button type="button" class="link-btn" data-zotero-import="close" aria-label="Close">×</button>
      </div>
      <form class="zotero-search-row" data-zotero-import="search-form">
        <input type="search" id="zotero-search-input" placeholder="Search title / author / year..." />
        <button type="submit" class="secondary">Search</button>
      </form>
      <div id="zotero-import-list" class="zotero-import-list">
        <p class="hint">Loading your library…</p>
      </div>
      <div class="zotero-import-footer">
        <span id="zotero-import-meta" class="hint"></span>
        <div class="modal-actions">
          <button type="button" class="secondary" data-zotero-import="prev">← Prev</button>
          <button type="button" class="secondary" data-zotero-import="next">Next →</button>
          <button type="button" data-zotero-import="run" disabled>Import selected</button>
        </div>
      </div>
      <p id="zotero-import-message" class="message"></p>
    </div>
  `;
  document.body.appendChild(backdrop);

  const listEl = backdrop.querySelector<HTMLDivElement>("#zotero-import-list")!;
  const metaEl = backdrop.querySelector<HTMLSpanElement>("#zotero-import-meta")!;
  const msgEl = backdrop.querySelector<HTMLParagraphElement>("#zotero-import-message")!;
  const runBtn = backdrop.querySelector<HTMLButtonElement>('[data-zotero-import="run"]')!;
  const prevBtn = backdrop.querySelector<HTMLButtonElement>('[data-zotero-import="prev"]')!;
  const nextBtn = backdrop.querySelector<HTMLButtonElement>('[data-zotero-import="next"]')!;
  const searchInput = backdrop.querySelector<HTMLInputElement>("#zotero-search-input")!;

  const close = (): void => backdrop.remove();

  function renderList(): void {
    if (state.loading) {
      listEl.innerHTML = `<p class="hint">Loading…</p>`;
      return;
    }
    if (state.items.length === 0) {
      listEl.innerHTML = `<p class="empty-state">No items found${state.query ? ` for "${escapeHtml(state.query)}"` : ""}.</p>`;
      return;
    }
    listEl.innerHTML = state.items.map((item) => {
      const checked = state.selected.has(item.key) ? "checked" : "";
      const importedBadge = item.already_imported
        ? `<span class="source-badge">already imported · re-sync</span>`
        : "";
      const meta = [
        item.authors || "Unknown authors",
        item.year ? String(item.year) : "",
        humanItemType(item.item_type),
      ].filter(Boolean).join(" · ");
      return `
        <label class="zotero-item${item.already_imported ? " is-imported" : ""}">
          <input type="checkbox" data-zotero-key="${escapeHtml(item.key)}" ${checked} />
          <span class="zotero-item-body">
            <span class="zotero-item-title">${escapeHtml(item.title)} ${importedBadge}</span>
            <span class="zotero-item-meta">${escapeHtml(meta)}</span>
          </span>
        </label>
      `;
    }).join("");
  }

  function renderMeta(): void {
    const shown = state.items.length;
    const from = shown === 0 ? 0 : state.start + 1;
    const to = state.start + shown;
    metaEl.textContent = `${from}-${to} of ${state.total} · ${state.selected.size} selected`;
    prevBtn.disabled = state.start === 0 || state.loading;
    nextBtn.disabled = state.start + state.limit >= state.total || state.loading;
    runBtn.disabled = state.selected.size === 0 || state.loading;
  }

  async function load(): Promise<void> {
    state.loading = true;
    renderList();
    renderMeta();
    try {
      const resp = await listZoteroItems({
        limit: state.limit,
        start: state.start,
        q: state.query || undefined,
      });
      state.items = resp.items;
      state.total = resp.total;
    } catch (err) {
      setMessage(msgEl, parseError(err, "Could not list Zotero items."), "error");
      state.items = [];
      state.total = 0;
    } finally {
      state.loading = false;
      renderList();
      renderMeta();
    }
  }

  listEl.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== "checkbox") return;
    const key = t.dataset.zoteroKey;
    if (!key) return;
    if (t.checked) state.selected.add(key);
    else state.selected.delete(key);
    renderMeta();
  });

  backdrop.addEventListener("click", async (e) => {
    const t = e.target;
    if (t === backdrop) { close(); return; }
    if (!(t instanceof HTMLElement)) return;
    const action = t.dataset.zoteroImport;
    if (action === "close") { close(); return; }
    if (action === "prev") {
      state.start = Math.max(0, state.start - state.limit);
      await load();
      return;
    }
    if (action === "next") {
      state.start = state.start + state.limit;
      await load();
      return;
    }
    if (action === "run") {
      const keys = Array.from(state.selected);
      if (keys.length === 0) return;
      runBtn.disabled = true;
      const originalLabel = runBtn.textContent;
      runBtn.textContent = `Importing ${keys.length}…`;
      try {
        const result = await importZoteroItems(keys, "preserve");
        const parts: string[] = [];
        if (result.imported > 0) parts.push(`${result.imported} new`);
        if (result.updated > 0) parts.push(`${result.updated} updated`);
        if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
        setMessage(msgEl, `Imported: ${parts.join(", ") || "0"}.`, "success");
        state.selected.clear();
        await onRefreshNeeded();
        await load();
      } catch (err) {
        setMessage(msgEl, parseError(err, "Import failed."), "error");
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = originalLabel;
      }
    }
  });

  backdrop.querySelector<HTMLFormElement>('[data-zotero-import="search-form"]')!
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      state.query = searchInput.value.trim();
      state.start = 0;
      state.selected.clear();
      await load();
    });

  await load();
}

function parseError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    try {
      const parsed = JSON.parse(e.body) as { detail?: string };
      if (parsed?.detail) return parsed.detail;
    } catch { /* fall through */ }
  }
  return fallback;
}
