/**
 * Reusable tag chip input.
 *
 * Mount one per form via `mountTagInput(container, { initial, onChange })`.
 * Returns a controller with `getNames()` / `setNames()` / `clear()`. The
 * form submit handler reads `getNames()` and forwards as `tag_names`.
 *
 * Behaviour:
 *   - Type a name and press Enter, Tab, or comma → committed as a chip.
 *   - Backspace on empty input → removes the last chip.
 *   - Click the × on a chip → removes that chip.
 *   - Names are de-duplicated case-insensitively; first casing wins.
 *   - Autocomplete is sourced from a module-level cache populated by
 *     `refreshTagCache()`. Cached so multiple inputs on screen share one
 *     fetch; refresh after the user creates/deletes tags via item save.
 */

import { escapeHtml } from "../utils";
import { listTags, type TagRead } from "../api/tags";

let tagCache: TagRead[] = [];
let tagCacheLoaded = false;

/**
 * Reload the autocomplete cache. Call after an item save that may have
 * created new tags (or after the user explicitly renamed/deleted one).
 * Idempotent — multiple in-flight callers share the same promise.
 */
let inflight: Promise<void> | null = null;
export async function refreshTagCache(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      tagCache = await listTags();
      tagCacheLoaded = true;
    } catch (error) {
      console.warn("Could not load tag cache", error);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getCachedTags(): TagRead[] {
  return tagCache;
}

export function ensureTagCache(): void {
  if (!tagCacheLoaded && !inflight) void refreshTagCache();
}

export interface TagInputController {
  getNames(): string[];
  setNames(names: string[]): void;
  clear(): void;
  destroy(): void;
}

export interface TagInputOptions {
  initial?: string[];
  placeholder?: string;
  onChange?: (names: string[]) => void;
}

export function mountTagInput(
  container: HTMLElement,
  opts: TagInputOptions = {},
): TagInputController {
  let names: string[] = dedupe(opts.initial ?? []);
  let suggestionsVisible = false;
  let activeSuggestion = -1;

  container.classList.add("tag-input");
  container.innerHTML = `
    <div class="tag-input-chips" tabindex="-1">
      <input
        type="text"
        class="tag-input-text"
        placeholder="${escapeHtml(opts.placeholder ?? "Add tag…")}"
        autocomplete="off"
      />
    </div>
    <div class="tag-input-suggestions hidden" role="listbox"></div>
  `;

  const chipsHost = container.querySelector<HTMLDivElement>(".tag-input-chips")!;
  const input = container.querySelector<HTMLInputElement>(".tag-input-text")!;
  const suggestionsHost = container.querySelector<HTMLDivElement>(".tag-input-suggestions")!;

  ensureTagCache();

  function renderChips(): void {
    // Remove existing chips (keep the input itself).
    Array.from(chipsHost.querySelectorAll<HTMLElement>(".tag-input-chip")).forEach((el) => el.remove());
    names.forEach((name, idx) => {
      const chip = document.createElement("span");
      chip.className = "tag-input-chip";
      chip.innerHTML = `${escapeHtml(name)}<button type="button" class="tag-input-chip-x" aria-label="Remove ${escapeHtml(name)}" data-idx="${idx}">×</button>`;
      chipsHost.insertBefore(chip, input);
    });
  }

  function notify(): void {
    if (opts.onChange) opts.onChange([...names]);
  }

  function addName(raw: string): void {
    const display = raw.trim().replace(/\s+/g, " ");
    if (!display) return;
    const key = display.toLowerCase();
    if (names.some((n) => n.toLowerCase() === key)) return;
    names = [...names, display];
    renderChips();
    notify();
  }

  function removeAt(idx: number): void {
    if (idx < 0 || idx >= names.length) return;
    names = names.filter((_, i) => i !== idx);
    renderChips();
    notify();
  }

  function commitInput(): void {
    if (!input.value.trim()) return;
    addName(input.value);
    input.value = "";
    hideSuggestions();
  }

  function showSuggestions(): void {
    const query = input.value.trim().toLowerCase();
    const used = new Set(names.map((n) => n.toLowerCase()));
    const matches = tagCache
      .filter((t) => !used.has(t.name.toLowerCase()))
      .filter((t) => !query || t.name.toLowerCase().includes(query))
      .slice(0, 8);
    if (matches.length === 0) {
      hideSuggestions();
      return;
    }
    suggestionsHost.innerHTML = matches.map((t, idx) => `
      <button type="button" class="tag-input-suggestion${idx === activeSuggestion ? " active" : ""}"
              data-name="${escapeHtml(t.name)}" role="option">
        <span>${escapeHtml(t.name)}</span>
        <span class="hint">${t.use_count}</span>
      </button>
    `).join("");
    suggestionsHost.classList.remove("hidden");
    suggestionsVisible = true;
  }

  function hideSuggestions(): void {
    suggestionsHost.classList.add("hidden");
    suggestionsVisible = false;
    activeSuggestion = -1;
  }

  function moveSuggestion(delta: number): void {
    const items = suggestionsHost.querySelectorAll<HTMLButtonElement>(".tag-input-suggestion");
    if (items.length === 0) return;
    activeSuggestion = (activeSuggestion + delta + items.length) % items.length;
    items.forEach((el, idx) => el.classList.toggle("active", idx === activeSuggestion));
  }

  function pickActiveSuggestion(): boolean {
    const items = suggestionsHost.querySelectorAll<HTMLButtonElement>(".tag-input-suggestion");
    if (activeSuggestion < 0 || activeSuggestion >= items.length) return false;
    const name = items[activeSuggestion].dataset.name ?? "";
    addName(name);
    input.value = "";
    hideSuggestions();
    return true;
  }

  // --- Listeners --------------------------------------------------------

  const onInput = (): void => {
    activeSuggestion = -1;
    showSuggestions();
  };
  const onFocus = (): void => {
    ensureTagCache();
    showSuggestions();
  };
  const onBlur = (): void => {
    // Delay so a click on a suggestion can register before we hide.
    window.setTimeout(() => {
      commitInput();
      hideSuggestions();
    }, 120);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (suggestionsVisible && activeSuggestion >= 0 && pickActiveSuggestion()) return;
      commitInput();
      return;
    }
    if (event.key === "Tab" && input.value.trim()) {
      // Tab commits but doesn't prevent focus moving on.
      commitInput();
      return;
    }
    if (event.key === "Backspace" && input.value === "" && names.length > 0) {
      removeAt(names.length - 1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!suggestionsVisible) showSuggestions();
      moveSuggestion(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSuggestion(-1);
      return;
    }
    if (event.key === "Escape") {
      hideSuggestions();
      return;
    }
  };
  const onChipsClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.classList.contains("tag-input-chip-x")) {
      removeAt(Number(target.dataset.idx ?? "-1"));
    } else if (target === chipsHost) {
      input.focus();
    }
  };
  const onSuggestionClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest<HTMLButtonElement>(".tag-input-suggestion");
    if (!btn) return;
    addName(btn.dataset.name ?? "");
    input.value = "";
    hideSuggestions();
    input.focus();
  };

  input.addEventListener("input", onInput);
  input.addEventListener("focus", onFocus);
  input.addEventListener("blur", onBlur);
  input.addEventListener("keydown", onKeyDown);
  chipsHost.addEventListener("click", onChipsClick);
  suggestionsHost.addEventListener("mousedown", (e) => e.preventDefault()); // keep input focus
  suggestionsHost.addEventListener("click", onSuggestionClick);

  renderChips();

  return {
    getNames: () => [...names],
    setNames: (next: string[]) => {
      names = dedupe(next);
      renderChips();
      notify();
    },
    clear: () => {
      names = [];
      input.value = "";
      renderChips();
      hideSuggestions();
      notify();
    },
    destroy: () => {
      input.removeEventListener("input", onInput);
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("blur", onBlur);
      input.removeEventListener("keydown", onKeyDown);
      chipsHost.removeEventListener("click", onChipsClick);
      suggestionsHost.removeEventListener("click", onSuggestionClick);
      container.innerHTML = "";
      container.classList.remove("tag-input");
    },
  };
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const display = raw.trim().replace(/\s+/g, " ");
    if (!display) continue;
    const key = display.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(display);
  }
  return out;
}
