/**
 * Mood journal view.
 */

import { createMoodEntry, deleteMoodEntry, listMoodEntries, type MoodEntryRead } from "../api/mood";
import { escapeHtml, setMessage } from "../utils";

const MOODS = [
  { emoji: "😩", label: "Exhausted" },
  { emoji: "😔", label: "Low" },
  { emoji: "😐", label: "Neutral" },
  { emoji: "🙂", label: "Good" },
  { emoji: "🔥", label: "On fire" },
] as const;

let moodPickerEl: HTMLDivElement;
let moodReflectionInput: HTMLTextAreaElement;
let saveMoodButton: HTMLButtonElement;
let moodMessage: HTMLParagraphElement;
let moodList: HTMLDivElement;

let entries: MoodEntryRead[] = [];
let selectedMood = "";
export let moodDays = 30;

function renderPicker(): void {
  moodPickerEl.innerHTML = MOODS.map((m) => `
    <button class="mood-button ${selectedMood === m.emoji ? "active" : ""}" data-mood="${m.emoji}" title="${m.label}">
      ${m.emoji}
    </button>`).join("");
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function render(): void {
  renderPicker();

  if (entries.length === 0) {
    moodList.innerHTML = `<div class="empty-state">No mood entries yet. How are you feeling?</div>`;
    return;
  }

  moodList.innerHTML = entries.map((e) => {
    const preview = e.reflection
      ? `<p class="mood-entry-preview">${escapeHtml(e.reflection.slice(0, 80))}${e.reflection.length > 80 ? "…" : ""}</p>`
      : "";
    const full = e.reflection
      ? `<p class="mood-entry-full hidden">${escapeHtml(e.reflection)}</p>`
      : "";
    return `
      <div class="mood-entry-card" data-id="${e.id}">
        <div class="mood-entry-header">
          <span class="mood-entry-emoji">${e.mood}</span>
          <span class="mood-entry-time hint">${formatDateTime(e.created_at)}</span>
          <button class="mood-entry-delete danger-small" data-delete-id="${e.id}" title="Delete">×</button>
        </div>
        ${preview}
        ${full}
        ${e.reflection && e.reflection.length > 80 ? `<button class="mood-entry-expand link-btn" data-expand-id="${e.id}">Read more</button>` : ""}
      </div>`;
  }).join("");
}

export async function refresh(): Promise<void> {
  try {
    entries = await listMoodEntries(moodDays);
    render();
  } catch (error) {
    console.error(error);
    setMessage(moodMessage, "Could not load mood entries.", "error");
  }
}

export function init(onDataChanged: () => Promise<void>): void {
  moodPickerEl = document.querySelector<HTMLDivElement>("#mood-picker")!;
  moodReflectionInput = document.querySelector<HTMLTextAreaElement>("#mood-reflection-input")!;
  saveMoodButton = document.querySelector<HTMLButtonElement>("#save-mood-button")!;
  moodMessage = document.querySelector<HTMLParagraphElement>("#mood-message")!;
  moodList = document.querySelector<HTMLDivElement>("#mood-list")!;

  renderPicker();

  moodPickerEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const mood = target.dataset.mood;
    if (!mood) return;
    selectedMood = mood;
    renderPicker();
  });

  saveMoodButton.addEventListener("click", async () => {
    if (!selectedMood) { setMessage(moodMessage, "Pick a mood first.", "error"); return; }
    try {
      await createMoodEntry({ mood: selectedMood, reflection: moodReflectionInput.value.trim() });
      selectedMood = "";
      moodReflectionInput.value = "";
      setMessage(moodMessage, "Mood recorded. +3 XP", "success");
      await onDataChanged();
    } catch (error) {
      console.error(error);
      setMessage(moodMessage, "Could not save mood.", "error");
    }
  });

  moodList.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;

    // Expand / collapse reflection
    const expandId = target.dataset.expandId;
    if (expandId) {
      const card = moodList.querySelector<HTMLDivElement>(`[data-id="${expandId}"]`);
      if (!card) return;
      const preview = card.querySelector<HTMLElement>(".mood-entry-preview");
      const full = card.querySelector<HTMLElement>(".mood-entry-full");
      const btn = card.querySelector<HTMLButtonElement>(".mood-entry-expand");
      if (preview && full && btn) {
        const isExpanded = !full.classList.contains("hidden");
        preview.classList.toggle("hidden", !isExpanded);
        full.classList.toggle("hidden", isExpanded);
        btn.textContent = isExpanded ? "Read more" : "Show less";
      }
      return;
    }

    // Delete
    const deleteId = target.dataset.deleteId;
    if (deleteId) {
      if (!window.confirm("Delete this mood entry?")) return;
      try {
        await deleteMoodEntry(Number(deleteId));
        setMessage(moodMessage, "Entry deleted.", "success");
        await refresh();
      } catch (error) {
        console.error(error);
        setMessage(moodMessage, "Could not delete entry.", "error");
      }
    }
  });

  // Days filter buttons
  document.querySelectorAll<HTMLButtonElement>("#mood-days-selector .days-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const days = Number(btn.dataset.days);
      if (!days) return;
      moodDays = days;
      document.querySelectorAll<HTMLButtonElement>("#mood-days-selector .days-btn").forEach((b) =>
        b.classList.toggle("active", b === btn),
      );
      await refresh();
    });
  });
}
