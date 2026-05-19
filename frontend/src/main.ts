/**
 * Application entry point.
 */

import "./style.css";
import { ApiError, UnauthorizedError } from "./api/client";
import { getMe, logout, type UserRead } from "./api/users";
import { applyTheme } from "./theme";
import { showAuthScreen } from "./views/auth";
import * as FeynmanView from "./views/feynman";
import * as MoodView from "./views/mood";
import * as NotesView from "./views/notes";
import * as PomodoroView from "./views/pomodoro";
import * as StatsView from "./views/stats";
import * as FriendsView from "./views/friends";
import * as TrackerView from "./views/tracker";

type AppView = "notes" | "feynman" | "tracker" | "pomodoro" | "stats" | "mood" | "friends";

const APP_HTML = `
  <div class="app-shell">
    <header class="topbar">
      <div>
        <h1>Nine Lives Study</h1>
      </div>
      <div class="topbar-right">
        <button id="theme-toggle-button" class="theme-toggle" title="Toggle theme">☀️</button>
        <div class="current-user" id="current-user-label">—</div>
        <button id="logout-button" class="secondary" title="Log out">Log out</button>
      </div>
    </header>

    <main class="layout">
      <aside class="sidebar">
        <section class="card" id="xp-card">
          <h2>Level <span id="xp-level">1</span></h2>
          <div class="xp-bar-wrap"><div class="xp-bar-fill" id="xp-bar-fill"></div></div>
          <p class="hint" id="xp-label">0 / 100 XP</p>
        </section>
      </aside>

      <section class="content">
        <nav class="feature-tabs">
          <button class="feature-tab active" data-view="notes">Paper notes</button>
          <button class="feature-tab" data-view="feynman">Feynman</button>
          <button class="feature-tab" data-view="tracker">Daily tracker</button>
          <button class="feature-tab" data-view="pomodoro">Pomodoro</button>
          <button class="feature-tab" data-view="mood">Mood</button>
          <button class="feature-tab" data-view="stats">Stats</button>
          <button class="feature-tab" data-view="friends">Friends</button>
        </nav>

        <div id="notes-view">
          <section class="card">
            <h2>Paper notes</h2>
            <p class="hint">Literature notes.</p>
            <form id="note-form" class="note-form">
              <label>Paper title *<input id="note-title" type="text" placeholder="Enter paper title..." required /></label>
              <div class="two-cols">
                <label>Authors<input id="note-authors" type="text" placeholder="Author A, Author B..." /></label>
                <label>Year<input id="note-year" type="number" placeholder="2026" /></label>
              </div>
              <label>Key ideas &amp; method<textarea id="note-key-points" placeholder="Main idea, method, assumptions..."></textarea></label>
              <label>Questions &amp; thoughts<textarea id="note-questions" placeholder="Open questions, limitations, links with your work..."></textarea></label>
              <label>Tags<input id="note-tags" type="text" placeholder="key-words" /></label>
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
              <div>
                <h2>Pomodoro</h2>
                <p class="hint" id="pomodoro-mode-hint">25 min work · 5 min short break · 15 min long break every 4</p>
              </div>
              <div class="pomodoro-header-actions">
                <span id="pomodoro-mode-badge" class="tag">Work</span>
                <button id="pomodoro-settings-toggle" class="secondary" type="button" title="Pomodoro settings">⚙️</button>
              </div>
            </div>

            <div id="pomodoro-settings-panel" class="settings-panel hidden">
              <form id="pomodoro-settings-form" class="form">
                <div class="settings-grid">
                  <label>Work (min)
                    <input id="pomodoro-setting-work" type="number" min="1" max="240" required />
                  </label>
                  <label>Short break (min)
                    <input id="pomodoro-setting-short" type="number" min="1" max="60" required />
                  </label>
                  <label>Long break (min)
                    <input id="pomodoro-setting-long" type="number" min="1" max="60" required />
                  </label>
                  <label>Sessions before long break
                    <input id="pomodoro-setting-before-long" type="number" min="1" max="10" required />
                  </label>
                </div>
                <label class="checkbox-row">
                  <input id="pomodoro-setting-auto-start" type="checkbox" />
                  <span>Auto-start next session (skip clicking Start between phases)</span>
                </label>
                <div class="button-row"><button type="submit">Save settings</button></div>
                <p id="pomodoro-settings-message" class="message"></p>
              </form>
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

        <div id="friends-view" class="hidden">
          <section class="card">
            <h2>Find friends</h2>
            <div class="friend-search-row">
              <input id="friend-search-input" type="text" placeholder="Search by username…" />
              <button id="friend-search-button">Search</button>
            </div>
            <p id="friend-search-message" class="message"></p>
            <div id="friend-search-results"></div>
          </section>
          <section class="card">
            <h2>Friend requests</h2>
            <div id="friend-requests-list"></div>
          </section>
          <section class="card">
            <h2>My friends</h2>
            <div id="friends-list"></div>
          </section>
          <section class="card hidden" id="friend-stats-panel">
          </section>
        </div>

      </section>
    </main>
  </div>
`;

let currentUser: UserRead | null = null;
let currentView: AppView = "notes";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Could not find #app root element.");

function updateThemeButton(button: HTMLButtonElement, theme: string): void {
  button.textContent = theme === "dark" ? "☀️" : "🌙";
  button.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

function switchView(views: Record<AppView, HTMLElement>, view: AppView): void {
  currentView = view;
  Object.entries(views).forEach(([key, el]) => el.classList.toggle("hidden", key !== view));
  document.querySelectorAll<HTMLButtonElement>(".feature-tab").forEach((tab) =>
    tab.classList.toggle("active", tab.dataset.view === view),
  );
}

async function refreshAll(): Promise<void> {
  try {
    await Promise.all([
      NotesView.refresh(),
      FeynmanView.refresh(),
      TrackerView.refresh(),
      PomodoroView.refresh(),
      MoodView.refresh(),
      StatsView.refresh(),
      FriendsView.refresh(),
    ]);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      await handleSignedOut();
    } else {
      console.error(error);
    }
  }
}

async function handleSignedOut(): Promise<void> {
  currentUser = null;
  await bootstrap();
}

function mountApp(user: UserRead): void {
  app!.innerHTML = APP_HTML;
  applyTheme(user.theme);

  const themeToggle = app!.querySelector<HTMLButtonElement>("#theme-toggle-button")!;
  const userLabel = app!.querySelector<HTMLDivElement>("#current-user-label")!;
  const logoutBtn = app!.querySelector<HTMLButtonElement>("#logout-button")!;

  userLabel.textContent = user.username;
  updateThemeButton(themeToggle, user.theme);

  themeToggle.addEventListener("click", () => {
    const isDark = !document.body.classList.contains("theme-light");
    const next = isDark ? "light" : "dark";
    applyTheme(next);
    updateThemeButton(themeToggle, next);
  });

  logoutBtn.addEventListener("click", async () => {
    try { await logout(); } catch (error) { console.error(error); }
    await handleSignedOut();
  });

  const views: Record<AppView, HTMLElement> = {
    notes:    app!.querySelector<HTMLDivElement>("#notes-view")!,
    feynman:  app!.querySelector<HTMLDivElement>("#feynman-view")!,
    tracker:  app!.querySelector<HTMLDivElement>("#tracker-view")!,
    pomodoro: app!.querySelector<HTMLDivElement>("#pomodoro-view")!,
    mood:     app!.querySelector<HTMLDivElement>("#mood-view")!,
    stats:    app!.querySelector<HTMLDivElement>("#stats-view")!,
    friends:  app!.querySelector<HTMLDivElement>("#friends-view")!,
  };

  // Init each view module
  NotesView.init(
    async () => { await NotesView.refresh(); await StatsView.refresh(); },
    (v) => switchView(views, v as AppView),
  );
  FeynmanView.init(
    async () => { await FeynmanView.refresh(); await StatsView.refresh(); },
    (v) => switchView(views, v as AppView),
  );
  TrackerView.init(() => Promise.all([TrackerView.refresh(), StatsView.refresh()]).then());
  PomodoroView.init(() => Promise.all([PomodoroView.refresh(), StatsView.refresh()]).then());
  PomodoroView.setUser(user);  // pass settings (work/break durations etc.) to the timer
  MoodView.init(() => Promise.all([MoodView.refresh(), StatsView.refresh()]).then());
  StatsView.init(() => StatsView.refresh());
  FriendsView.init(() => FriendsView.refresh());

  document.querySelectorAll<HTMLButtonElement>(".feature-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.view as AppView;
      if (view in views) switchView(views, view);
    });
  });

  FeynmanView.renderInitial();
  switchView(views, currentView);
  void refreshAll();
}

async function bootstrap(): Promise<void> {
  applyTheme("dark");
  try {
    currentUser = await getMe();
  } catch (error) {
    if (!(error instanceof UnauthorizedError) && !(error instanceof ApiError)) {
      console.error("Unexpected error in bootstrap:", error);
    }
    currentUser = null;
  }

  if (currentUser) {
    mountApp(currentUser);
  } else {
    const user = await showAuthScreen(app!);
    currentUser = user;
    mountApp(user);
  }
}

void bootstrap();
