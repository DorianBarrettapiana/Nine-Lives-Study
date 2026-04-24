/**
 * Frontend entry point.
 */

import "./style.css";
import {
  createFeynmanEntry,
  deleteFeynmanEntry,
  listFeynmanEntries,
  updateFeynmanEntry,
  type FeynmanEntryRead,
} from "./api/feynman";
import { createNote, deleteNote, listNotes, updateNote, type PaperNoteRead } from "./api/notes";
import {
  createDailyTask,
  deleteDailyTask,
  getDailyState,
  saveDailyLog,
  updateDailyTask,
  type DailyStateRead,
} from "./api/tracker";
import { createUser, listUsers, type UserRead } from "./api/users";

const CURRENT_USER_ID_KEY = "phdstudylab_current_user_id";

type AppView = "notes" | "feynman" | "tracker";

const FEYNMAN_STEPS = [
  {
    title: "1. Pick a concept",
    description: "Write down one concept or theory you want to understand deeply.",
    fieldLabel: "Concept",
    placeholder: "e.g. Monte Carlo ray tracing, separatrix, BRDF, heat flux...",
  },
  {
    title: "2. Teach it simply",
    description: "Explain it with the simplest possible words, as if teaching someone unfamiliar with it.",
    fieldLabel: "Simple explanation",
    placeholder: "Explain the concept without jargon...",
  },
  {
    title: "3. Find the gaps",
    description: "Identify vague parts, hidden assumptions, missing definitions or weak points.",
    fieldLabel: "Knowledge gaps",
    placeholder: "What remains unclear? What should you verify?",
  },
  {
    title: "4. Build an analogy",
    description: "Summarize the concept with a compact analogy or mental image.",
    fieldLabel: "Analogy",
    placeholder: "This is like...",
  },
] as const;

const MOODS = [
  { emoji: "😩", label: "Exhausted" },
  { emoji: "😔", label: "Low" },
  { emoji: "😐", label: "Neutral" },
  { emoji: "🙂", label: "Good" },
  { emoji: "🔥", label: "On fire" },
] as const;

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Could not find #app root element.");
}

let users: UserRead[] = [];
let currentUser: UserRead | null = null;

let currentView: AppView = "notes";

let notes: PaperNoteRead[] = [];
let editedNoteId: number | null = null;

let feynmanEntries: FeynmanEntryRead[] = [];
let feynmanStep = 0;
let feynmanDraft = ["", "", "", ""];
let editedFeynmanId: number | null = null;

let dailyState: DailyStateRead | null = null;
let selectedMood = "";

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div>
        <h1>PhDStudyLab</h1>
        <p class="subtitle">Clean rebuild — HTML/CSS/TypeScript + Python backend</p>
      </div>
      <div class="current-user" id="current-user-label">No user selected</div>
    </header>

    <main class="layout">
      <aside class="sidebar">
        <section class="card">
          <h2>Local user</h2>

          <label>
            Existing user
            <select id="user-select"></select>
          </label>

          <button id="select-user-button">Use this user</button>

          <div class="divider"></div>

          <form id="user-form" class="form">
            <label>
              New username
              <input id="username" type="text" placeholder="e.g. dorian" />
            </label>

            <label>
              Language
              <select id="language">
                <option value="fr">Français</option>
                <option value="en">English</option>
                <option value="zh">中文</option>
              </select>
            </label>

            <label>
              Theme
              <select id="theme">
                <option value="dark">dark</option>
                <option value="light">light</option>
              </select>
            </label>

            <button type="submit">Create and use user</button>
          </form>

          <p id="user-message" class="message"></p>
        </section>

        <section class="card">
          <h2>Roadmap</h2>
          <ol class="roadmap">
            <li class="done">Users</li>
            <li class="done">Paper notes</li>
            <li class="done">Feynman</li>
            <li class="active">Daily tracker</li>
            <li>Pomodoro</li>
            <li>Stats</li>
            <li>Gamification</li>
          </ol>
        </section>
      </aside>

      <section class="content">
        <nav class="feature-tabs">
          <button class="feature-tab active" data-view="notes">Paper notes</button>
          <button class="feature-tab" data-view="feynman">Feynman</button>
          <button class="feature-tab" data-view="tracker">Daily tracker</button>
        </nav>

        <div id="notes-view">
          <section class="card">
            <h2>Paper notes</h2>
            <p class="hint">
              Literature notes migrated from the original monolithic HTML application.
            </p>

            <form id="note-form" class="note-form">
              <label>
                Paper title *
                <input id="note-title" type="text" placeholder="Enter paper title..." required />
              </label>

              <div class="two-cols">
                <label>
                  Authors
                  <input id="note-authors" type="text" placeholder="Author A, Author B..." />
                </label>

                <label>
                  Year
                  <input id="note-year" type="number" placeholder="2026" />
                </label>
              </div>

              <label>
                Key ideas & method
                <textarea id="note-key-points" placeholder="Main idea, method, assumptions..."></textarea>
              </label>

              <label>
                Questions & thoughts
                <textarea id="note-questions" placeholder="Open questions, limitations, links with your work..."></textarea>
              </label>

              <label>
                Tags
                <input id="note-tags" type="text" placeholder="fusion, ray tracing, heat loads" />
              </label>

              <div class="button-row">
                <button type="submit" id="note-submit-button">Add note</button>
                <button type="button" id="note-cancel-button" class="secondary hidden">Cancel edit</button>
              </div>
            </form>

            <p id="note-message" class="message"></p>
          </section>

          <section class="card">
            <div class="section-header">
              <h2>Saved notes</h2>
              <button id="refresh-notes-button" class="secondary">Refresh</button>
            </div>
            <div id="notes-list" class="notes-list"></div>
          </section>
        </div>

        <div id="feynman-view" class="hidden">
          <section class="card">
            <h2>Feynman method</h2>
            <p class="hint">
              Build a compact understanding record in four steps.
            </p>

            <div class="steps-bar" id="feynman-steps"></div>

            <div class="feynman-editor">
              <h3 id="feynman-step-title"></h3>
              <p id="feynman-step-description" class="hint"></p>

              <label>
                <span id="feynman-field-label"></span>
                <textarea id="feynman-input"></textarea>
              </label>

              <div class="button-row">
                <button type="button" id="feynman-prev-button" class="secondary">Previous</button>
                <button type="button" id="feynman-next-button">Next</button>
                <button type="button" id="feynman-reset-button" class="secondary">Reset</button>
              </div>

              <p id="feynman-message" class="message"></p>
            </div>
          </section>

          <section class="card">
            <div class="section-header">
              <h2>Feynman records</h2>
              <button id="refresh-feynman-button" class="secondary">Refresh</button>
            </div>
            <div id="feynman-list" class="feynman-list"></div>
          </section>
        </div>

        <div id="tracker-view" class="hidden">
          <section class="card">
            <div class="section-header">
              <div>
                <h2>Daily tracker</h2>
                <p class="hint">Tasks, mood and daily reflection.</p>
              </div>
              <button id="refresh-tracker-button" class="secondary">Refresh</button>
            </div>

            <div class="tracker-progress">
              <div class="progress-header">
                <span>Today progress</span>
                <strong id="tracker-percent">0%</strong>
              </div>
              <div class="progress-bar">
                <div id="tracker-progress-fill" class="progress-fill"></div>
              </div>
              <p id="tracker-count" class="hint">0 / 0 tasks done</p>
            </div>

            <form id="task-form" class="task-form">
              <input id="task-input" type="text" placeholder="Add a task for today..." />
              <button type="submit">Add task</button>
            </form>

            <div id="task-list" class="task-list"></div>

            <div class="divider"></div>

            <h3>How do you feel today?</h3>
            <div id="mood-row" class="mood-row"></div>

            <label>
              Daily reflection
              <textarea id="reflection-input" placeholder="What did you do, learn, unblock or struggle with today?"></textarea>
            </label>

            <div class="button-row">
              <button id="save-log-button" type="button">Save daily log</button>
            </div>

            <p id="tracker-message" class="message"></p>
          </section>
        </div>
      </section>
    </main>
  </div>
`;

const currentUserLabel = document.querySelector<HTMLDivElement>("#current-user-label");
const userSelect = document.querySelector<HTMLSelectElement>("#user-select");
const selectUserButton = document.querySelector<HTMLButtonElement>("#select-user-button");
const userForm = document.querySelector<HTMLFormElement>("#user-form");
const usernameInput = document.querySelector<HTMLInputElement>("#username");
const languageSelect = document.querySelector<HTMLSelectElement>("#language");
const themeSelect = document.querySelector<HTMLSelectElement>("#theme");
const userMessage = document.querySelector<HTMLParagraphElement>("#user-message");

const featureTabs = document.querySelectorAll<HTMLButtonElement>(".feature-tab");
const notesView = document.querySelector<HTMLDivElement>("#notes-view");
const feynmanView = document.querySelector<HTMLDivElement>("#feynman-view");
const trackerView = document.querySelector<HTMLDivElement>("#tracker-view");

const noteForm = document.querySelector<HTMLFormElement>("#note-form");
const noteTitleInput = document.querySelector<HTMLInputElement>("#note-title");
const noteAuthorsInput = document.querySelector<HTMLInputElement>("#note-authors");
const noteYearInput = document.querySelector<HTMLInputElement>("#note-year");
const noteKeyPointsInput = document.querySelector<HTMLTextAreaElement>("#note-key-points");
const noteQuestionsInput = document.querySelector<HTMLTextAreaElement>("#note-questions");
const noteTagsInput = document.querySelector<HTMLInputElement>("#note-tags");
const noteSubmitButton = document.querySelector<HTMLButtonElement>("#note-submit-button");
const noteCancelButton = document.querySelector<HTMLButtonElement>("#note-cancel-button");
const noteMessage = document.querySelector<HTMLParagraphElement>("#note-message");
const notesList = document.querySelector<HTMLDivElement>("#notes-list");
const refreshNotesButton = document.querySelector<HTMLButtonElement>("#refresh-notes-button");

const feynmanSteps = document.querySelector<HTMLDivElement>("#feynman-steps");
const feynmanStepTitle = document.querySelector<HTMLHeadingElement>("#feynman-step-title");
const feynmanStepDescription = document.querySelector<HTMLParagraphElement>("#feynman-step-description");
const feynmanFieldLabel = document.querySelector<HTMLSpanElement>("#feynman-field-label");
const feynmanInput = document.querySelector<HTMLTextAreaElement>("#feynman-input");
const feynmanPrevButton = document.querySelector<HTMLButtonElement>("#feynman-prev-button");
const feynmanNextButton = document.querySelector<HTMLButtonElement>("#feynman-next-button");
const feynmanResetButton = document.querySelector<HTMLButtonElement>("#feynman-reset-button");
const feynmanMessage = document.querySelector<HTMLParagraphElement>("#feynman-message");
const feynmanList = document.querySelector<HTMLDivElement>("#feynman-list");
const refreshFeynmanButton = document.querySelector<HTMLButtonElement>("#refresh-feynman-button");

const refreshTrackerButton = document.querySelector<HTMLButtonElement>("#refresh-tracker-button");
const trackerPercent = document.querySelector<HTMLStrongElement>("#tracker-percent");
const trackerProgressFill = document.querySelector<HTMLDivElement>("#tracker-progress-fill");
const trackerCount = document.querySelector<HTMLParagraphElement>("#tracker-count");
const taskForm = document.querySelector<HTMLFormElement>("#task-form");
const taskInput = document.querySelector<HTMLInputElement>("#task-input");
const taskList = document.querySelector<HTMLDivElement>("#task-list");
const moodRow = document.querySelector<HTMLDivElement>("#mood-row");
const reflectionInput = document.querySelector<HTMLTextAreaElement>("#reflection-input");
const saveLogButton = document.querySelector<HTMLButtonElement>("#save-log-button");
const trackerMessage = document.querySelector<HTMLParagraphElement>("#tracker-message");

if (
  !currentUserLabel ||
  !userSelect ||
  !selectUserButton ||
  !userForm ||
  !usernameInput ||
  !languageSelect ||
  !themeSelect ||
  !userMessage ||
  !notesView ||
  !feynmanView ||
  !trackerView ||
  !noteForm ||
  !noteTitleInput ||
  !noteAuthorsInput ||
  !noteYearInput ||
  !noteKeyPointsInput ||
  !noteQuestionsInput ||
  !noteTagsInput ||
  !noteSubmitButton ||
  !noteCancelButton ||
  !noteMessage ||
  !notesList ||
  !refreshNotesButton ||
  !feynmanSteps ||
  !feynmanStepTitle ||
  !feynmanStepDescription ||
  !feynmanFieldLabel ||
  !feynmanInput ||
  !feynmanPrevButton ||
  !feynmanNextButton ||
  !feynmanResetButton ||
  !feynmanMessage ||
  !feynmanList ||
  !refreshFeynmanButton ||
  !refreshTrackerButton ||
  !trackerPercent ||
  !trackerProgressFill ||
  !trackerCount ||
  !taskForm ||
  !taskInput ||
  !taskList ||
  !moodRow ||
  !reflectionInput ||
  !saveLogButton ||
  !trackerMessage
) {
  throw new Error("Could not find one or more DOM elements.");
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function setMessage(
  element: HTMLElement,
  text: string,
  kind: "success" | "error" | "neutral" = "neutral",
): void {
  element.textContent = text;
  element.className = `message ${kind}`;
}

function getStoredUserId(): number | null {
  const raw = localStorage.getItem(CURRENT_USER_ID_KEY);
  if (!raw) {
    return null;
  }

  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function storeCurrentUserId(userId: number): void {
  localStorage.setItem(CURRENT_USER_ID_KEY, String(userId));
}

function switchView(view: AppView): void {
  currentView = view;

  notesView.classList.toggle("hidden", view !== "notes");
  feynmanView.classList.toggle("hidden", view !== "feynman");
  trackerView.classList.toggle("hidden", view !== "tracker");

  featureTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === view);
  });
}

function renderUserSelect(): void {
  if (users.length === 0) {
    userSelect.innerHTML = `<option value="">No user available</option>`;
    return;
  }

  userSelect.innerHTML = users
    .map((user) => `<option value="${user.id}">${escapeHtml(user.username)}</option>`)
    .join("");

  if (currentUser) {
    userSelect.value = String(currentUser.id);
  }
}

function renderCurrentUser(): void {
  if (!currentUser) {
    currentUserLabel.textContent = "No user selected";
    currentUserLabel.className = "current-user warning";
    return;
  }

  currentUserLabel.textContent = `Current user: ${currentUser.username}`;
  currentUserLabel.className = "current-user";
}

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

function renderNotes(): void {
  if (!currentUser) {
    notesList.innerHTML = `
      <div class="empty-state">
        Select or create a user before managing paper notes.
      </div>
    `;
    return;
  }

  if (notes.length === 0) {
    notesList.innerHTML = `
      <div class="empty-state">
        No paper note yet.
      </div>
    `;
    return;
  }

  notesList.innerHTML = notes
    .map((note) => {
      const tags = note.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
        .join("");

      return `
        <article class="note-card">
          <div class="note-header">
            <div>
              <h3>${escapeHtml(note.title)}</h3>
              <p class="note-meta">
                ${escapeHtml(note.authors || "Unknown authors")}
                ${note.year ? `(${note.year})` : ""}
              </p>
            </div>
            <div class="note-actions">
              <button class="secondary" data-action="edit" data-id="${note.id}">Edit</button>
              <button class="danger" data-action="delete" data-id="${note.id}">Delete</button>
            </div>
          </div>

          ${
            note.key_points
              ? `<p class="note-text"><strong>Key ideas:</strong> ${escapeHtml(note.key_points)}</p>`
              : ""
          }

          ${
            note.questions
              ? `<p class="note-text"><strong>Questions:</strong> ${escapeHtml(note.questions)}</p>`
              : ""
          }

          ${tags ? `<div class="tags">${tags}</div>` : ""}
        </article>
      `;
    })
    .join("");
}

function renderFeynmanStep(): void {
  const step = FEYNMAN_STEPS[feynmanStep];

  feynmanSteps.innerHTML = FEYNMAN_STEPS.map((_, index) => {
    const stateClass = index === feynmanStep ? "active" : index < feynmanStep ? "done" : "";
    return `<div class="step-dot ${stateClass}">${index + 1}</div>`;
  }).join("");

  feynmanStepTitle.textContent = step.title;
  feynmanStepDescription.textContent = step.description;
  feynmanFieldLabel.textContent = step.fieldLabel;
  feynmanInput.placeholder = step.placeholder;
  feynmanInput.value = feynmanDraft[feynmanStep] ?? "";

  feynmanPrevButton.disabled = feynmanStep === 0;
  feynmanNextButton.textContent =
    feynmanStep === FEYNMAN_STEPS.length - 1
      ? editedFeynmanId === null
        ? "Save entry"
        : "Update entry"
      : "Next";

  if (editedFeynmanId !== null) {
    setMessage(feynmanMessage, "Editing an existing Feynman record.", "neutral");
  }
}

function clearFeynmanDraft(): void {
  editedFeynmanId = null;
  feynmanStep = 0;
  feynmanDraft = ["", "", "", ""];
  setMessage(feynmanMessage, "", "neutral");
  renderFeynmanStep();
}

function renderFeynmanEntries(): void {
  if (!currentUser) {
    feynmanList.innerHTML = `
      <div class="empty-state">
        Select or create a user before managing Feynman records.
      </div>
    `;
    return;
  }

  if (feynmanEntries.length === 0) {
    feynmanList.innerHTML = `
      <div class="empty-state">
        No Feynman record yet.
      </div>
    `;
    return;
  }

  feynmanList.innerHTML = feynmanEntries
    .map(
      (entry) => `
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

          ${
            entry.explanation
              ? `<p class="note-text"><strong>Simple explanation:</strong> ${escapeHtml(entry.explanation)}</p>`
              : ""
          }

          ${
            entry.gaps
              ? `<p class="note-text"><strong>Gaps:</strong> ${escapeHtml(entry.gaps)}</p>`
              : ""
          }

          ${
            entry.analogy
              ? `<p class="note-text"><strong>Analogy:</strong> ${escapeHtml(entry.analogy)}</p>`
              : ""
          }
        </article>
      `,
    )
    .join("");
}

function renderTracker(): void {
  if (!currentUser) {
    taskList.innerHTML = `
      <div class="empty-state">
        Select or create a user before using the daily tracker.
      </div>
    `;
    trackerPercent.textContent = "0%";
    trackerProgressFill.style.width = "0%";
    trackerCount.textContent = "0 / 0 tasks done";
    return;
  }

  if (!dailyState) {
    taskList.innerHTML = `
      <div class="empty-state">
        Daily tracker not loaded yet.
      </div>
    `;
    return;
  }

  trackerPercent.textContent = `${dailyState.completion_percent}%`;
  trackerProgressFill.style.width = `${dailyState.completion_percent}%`;
  trackerCount.textContent = `${dailyState.done_count} / ${dailyState.total_count} tasks done`;

  if (dailyState.tasks.length === 0) {
    taskList.innerHTML = `
      <div class="empty-state">
        No task for today.
      </div>
    `;
  } else {
    taskList.innerHTML = dailyState.tasks
      .map(
        (task) => `
          <div class="task-item">
            <button
              class="task-checkbox ${task.is_done ? "checked" : ""}"
              data-task-action="toggle"
              data-id="${task.id}"
              aria-label="Toggle task"
            >
              ${task.is_done ? "✓" : ""}
            </button>
            <span class="task-text ${task.is_done ? "done" : ""}">
              ${escapeHtml(task.text)}
            </span>
            <button class="task-delete" data-task-action="delete" data-id="${task.id}">×</button>
          </div>
        `,
      )
      .join("");
  }

  selectedMood = dailyState.log?.mood ?? "";
  reflectionInput.value = dailyState.log?.reflection ?? "";

  moodRow.innerHTML = MOODS.map((mood) => {
    const activeClass = selectedMood === mood.emoji ? "active" : "";
    return `
      <button
        class="mood-button ${activeClass}"
        data-mood="${mood.emoji}"
        title="${mood.label}"
      >
        ${mood.emoji}
      </button>
    `;
  }).join("");
}

async function refreshUsers(): Promise<void> {
  try {
    users = await listUsers();

    const storedUserId = getStoredUserId();
    currentUser = storedUserId ? users.find((user) => user.id === storedUserId) ?? null : currentUser;

    if (!currentUser && users.length > 0) {
      currentUser = users[0];
      storeCurrentUserId(currentUser.id);
    }

    renderUserSelect();
    renderCurrentUser();
  } catch (error) {
    console.error(error);
    setMessage(userMessage, "Could not load users. Is the backend running?", "error");
  }
}

async function refreshNotes(): Promise<void> {
  if (!currentUser) {
    notes = [];
    renderNotes();
    return;
  }

  try {
    notes = await listNotes(currentUser.id);
    renderNotes();
  } catch (error) {
    console.error(error);
    setMessage(noteMessage, "Could not load notes.", "error");
  }
}

async function refreshFeynmanEntries(): Promise<void> {
  if (!currentUser) {
    feynmanEntries = [];
    renderFeynmanEntries();
    return;
  }

  try {
    feynmanEntries = await listFeynmanEntries(currentUser.id);
    renderFeynmanEntries();
  } catch (error) {
    console.error(error);
    setMessage(feynmanMessage, "Could not load Feynman records.", "error");
  }
}

async function refreshTracker(): Promise<void> {
  if (!currentUser) {
    dailyState = null;
    renderTracker();
    return;
  }

  try {
    dailyState = await getDailyState(currentUser.id);
    renderTracker();
  } catch (error) {
    console.error(error);
    setMessage(trackerMessage, "Could not load daily tracker.", "error");
  }
}

async function refreshAll(): Promise<void> {
  await refreshUsers();
  await refreshNotes();
  await refreshFeynmanEntries();
  await refreshTracker();
}

featureTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const view = tab.dataset.view;

    if (view === "notes" || view === "feynman" || view === "tracker") {
      switchView(view);
    }
  });
});

userForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const username = usernameInput.value.trim();
  const language = languageSelect.value;
  const theme = themeSelect.value;

  if (!username) {
    setMessage(userMessage, "Username is required.", "error");
    return;
  }

  try {
    const user = await createUser({
      username,
      language,
      theme,
    });

    currentUser = user;
    storeCurrentUserId(user.id);
    setMessage(userMessage, `User created and selected: ${user.username}`, "success");
    userForm.reset();

    await refreshAll();
  } catch (error) {
    console.error(error);
    setMessage(userMessage, "Could not create user. The username may already exist.", "error");
  }
});

selectUserButton.addEventListener("click", async () => {
  const selectedUserId = Number(userSelect.value);
  const selectedUser = users.find((user) => user.id === selectedUserId);

  if (!selectedUser) {
    setMessage(userMessage, "No valid user selected.", "error");
    return;
  }

  currentUser = selectedUser;
  storeCurrentUserId(selectedUser.id);
  renderCurrentUser();
  clearNoteForm();
  clearFeynmanDraft();
  setMessage(userMessage, `Selected user: ${selectedUser.username}`, "success");

  await refreshNotes();
  await refreshFeynmanEntries();
  await refreshTracker();
});

noteForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!currentUser) {
    setMessage(noteMessage, "Select or create a user first.", "error");
    return;
  }

  const title = noteTitleInput.value.trim();

  if (!title) {
    setMessage(noteMessage, "Paper title is required.", "error");
    return;
  }

  const yearRaw = noteYearInput.value.trim();
  const year = yearRaw ? Number(yearRaw) : null;

  if (year !== null && !Number.isFinite(year)) {
    setMessage(noteMessage, "Year must be a valid number.", "error");
    return;
  }

  const payload = {
    title,
    authors: noteAuthorsInput.value.trim(),
    year,
    key_points: noteKeyPointsInput.value.trim(),
    questions: noteQuestionsInput.value.trim(),
    tags: noteTagsInput.value.trim(),
  };

  try {
    if (editedNoteId === null) {
      await createNote(currentUser.id, payload);
      setMessage(noteMessage, "Note created.", "success");
    } else {
      await updateNote(editedNoteId, payload);
      setMessage(noteMessage, "Note updated.", "success");
    }

    clearNoteForm();
    await refreshNotes();
  } catch (error) {
    console.error(error);
    setMessage(noteMessage, "Could not save note.", "error");
  }
});

noteCancelButton.addEventListener("click", () => {
  clearNoteForm();
  setMessage(noteMessage, "", "neutral");
});

refreshNotesButton.addEventListener("click", async () => {
  await refreshNotes();
});

notesList.addEventListener("click", async (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.action;
  const noteId = Number(target.dataset.id);

  if (!action || !Number.isFinite(noteId)) {
    return;
  }

  const note = notes.find((item) => item.id === noteId);

  if (!note) {
    return;
  }

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
    switchView("notes");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  if (action === "delete") {
    const confirmed = window.confirm(`Delete note "${note.title}"?`);

    if (!confirmed) {
      return;
    }

    try {
      await deleteNote(note.id);
      setMessage(noteMessage, "Note deleted.", "success");
      await refreshNotes();
    } catch (error) {
      console.error(error);
      setMessage(noteMessage, "Could not delete note.", "error");
    }
  }
});

feynmanInput.addEventListener("input", () => {
  feynmanDraft[feynmanStep] = feynmanInput.value;
});

feynmanPrevButton.addEventListener("click", () => {
  feynmanDraft[feynmanStep] = feynmanInput.value;

  if (feynmanStep > 0) {
    feynmanStep -= 1;
    renderFeynmanStep();
  }
});

feynmanNextButton.addEventListener("click", async () => {
  feynmanDraft[feynmanStep] = feynmanInput.value;

  if (feynmanStep < FEYNMAN_STEPS.length - 1) {
    feynmanStep += 1;
    renderFeynmanStep();
    return;
  }

  if (!currentUser) {
    setMessage(feynmanMessage, "Select or create a user first.", "error");
    return;
  }

  const concept = feynmanDraft[0].trim();

  if (!concept) {
    feynmanStep = 0;
    renderFeynmanStep();
    setMessage(feynmanMessage, "Concept is required.", "error");
    return;
  }

  const payload = {
    concept,
    explanation: feynmanDraft[1].trim(),
    gaps: feynmanDraft[2].trim(),
    analogy: feynmanDraft[3].trim(),
  };

  try {
    if (editedFeynmanId === null) {
      await createFeynmanEntry(currentUser.id, payload);
      setMessage(feynmanMessage, "Feynman record created.", "success");
    } else {
      await updateFeynmanEntry(editedFeynmanId, payload);
      setMessage(feynmanMessage, "Feynman record updated.", "success");
    }

    clearFeynmanDraft();
    await refreshFeynmanEntries();
  } catch (error) {
    console.error(error);
    setMessage(feynmanMessage, "Could not save Feynman record.", "error");
  }
});

feynmanResetButton.addEventListener("click", () => {
  clearFeynmanDraft();
});

refreshFeynmanButton.addEventListener("click", async () => {
  await refreshFeynmanEntries();
});

feynmanList.addEventListener("click", async (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.feynmanAction;
  const entryId = Number(target.dataset.id);

  if (!action || !Number.isFinite(entryId)) {
    return;
  }

  const entry = feynmanEntries.find((item) => item.id === entryId);

  if (!entry) {
    return;
  }

  if (action === "edit") {
    editedFeynmanId = entry.id;
    feynmanStep = 0;
    feynmanDraft = [
      entry.concept,
      entry.explanation,
      entry.gaps,
      entry.analogy,
    ];

    switchView("feynman");
    renderFeynmanStep();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  if (action === "delete") {
    const confirmed = window.confirm(`Delete Feynman record "${entry.concept}"?`);

    if (!confirmed) {
      return;
    }

    try {
      await deleteFeynmanEntry(entry.id);
      setMessage(feynmanMessage, "Feynman record deleted.", "success");
      await refreshFeynmanEntries();
    } catch (error) {
      console.error(error);
      setMessage(feynmanMessage, "Could not delete Feynman record.", "error");
    }
  }
});

refreshTrackerButton.addEventListener("click", async () => {
  await refreshTracker();
});

taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!currentUser) {
    setMessage(trackerMessage, "Select or create a user first.", "error");
    return;
  }

  const text = taskInput.value.trim();

  if (!text) {
    setMessage(trackerMessage, "Task text is required.", "error");
    return;
  }

  try {
    await createDailyTask(currentUser.id, {
      text,
    });
    taskInput.value = "";
    setMessage(trackerMessage, "Task created.", "success");
    await refreshTracker();
  } catch (error) {
    console.error(error);
    setMessage(trackerMessage, "Could not create task.", "error");
  }
});

taskList.addEventListener("click", async (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.taskAction;
  const taskId = Number(target.dataset.id);

  if (!action || !Number.isFinite(taskId) || !dailyState) {
    return;
  }

  const task = dailyState.tasks.find((item) => item.id === taskId);

  if (!task) {
    return;
  }

  try {
    if (action === "toggle") {
      await updateDailyTask(task.id, {
        is_done: !task.is_done,
      });
      await refreshTracker();
      return;
    }

    if (action === "delete") {
      await deleteDailyTask(task.id);
      setMessage(trackerMessage, "Task deleted.", "success");
      await refreshTracker();
    }
  } catch (error) {
    console.error(error);
    setMessage(trackerMessage, "Could not update task.", "error");
  }
});

moodRow.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const mood = target.dataset.mood;

  if (!mood) {
    return;
  }

  selectedMood = mood;

  moodRow.querySelectorAll(".mood-button").forEach((button) => {
    button.classList.toggle("active", button instanceof HTMLElement && button.dataset.mood === mood);
  });
});

saveLogButton.addEventListener("click", async () => {
  if (!currentUser) {
    setMessage(trackerMessage, "Select or create a user first.", "error");
    return;
  }

  try {
    await saveDailyLog(currentUser.id, {
      mood: selectedMood,
      reflection: reflectionInput.value.trim(),
    });

    setMessage(trackerMessage, "Daily log saved.", "success");
    await refreshTracker();
  } catch (error) {
    console.error(error);
    setMessage(trackerMessage, "Could not save daily log.", "error");
  }
});

switchView(currentView);
renderFeynmanStep();
void refreshAll();