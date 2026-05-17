/**
 * Application entry point.
 */

import "./style.css";
import * as UsersView from "./views/users";
import * as NotesView from "./views/notes";
import * as FeynmanView from "./views/feynman";
import * as TrackerView from "./views/tracker";
import * as PomodoroView from "./views/pomodoro";
import * as MoodView from "./views/mood";
import * as StatsView from "./views/stats";

type AppView = "notes" | "feynman" | "tracker" | "pomodoro" | "stats" | "mood";

let currentView: AppView = "notes";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Could not find #app root element.");

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div>
        <h1>PhDStudyLab</h1>
      </div>
      <div class="topbar-right">
        <button id="theme-toggle-button" class="theme-toggle" title="Toggle theme">☀️</button>
        <div class="current-user" id="current-user-label">No user selected</div>
      </div>
    </header>

    <main class="layout">
      <aside class="sidebar">
        <section class="card">
          <h2>Local user</h2>
          <label>Existing user<select id="user-select"></select></label>
          <div class="button-row">
            <button id="select-user-button">Use this user</button>
            <button type="button" id="new-user-toggle" class="secondary">+ New user</button>
          </div>
          <form id="user-form" class="form hidden">
            <div class="divider"></div>
            <label>New username<input id="username" type="text" placeholder="e.g. dorian" /></label>
            <label>Language
              <select id="language">
                <option value="fr">Français</option>
                <option value="en">English</option>
                <option value="zh">中文</option>
              </select>
            </label>
            <button type="submit">Create and use user</button>
          </form>
          <p id="user-message" class="message"></p>
        </section>

        <section class="card" id="xp-card">
          <h2>Level <span id="xp-level">1</span></h2>
          <div class="xp-bar-wrap"><div class="xp-bar-fill" id="xp-bar-fill"></div></div>
          <p class="hint" id="xp-label">0 / 100 XP</p>
        </section>

        <section class="card" style="display:none">
          <h2>Roadmap</h2>
          <ol class="roadmap">
            <li class="done">Users</li>
            <li class="done">Paper notes</li>
            <li class="done">Feynman</li>
            <li class="done">Daily tracker</li>
            <li class="done">Pomodoro</li>
            <li class="done">Stats</li>
            <li class="done">Gamification</li>
            <li class="done">Mood journal</li>
          </ol>
        </section>
      </aside>

      <section class="content">
        <nav class="feature-tabs">
          <button class="feature-tab active" data-view="notes">Paper notes</button>
          <button class="feature-tab" data-view="feynman">Feynman</button>
          <button class="feature-tab" data-view="tracker">Daily tracker</button>
          <button class="feature-tab" data-view="pomodoro">Pomodoro</button>
          <button class="feature-tab" data-view="stats">Stats</button>
          <button class="feature-tab" data-view="mood">Mood</button>
        </nav>

        <div id="notes-view">
          <section class="card">
            <h2>Paper notes</h2>
            <p class="hint">Literature notes migrated from the original monolithic HTML application.</p>
            <form id="note-form" class="note-form">
              <label>Paper title *<input id="note-title" type="text" placeholder="Enter paper title..." required /></label>
              <div class="two-cols">
                <label>Authors<input id="note-authors" type="text" placeholder="Author A, Author B..." /></label>
                <label>Year<input id="note-year" type="number" placeholder="2026" /></label>
              </div>
              <label>Key ideas &amp; method<textarea id="note-key-points" placeholder="Main idea, method, assumptions..."></textarea></label>
              <label>Questions &amp; thoughts<textarea id="note-questions" placeholder="Open questions, limitations, links with your work..."></textarea></label>
              <label>Tags<input id="note-tags" type="text" placeholder="fusion, ray tracing, heat loads" /></label>
              <div class="button-row">
                <button type="submit" id="note-submit-button">Add note</button>
                <button type="button" id="note-cancel-button" class="secondary hidden">Cancel edit</button>
              </div>
            </form>
            <p id="note-message" class="message"></p>
          </section>
          <section class="card">
            <h2>Saved notes</h2>
            <div id="notes-list" class="notes-list"></div>
          </section>
        </div>

        <div id="feynman-view" class="hidden">
          <section class="card">
            <h2>Feynman method</h2>
            <p class="hint">Build a compact understanding record in four steps.</p>
            <div class="steps-bar" id="feynman-steps"></div>
            <div class="feynman-editor">
              <h3 id="feynman-step-title"></h3>
              <p id="feynman-step-description" class="hint"></p>
              <label><span id="feynman-field-label"></span><textarea id="feynman-input"></textarea></label>
              <div class="button-row">
                <button type="button" id="feynman-prev-button" class="secondary">Previous</button>
                <button type="button" id="feynman-next-button">Next</button>
                <button type="button" id="feynman-reset-button" class="secondary">Reset</button>
              </div>
              <p id="feynman-message" class="message"></p>
            </div>
          </section>
          <section class="card">
            <h2>Feynman records</h2>
            <div id="feynman-list" class="feynman-list"></div>
          </section>
        </div>

        <div id="tracker-view" class="hidden">
          <section class="card">
            <div>
              <h2>Daily tracker</h2>
              <p class="hint">Tasks, mood and daily reflection.</p>
            </div>
            <div class="tracker-progress">
              <div class="progress-header"><span>Today progress</span><strong id="tracker-percent">0%</strong></div>
              <div class="progress-bar"><div id="tracker-progress-fill" class="progress-fill"></div></div>
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
            <label>Daily reflection<textarea id="reflection-input" placeholder="What did you do, learn, unblock or struggle with today?"></textarea></label>
            <div class="button-row"><button id="save-log-button" type="button">Save daily log</button></div>
            <p id="tracker-message" class="message"></p>
          </section>
        </div>

        <div id="pomodoro-view" class="hidden">
          <section class="card">
            <div class="section-header">
              <div><h2>Pomodoro</h2><p class="hint">25 min work · 5 min break</p></div>
              <span id="pomodoro-mode-badge" class="tag">Work</span>
            </div>
            <div class="pomodoro-timer">
              <div id="pomodoro-display" class="pomodoro-display">25:00</div>
              <div class="button-row">
                <button id="pomodoro-start-button">Start</button>
                <button id="pomodoro-reset-button" class="secondary">Reset</button>
              </div>
              <p id="pomodoro-message" class="message"></p>
            </div>
          </section>
          <section class="card">
            <h2>Today's sessions</h2>
            <div id="pomodoro-list" class="task-list"></div>
          </section>
        </div>

        <div id="stats-view" class="hidden">
          <section class="card">
            <div class="section-header">
              <h2>Overview</h2>
              <div class="days-selector">
                <button class="days-btn active" data-days="7">7 days</button>
                <button class="days-btn" data-days="30">30 days</button>
                <button class="days-btn" data-days="90">90 days</button>
              </div>
            </div>
            <div id="stats-totals" class="stats-grid"></div>
          </section>
          <section class="card">
            <h2 id="stats-tasks-title">Last 7 days — tasks</h2>
            <div id="stats-tasks-chart" class="stats-chart"></div>
          </section>
          <section class="card">
            <h2 id="stats-pomodoro-title">Last 7 days — Pomodoro sessions</h2>
            <div id="stats-pomodoro-chart" class="stats-chart"></div>
          </section>
          <section class="card">
            <h2 id="stats-mood-title">Last 7 days — mood</h2>
            <div id="stats-mood-chart" class="mood-history"></div>
          </section>
        </div>
        <div id="mood-view" class="hidden">
          <section class="card">
            <h2>How are you feeling?</h2>
            <p class="hint">Record your mood at any time — multiple entries per day are fine.</p>
            <div id="mood-picker" class="mood-row"></div>
            <label>Reflection (optional)<textarea id="mood-reflection-input" placeholder="What's on your mind? What happened today?"></textarea></label>
            <div class="button-row"><button id="save-mood-button">Record mood</button></div>
            <p id="mood-message" class="message"></p>
          </section>
          <section class="card">
            <div class="section-header">
              <h2>Mood history</h2>
              <div class="days-selector" id="mood-days-selector">
                <button class="days-btn active" data-days="7">7 days</button>
                <button class="days-btn" data-days="30">30 days</button>
                <button class="days-btn" data-days="90">90 days</button>
              </div>
            </div>
            <div id="mood-list" class="mood-history-list"></div>
          </section>
        </div>

      </section>
    </main>
  </div>
`;

const views: Record<AppView, HTMLElement> = {
  notes: document.querySelector<HTMLDivElement>("#notes-view")!,
  feynman: document.querySelector<HTMLDivElement>("#feynman-view")!,
  tracker: document.querySelector<HTMLDivElement>("#tracker-view")!,
  pomodoro: document.querySelector<HTMLDivElement>("#pomodoro-view")!,
  stats: document.querySelector<HTMLDivElement>("#stats-view")!,
  mood: document.querySelector<HTMLDivElement>("#mood-view")!,
};

const featureTabs = document.querySelectorAll<HTMLButtonElement>(".feature-tab");

function switchView(view: AppView): void {
  currentView = view;
  Object.entries(views).forEach(([key, el]) => el.classList.toggle("hidden", key !== view));
  featureTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
}

async function refreshAll(): Promise<void> {
  const user = UsersView.getCurrentUser();
  await Promise.all([
    NotesView.refresh(user),
    FeynmanView.refresh(user),
    TrackerView.refresh(user),
    PomodoroView.refresh(user),
    MoodView.refresh(user),
    StatsView.refresh(user),
  ]);
}

async function onUserChanged(): Promise<void> {
  await refreshAll();
}

// Init all view modules
UsersView.init(onUserChanged);
NotesView.init(
  async () => { await NotesView.refresh(UsersView.getCurrentUser()); await StatsView.refresh(UsersView.getCurrentUser()); },
  (v) => switchView(v as AppView),
);
FeynmanView.init(
  async () => { await FeynmanView.refresh(UsersView.getCurrentUser()); await StatsView.refresh(UsersView.getCurrentUser()); },
  (v) => switchView(v as AppView),
);
TrackerView.init(() => Promise.all([TrackerView.refresh(UsersView.getCurrentUser()), StatsView.refresh(UsersView.getCurrentUser())]).then());
PomodoroView.init(() => Promise.all([PomodoroView.refresh(UsersView.getCurrentUser()), StatsView.refresh(UsersView.getCurrentUser())]).then());
MoodView.init(() => Promise.all([MoodView.refresh(UsersView.getCurrentUser()), StatsView.refresh(UsersView.getCurrentUser())]).then());
StatsView.init(() => StatsView.refresh(UsersView.getCurrentUser()));

featureTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const view = tab.dataset.view as AppView;
    if (view in views) switchView(view);
  });
});

// Boot
FeynmanView.renderInitial();
switchView(currentView);
void UsersView.refresh().then(() => refreshAll());
