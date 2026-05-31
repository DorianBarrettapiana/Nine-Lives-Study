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
  type ZoteroConfig,
  type ZoteroItem,
} from "../api/notes";
import { ApiError } from "../api/client";
import { escapeHtml, setMessage } from "../utils";
import { renderEmptyStateWithCat } from "./icons";

let notesList: HTMLDivElement;
let noteForm: HTMLFormElement;
let noteTitleInput: HTMLInputElement;
let noteAuthorsInput: HTMLInputElement;
let noteYearInput: HTMLInputElement;
let noteKeyPointsInput: HTMLTextAreaElement;
let noteQuestionsInput: HTMLTextAreaElement;
let noteTagsInput: HTMLInputElement;
let noteUrlInput: HTMLInputElement;
let noteDoiInput: HTMLInputElement;
let noteAbstractInput: HTMLTextAreaElement;
let noteSubmitButton: HTMLButtonElement;
let noteCancelButton: HTMLButtonElement;
let noteMessage: HTMLParagraphElement;
let zoteroSettingsButton: HTMLButtonElement;
let zoteroImportButton: HTMLButtonElement;

let notes: PaperNoteRead[] = [];
let editedNoteId: number | null = null;
let zoteroConfig: ZoteroConfig = { connected: false, zotero_user_id: null };

export function getNotes(): PaperNoteRead[] { return notes; }

function clearNoteForm(): void {
  editedNoteId = null;
  noteTitleInput.value = "";
  noteAuthorsInput.value = "";
  noteYearInput.value = "";
  noteKeyPointsInput.value = "";
  noteQuestionsInput.value = "";
  noteTagsInput.value = "";
  noteUrlInput.value = "";
  noteDoiInput.value = "";
  noteAbstractInput.value = "";
  noteSubmitButton.textContent = "Add note";
  noteCancelButton.classList.add("hidden");
}

function zoteroDeepLink(note: PaperNoteRead): string | null {
  if (!note.zotero_key || !zoteroConfig.zotero_user_id) return null;
  // The web library URL accepts the per-item key directly. Falls back to
  // the user's overall library if the item was deleted on Zotero's side.
  return `https://www.zotero.org/users/${zoteroConfig.zotero_user_id}/items/${note.zotero_key}`;
}

export function render(): void {
  if (notes.length === 0) {
    notesList.innerHTML = renderEmptyStateWithCat("No paper note yet.");
    return;
  }
  notesList.innerHTML = notes.map((note) => {
    const tags = note.tags.split(",").map((t) => t.trim()).filter(Boolean)
      .map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
    const zoteroLink = zoteroDeepLink(note);
    const sourceBadge = note.source === "zotero"
      ? `<span class="source-badge zotero-badge" title="Imported from Zotero">📚 Zotero</span>`
      : "";
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
    return `
      <article class="note-card">
        <div class="note-header">
          <div>
            <h3>${escapeHtml(note.title)}${sourceBadge}</h3>
            <p class="note-meta">${escapeHtml(note.authors || "Unknown authors")}${note.year ? ` (${note.year})` : ""}${note.item_type ? ` · ${escapeHtml(humanItemType(note.item_type))}` : ""}</p>
          </div>
          <div class="note-actions">
            <button class="secondary" data-action="edit" data-id="${note.id}">Edit</button>
            <button class="danger" data-action="delete" data-id="${note.id}">Delete</button>
          </div>
        </div>
        ${linksHtml}
        ${note.key_points ? `<p class="note-text"><strong>Key ideas:</strong> ${escapeHtml(note.key_points)}</p>` : ""}
        ${note.questions ? `<p class="note-text"><strong>Questions:</strong> ${escapeHtml(note.questions)}</p>` : ""}
        ${abstractHtml}
        ${tags ? `<div class="tags">${tags}</div>` : ""}
      </article>`;
  }).join("");
}

function humanItemType(itemType: string): string {
  // Zotero camel-cases its item types. Display them with a space.
  return itemType.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

export async function refresh(): Promise<void> {
  try {
    notes = await listNotes();
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
  noteTitleInput = document.querySelector<HTMLInputElement>("#note-title")!;
  noteAuthorsInput = document.querySelector<HTMLInputElement>("#note-authors")!;
  noteYearInput = document.querySelector<HTMLInputElement>("#note-year")!;
  noteKeyPointsInput = document.querySelector<HTMLTextAreaElement>("#note-key-points")!;
  noteQuestionsInput = document.querySelector<HTMLTextAreaElement>("#note-questions")!;
  noteTagsInput = document.querySelector<HTMLInputElement>("#note-tags")!;
  noteUrlInput = document.querySelector<HTMLInputElement>("#note-url")!;
  noteDoiInput = document.querySelector<HTMLInputElement>("#note-doi")!;
  noteAbstractInput = document.querySelector<HTMLTextAreaElement>("#note-abstract")!;
  noteSubmitButton = document.querySelector<HTMLButtonElement>("#note-submit-button")!;
  noteCancelButton = document.querySelector<HTMLButtonElement>("#note-cancel-button")!;
  noteMessage = document.querySelector<HTMLParagraphElement>("#note-message")!;
  zoteroSettingsButton = document.querySelector<HTMLButtonElement>("#zotero-settings-button")!;
  zoteroImportButton = document.querySelector<HTMLButtonElement>("#zotero-import-button")!;

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
      url: noteUrlInput.value.trim() || null,
      doi: noteDoiInput.value.trim() || null,
      abstract: noteAbstractInput.value.trim() || null,
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
      noteUrlInput.value = note.url ?? "";
      noteDoiInput.value = note.doi ?? "";
      noteAbstractInput.value = note.abstract ?? "";
      noteSubmitButton.textContent = "Update note";
      noteCancelButton.classList.remove("hidden");
      switchToView("notes");
      window.scrollTo({ top: 0, behavior: "smooth" });
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

  zoteroSettingsButton.addEventListener("click", () => {
    void showZoteroSettingsModal(onRefreshNeeded);
  });
  zoteroImportButton.addEventListener("click", () => {
    void showZoteroImportModal(onRefreshNeeded);
  });

  void refreshZoteroState();
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
