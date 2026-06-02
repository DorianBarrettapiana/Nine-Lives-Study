/**
 * Application entry point.
 */

import "./style.css";
import { ApiError, UnauthorizedError } from "./api/client";
import { installErrorBoundary, withFallback } from "./errorBoundary";
import { fmtMinutes } from "./utils";
import { getMe, logout, updateMe, type UserRead } from "./api/users";
import { applyTheme } from "./theme";
import { CAT_SKINS, renderAvatarSvg } from "./views/avatar";
import { renderMoonIconSvg, renderSunIconSvg } from "./views/icons";
import { setCurrentCatSkin } from "./views/user-state";
import { showAuthScreen } from "./views/auth";
import * as FeynmanView from "./views/feynman";
import * as MilestonesView from "./views/milestones";
import * as SummariesView from "./views/summaries";
import * as NotesView from "./views/notes";
import * as PomodoroView from "./views/pomodoro";
import * as ProjectsView from "./views/projects";
import { refreshProjects } from "./views/project-state";
import * as StatsView from "./views/stats";
import * as StopwatchView from "./views/stopwatch";
import * as TimerMode from "./views/timerMode";
import * as FriendsView from "./views/friends";
import * as TodayView from "./views/today";
import { initReadingInsightPrompts } from "./views/reading-insight";

type AppView = "today" | "notes" | "feynman" | "stats" | "projects" | "friends";

const APP_HTML = `
  <div class="app-shell">
    <header class="topbar">
      <div>
        <h1>Nine Lives Study</h1>
      </div>
      <div class="topbar-right">
        <button id="theme-toggle-button" class="theme-toggle" title="Toggle theme"></button>
        <div class="current-user" id="current-user-label">
          <span class="avatar avatar-sm" id="topbar-avatar"></span>
          <span id="topbar-username">—</span>
        </div>
        <button id="logout-button" class="secondary" title="Log out">Log out</button>
      </div>
    </header>

    <main class="layout">
      <aside class="sidebar">
        <section class="card profile-card" id="profile-card">
          <div class="avatar avatar-lg" id="profile-avatar"></div>
          <div class="profile-name" id="profile-username">—</div>
          <button id="avatar-picker-toggle" class="link-btn" type="button">Change cat</button>
          <div id="avatar-picker" class="avatar-picker hidden"></div>
          <p id="avatar-picker-message" class="message"></p>
        </section>
        <section class="card" id="xp-card">
          <h2>Level <span id="xp-level">1</span></h2>
          <div class="xp-bar-wrap"><div class="xp-bar-fill" id="xp-bar-fill"></div></div>
          <p class="hint" id="xp-label">0 / 100 XP</p>
          <p class="hint streak-line" id="streak-line" title="Consecutive days with at least one work session"></p>
          <div class="daily-goal-line" id="daily-goal-line"
               title="Today's work-time goal (pomodoro + stopwatch). Click to edit."></div>
          <p id="perfect-day-badge" class="perfect-day-badge hidden">✨ Perfect day!</p>
        </section>
        <section class="card stopwatch-card timer-card" id="timer-card">
          <div class="timer-card-header">
            <h2>Work timer</h2>
            <div class="timer-mode-toggle" role="tablist">
              <button type="button" class="timer-mode-btn active" data-timer-mode="pomodoro" role="tab">🍅 Pomodoro</button>
              <button type="button" class="timer-mode-btn" data-timer-mode="free" role="tab">⏱ Free</button>
            </div>
          </div>

          <div id="stopwatch-clock" class="stopwatch-clock"></div>

          <!-- Pomodoro mode panel -->
          <div id="timer-panel-pomodoro" class="timer-mode-panel">
            <div class="pomodoro-header-row">
              <span id="pomodoro-mode-badge" class="tag">Work</span>
              <button id="pomodoro-settings-toggle" class="link-btn" type="button" title="Pomodoro settings">⚙️</button>
            </div>
            <div id="pomodoro-display" class="pomodoro-display">25:00</div>
            <div id="pomodoro-task-picker" class="pomodoro-task-picker"></div>
            <div class="button-row">
              <button id="pomodoro-start-button" type="button">▶ Start</button>
              <button id="pomodoro-reset-button" class="secondary" type="button">Reset</button>
            </div>
            <p id="pomodoro-message" class="message"></p>
            <p class="hint pomodoro-mode-hint" id="pomodoro-mode-hint">25 min work · 5 min short break · 15 min long break every 4</p>

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
                  <span>Auto-start next session</span>
                </label>
                <div class="button-row"><button type="submit">Save settings</button></div>
                <p id="pomodoro-settings-message" class="message"></p>
              </form>
            </div>
          </div>

          <!-- Free mode panel -->
          <div id="timer-panel-free" class="timer-mode-panel hidden">
            <div id="stopwatch-display" class="stopwatch-display">00:00:00</div>
            <div id="stopwatch-task-picker" class="stopwatch-task-picker"></div>
            <div class="button-row stopwatch-buttons">
              <button id="stopwatch-start-btn" type="button">▶ Start</button>
              <button id="stopwatch-end-btn" type="button" class="secondary">End</button>
            </div>
            <p id="stopwatch-message" class="message"></p>
          </div>

          <p id="stopwatch-today" class="hint stopwatch-today">Today: —</p>

          <details class="timer-sessions-details">
            <summary>Today's pomodoros</summary>
            <div id="pomodoro-list" class="task-list timer-sessions-list"></div>
          </details>
        </section>
        <section class="card milestones-card" id="milestones-card">
          <div class="section-header">
            <h2>🗓 Upcoming</h2>
            <button id="milestones-toggle-add" class="link-btn" type="button"
                    title="Add a milestone">+ Add</button>
          </div>
          <form id="milestones-add-form" class="milestones-add-form hidden">
            <input id="milestones-add-title" type="text" maxlength="200" placeholder="Title (e.g. NeurIPS abstract)" required />
            <input id="milestones-add-date" type="date" required />
            <div id="milestones-add-project-picker" class="milestones-add-project"></div>
            <div class="button-row">
              <button type="submit">Save</button>
              <button type="button" class="secondary" id="milestones-add-cancel">Cancel</button>
            </div>
            <p id="milestones-add-message" class="message"></p>
          </form>
          <div id="milestones-list" class="milestones-list"></div>
          <button id="milestones-show-more" class="link-btn hidden" type="button"></button>
          <details id="milestones-past-details" class="milestones-past hidden">
            <summary>Past / archived</summary>
            <div id="milestones-past-list" class="milestones-list"></div>
          </details>
        </section>
      </aside>

      <section class="content">
        <nav class="feature-tabs">
          <button class="feature-tab active" data-view="today">Today</button>
          <button class="feature-tab" data-view="notes">Paper notes</button>
          <button class="feature-tab" data-view="feynman">Feynman</button>
          <button class="feature-tab" data-view="projects">Projects</button>
          <button class="feature-tab" data-view="stats">Stats</button>
          <button class="feature-tab" data-view="friends">Friends</button>
        </nav>

        <div id="today-view">
          <section class="card today-card">
            <div class="today-header-row">
              <div id="today-date-bar" class="today-date-bar"></div>
              <div class="today-filter-row">
                <span class="today-filter-label">Filter:</span>
                <div id="today-project-filter" class="today-project-filter"></div>
              </div>
            </div>
            <p id="today-message" class="message"></p>
          </section>

          <section class="card today-yesterday-card hidden" id="today-yesterday-card">
            <div class="section-header">
              <h2>↩️ Yesterday in review</h2>
              <button id="today-yesterday-carry-all" class="link-btn hidden" type="button"
                      title="Bring every unfinished task into today">Bring all to today</button>
            </div>
            <div id="today-yesterday-body"></div>
          </section>

          <section class="card today-hero">
            <p class="eyebrow">🎯 Main goal</p>
            <div id="today-main-goal-picker"></div>
          </section>

          <section class="card">
            <div class="section-header">
              <h2>Tasks</h2>
              <strong id="today-progress-label">0 / 0</strong>
            </div>
            <div class="progress-bar"><div id="today-progress-fill" class="progress-fill"></div></div>
            <p id="today-project-breakdown" class="hint today-project-breakdown"></p>
            <div id="today-task-list" class="task-list"></div>
            <form id="today-task-form" class="task-form">
              <input id="today-task-input" type="text" placeholder="Add a task for this day..." />
              <input id="today-task-due" type="date" title="Optional deadline" />
              <div id="today-task-project-picker" class="task-project-picker"></div>
              <button type="submit">Add task</button>
            </form>
          </section>

          <section class="card" id="today-upcoming-card">
            <h2>Up next</h2>
            <div id="today-upcoming-list" class="upcoming-list"></div>
          </section>

          <section class="card today-mood-card">
            <div class="section-header">
              <h2>😊 Mood</h2>
              <button id="today-mood-history-link" class="link-btn" type="button"
                      title="Open Stats to see 30-day history">📈 History</button>
            </div>
            <div id="today-mood-row" class="mood-row"></div>
            <textarea id="today-mood-reflection" class="today-mood-reflection"
                      placeholder="What's behind this? (optional)"></textarea>
            <div class="button-row">
              <button id="today-mood-save" type="button">Record mood</button>
            </div>
            <p id="today-mood-message" class="message"></p>
            <div id="today-mood-list" class="today-mood-list"></div>
          </section>

          <section class="card">
            <h2>Reflection</h2>
            <textarea id="today-reflection" placeholder="What moved forward? What should tomorrow inherit?"></textarea>
            <div class="button-row"><button id="today-save-reflection" type="button">Save reflection</button></div>
          </section>
        </div>

        <div id="notes-view" class="hidden">
          <section class="card">
            <div class="card-header-row">
              <h2>Paper notes</h2>
              <div class="card-header-actions">
                <button type="button" id="zotero-import-button" class="secondary hidden">📚 Import from Zotero</button>
                <button type="button" id="zotero-settings-button" class="link-btn">Zotero settings</button>
              </div>
            </div>
            <p class="hint">Literature notes. Connect Zotero to pull in references in one click.</p>
            <form id="note-form" class="note-form">
              <label>Paper title *<input id="note-title" type="text" placeholder="Enter paper title..." required /></label>
              <div class="two-cols">
                <label>Authors<input id="note-authors" type="text" placeholder="Author A, Author B..." /></label>
                <label>Year<input id="note-year" type="number" placeholder="2026" /></label>
              </div>
              <label>Key ideas &amp; method<textarea id="note-key-points" placeholder="Main idea, method, assumptions..."></textarea></label>
              <label>Questions &amp; thoughts<textarea id="note-questions" placeholder="Open questions, limitations, links with your work..."></textarea></label>
              <label>Tags<input id="note-tags" type="text" placeholder="key-words" /></label>
              <details class="note-extras">
                <summary>More fields (URL, DOI, abstract)</summary>
                <label>URL<input id="note-url" type="url" placeholder="https://..." /></label>
                <label>DOI<input id="note-doi" type="text" placeholder="10.xxxx/..." /></label>
                <label>Abstract<textarea id="note-abstract" placeholder="Paper abstract..."></textarea></label>
              </details>
              <label>Reading status
                <select id="note-reading-status">
                  <option value="inbox">Inbox</option>
                  <option value="reading">Reading</option>
                  <option value="summarized">Summarized</option>
                  <option value="revisit">Revisit</option>
                </select>
              </label>
              <label>Linked Feynman record<select id="note-feynman-link"><option value="">None</option></select></label>
              <div id="note-project-picker" class="note-project-picker"></div>
              <div class="button-row">
                <button type="submit" id="note-submit-button">Add note</button>
                <button type="button" id="note-cancel-button" class="secondary hidden">Cancel edit</button>
              </div>
            </form>
            <p id="note-message" class="message"></p>
          </section>
          <section class="card">
            <h2>Saved notes</h2>
            <div class="two-cols">
              <input id="note-search" type="search" placeholder="Search title, author, DOI, text..." />
              <input id="note-tag-filter" type="search" placeholder="Filter tags..." />
            </div>
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
              <div id="feynman-source-note" class="feynman-source-note hidden"></div>
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


        <div id="stats-view" class="hidden">
          <section class="card hidden" id="ai-summary-card">
            <div class="section-header">
              <h2>AI research recap</h2>
              <div class="button-row">
                <button id="ai-summary-generate" type="button">Generate weekly</button>
                <button id="ai-summary-monthly" class="secondary" type="button">Monthly</button>
                <button id="ai-summary-stage" class="secondary" type="button">90-day stage</button>
              </div>
            </div>
            <p class="hint" id="ai-summary-hint">Synthesizes focus time, papers touched, open Feynman gaps, mood, and reflections into an advisor-ready narrative.</p>
            <p class="message" id="ai-summary-message"></p>
            <div id="ai-summary-content" class="ai-summary-markdown"></div>
            <p class="hint" id="ai-summary-meta"></p>
          </section>
          <section class="card hidden" id="weekly-summary-card">
            <h2>Weekly summary</h2>
            <p class="hint">Last 7 days vs the 7 days before that.</p>
            <div id="weekly-summary-grid" class="stats-grid"></div>
          </section>
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
            <h2 id="stats-pomodoro-title">Last 7 days — work time</h2>
            <div id="stats-pomodoro-chart" class="stats-chart"></div>
          </section>
          <section class="card">
            <h2>Work by focus</h2>
            <div id="stats-focus-chart" class="stats-chart"></div>
          </section>
          <section class="card">
            <h2>Time per project</h2>
            <p class="hint">Aggregated from work sessions whose linked task belongs to a project. Sessions without a project sit in "(no project)".</p>
            <div id="stats-project-chart" class="stats-chart"></div>
          </section>
          <section class="card">
            <h2 id="stats-mood-title">Last 7 days — mood</h2>
            <div id="stats-mood-chart" class="mood-history"></div>
          </section>
          <section class="card">
            <h2 id="stats-mood-list-title">Mood entries — last 7 days</h2>
            <p id="stats-mood-list-message" class="message"></p>
            <div id="stats-mood-list" class="mood-history-list"></div>
          </section>
        </div>
        <div id="projects-view" class="hidden">
          <div id="project-dashboard-container" class="hidden"></div>
          <div id="projects-list-container">
          <section class="card">
            <h2>Projects / research threads</h2>
            <p class="hint">Group related daily tasks, paper notes, and Feynman entries under a named project. Work sessions inherit their project from the linked task.</p>
            <form id="project-form" class="form">
              <div class="two-cols">
                <label>Name <input id="project-name-input" type="text" maxlength="100" placeholder="e.g. DiffusionPolicy" /></label>
                <label>Color <input id="project-color-input" type="color" value="#6366f1" /></label>
              </div>
              <div class="button-row"><button type="submit">Add project</button></div>
              <p id="project-message" class="message"></p>
            </form>
          </section>
          <section class="card">
            <h2>Your projects</h2>
            <div id="projects-list" class="projects-list"></div>
          </section>
          </div>
        </div>

        <div id="friends-view" class="hidden">
          <section class="card collapsible" id="friend-privacy-card">
            <h2 class="collapsible-header">Privacy <span class="collapse-arrow">&#9656;</span></h2>
            <div class="collapsible-body hidden">
              <p class="hint">Friends remain optional. Choose what accepted friends can see.</p>
              <label class="checkbox-row"><input id="share-study-time" type="checkbox" /> Share study duration</label>
              <label class="checkbox-row"><input id="share-activity" type="checkbox" /> Share activity types in the feed</label>
              <label class="checkbox-row"><input id="share-project" type="checkbox" /> Share which project I worked on</label>
              <div class="button-row"><button id="save-friend-privacy" type="button">Save privacy</button></div>
              <p id="friend-privacy-message" class="message"></p>
            </div>
          </section>
          <section class="card collapsible" id="friend-search-card">
            <h2 class="collapsible-header">Find friends <span class="collapse-arrow">&#9656;</span></h2>
            <div class="collapsible-body hidden">
              <div class="friend-search-row">
                <input id="friend-search-input" type="text" placeholder="Search by username…" />
                <button id="friend-search-button">Search</button>
              </div>
              <p id="friend-search-message" class="message"></p>
              <div id="friend-search-results"></div>
            </div>
          </section>
          <section class="card collapsible hidden" id="friend-requests-card">
            <h2 class="collapsible-header">Friend requests <span class="request-badge" id="friend-requests-badge"></span> <span class="collapse-arrow">&#9656;</span></h2>
            <div class="collapsible-body hidden">
              <div id="friend-requests-list"></div>
            </div>
          </section>
          <section class="card">
            <h2>Activity</h2>
            <div id="friend-feed"></div>
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
let currentView: AppView = "today";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Could not find #app root element.");

function updateThemeButton(button: HTMLButtonElement, theme: string): void {
  // Show the icon for the theme the user would SWITCH TO (sun = "go light",
  // moon = "go dark") — same convention the old emoji used.
  button.innerHTML = theme === "dark" ? renderSunIconSvg(2) : renderMoonIconSvg(2);
  button.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

function switchView(views: Record<AppView, HTMLElement>, view: AppView): void {
  currentView = view;
  Object.entries(views).forEach(([key, el]) => el.classList.toggle("hidden", key !== view));
  document.querySelectorAll<HTMLButtonElement>(".feature-tab").forEach((tab) =>
    tab.classList.toggle("active", tab.dataset.view === view),
  );
  // Per-view "user opened me" hooks. Keeps notification mark-read tied to an
  // actual user action instead of every background refresh.
  if (view === "friends") void FriendsView.onViewActivated();
}

async function refreshAll(): Promise<void> {
  try {
    await Promise.all([
      NotesView.refresh(),
      TodayView.refresh(),
      FeynmanView.refresh(),
      PomodoroView.refresh(),
      ProjectsView.refresh(),
      StatsView.refresh(),
      StopwatchView.refresh(),
      FriendsView.refresh(),
      MilestonesView.refresh(),
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
  const topbarAvatar = app!.querySelector<HTMLSpanElement>("#topbar-avatar")!;
  const topbarUsername = app!.querySelector<HTMLSpanElement>("#topbar-username")!;
  const logoutBtn = app!.querySelector<HTMLButtonElement>("#logout-button")!;
  const profileAvatar = app!.querySelector<HTMLDivElement>("#profile-avatar")!;
  const profileUsername = app!.querySelector<HTMLDivElement>("#profile-username")!;
  const pickerToggle = app!.querySelector<HTMLButtonElement>("#avatar-picker-toggle")!;
  const pickerEl = app!.querySelector<HTMLDivElement>("#avatar-picker")!;
  const pickerMsg = app!.querySelector<HTMLParagraphElement>("#avatar-picker-message")!;

  function renderUserChrome(u: UserRead): void {
    topbarAvatar.innerHTML = renderAvatarSvg(u.cat_skin, 22);
    topbarUsername.textContent = u.username;
    profileAvatar.innerHTML = renderAvatarSvg(u.cat_skin, 96);
    profileUsername.textContent = u.username;
  }

  // The picker is locked once enough pomodoro minutes have NOT yet been
  // earned since the user's last explicit skin pick. accumulated >= required
  // means "free to change".
  function isLocked(u: UserRead): boolean {
    return u.cat_skin_minutes_accumulated < u.cat_skin_minutes_required;
  }

  function renderPicker(u: UserRead): void {
    const locked = isLocked(u);
    const remaining = Math.max(0, u.cat_skin_minutes_required - u.cat_skin_minutes_accumulated);
    const statusLine = locked
      ? `<p class="hint avatar-lock-hint">🔒 Locked — earn <strong>${fmtMinutes(remaining)}</strong> of pomodoro work to change cat again.</p>`
      : `<p class="hint avatar-lock-hint">Pick a cat. Once chosen, requires ${fmtMinutes(u.cat_skin_minutes_required)} of pomodoro work before changing again.</p>`;
    const swatches = CAT_SKINS.map((s) => {
      const isCurrent = s.id === u.cat_skin;
      const disabled = locked && !isCurrent;
      return `
        <button type="button"
                class="avatar-swatch${isCurrent ? " selected" : ""}${disabled ? " disabled" : ""}"
                data-skin="${s.id}"
                title="${s.name}${disabled ? " (locked)" : ""}"
                ${disabled ? "aria-disabled=\"true\"" : ""}>
          ${renderAvatarSvg(s.id, 44)}
        </button>`;
    }).join("");
    pickerEl.innerHTML = statusLine + `<div class="avatar-swatch-grid">${swatches}</div>`;
  }

  renderUserChrome(user);
  renderPicker(user);
  setCurrentCatSkin(user.cat_skin);
  updateThemeButton(themeToggle, user.theme);

  // Cat reaction on pomodoro work completion. Pomodoro view dispatches
  // 'cat:cheer'; we add a CSS class to the profile avatar for ~1.4s, then
  // strip it so the next event can re-trigger the animation. Re-entrant
  // safe: removing the class then forcing reflow via offsetWidth makes
  // re-add a fresh start, not a no-op.
  window.addEventListener("cat:cheer", () => {
    profileAvatar.classList.remove("cat-cheer");
    void profileAvatar.offsetWidth;
    profileAvatar.classList.add("cat-cheer");
    // Refresh XP/streak so the user immediately sees the +25 and streak update.
    void StatsView.refresh();
  });

  pickerToggle.addEventListener("click", () => {
    pickerEl.classList.toggle("hidden");
  });

  pickerEl.addEventListener("click", async (event) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLButtonElement>(".avatar-swatch")
      : null;
    if (!target) return;
    const skin = target.dataset.skin;
    if (!skin || skin === user.cat_skin) return;

    if (isLocked(user)) {
      const remaining = user.cat_skin_minutes_required - user.cat_skin_minutes_accumulated;
      pickerMsg.className = "message error";
      pickerMsg.textContent = `🔒 ${fmtMinutes(remaining)} of pomodoro work left to unlock.`;
      return;
    }

    const skinName = CAT_SKINS.find((s) => s.id === skin)?.name ?? skin;
    const required = fmtMinutes(user.cat_skin_minutes_required);
    if (!window.confirm(
      `Pick "${skinName}"?\n\n` +
      `After confirming, you'll need ${required} of pomodoro work before you can change cat again.`
    )) return;

    try {
      const updated = await updateMe({ cat_skin: skin });
      Object.assign(user, updated);
      renderUserChrome(updated);
      renderPicker(updated);
      // Propagate the new skin to all views that show it.
      setCurrentCatSkin(updated.cat_skin);
      StopwatchView.setCatSkin(updated.cat_skin);
      PomodoroView.setCatSkin(updated.cat_skin);
      // Re-render any visible sleeping-cat empty states with the new skin.
      window.dispatchEvent(new CustomEvent("cat:skin-changed"));
      void FriendsView.refresh();
      pickerMsg.className = "message success";
      pickerMsg.textContent = "Avatar updated.";
    } catch (error) {
      console.error(error);
      pickerMsg.className = "message error";
      if (error instanceof ApiError) {
        try {
          const parsed = JSON.parse(error.body) as { detail?: string };
          pickerMsg.textContent = parsed?.detail ?? "Could not update avatar.";
        } catch {
          pickerMsg.textContent = "Could not update avatar.";
        }
      } else {
        pickerMsg.textContent = "Could not update avatar.";
      }
    }
  });

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
    today:    app!.querySelector<HTMLDivElement>("#today-view")!,
    notes:    app!.querySelector<HTMLDivElement>("#notes-view")!,
    feynman:  app!.querySelector<HTMLDivElement>("#feynman-view")!,
    projects: app!.querySelector<HTMLDivElement>("#projects-view")!,
    stats:    app!.querySelector<HTMLDivElement>("#stats-view")!,
    friends:  app!.querySelector<HTMLDivElement>("#friends-view")!,
  };

  // Init each view module
  NotesView.init(
    async () => { await NotesView.refresh(); await StatsView.refresh(); },
    (v) => switchView(views, v as AppView),
  );
  initReadingInsightPrompts();
  FeynmanView.init(
    async () => { await FeynmanView.refresh(); await StatsView.refresh(); },
    (v) => switchView(views, v as AppView),
  );
  PomodoroView.init(() => Promise.all([PomodoroView.refresh(), StatsView.refresh()]).then());
  PomodoroView.setUser(user);  // pass settings (work/break durations etc.) to the timer
  PomodoroView.setCatSkin(user.cat_skin);  // initial pixel-clock tint
  // Projects: refresh stats too so the "Time per project" card reflects
  // renames/archives immediately rather than next stats refresh.
  ProjectsView.init(async () => {
    await Promise.all([StatsView.refresh(), NotesView.refresh(), TodayView.refresh(), FeynmanView.refresh()]);
  });
  // Warm the projects cache at boot so pickers in other views can render
  // their dropdowns without a per-view fetch.
  void refreshProjects(true);
  StatsView.init(() => StatsView.refresh());
  StopwatchView.init(user.cat_skin);
  TimerMode.init();
  FriendsView.init(() => FriendsView.refresh());
  MilestonesView.init();
  TodayView.init(() => Promise.all([
    TodayView.refresh(), StatsView.refresh(), PomodoroView.refresh(),
  ]).then());
  // AI panel lives inside the stats view. Fire-and-forget — config fetch
  // determines whether the card reveals itself.
  void SummariesView.init();

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

  // Wrap mountApp / auth flow in withFallback so a view's broken init()
  // surfaces a visible banner instead of a silent blank page.
  await withFallback(async () => {
    if (currentUser) {
      mountApp(currentUser);
    } else {
      const user = await showAuthScreen(app!);
      currentUser = user;
      mountApp(user);
    }
  });
}

installErrorBoundary();
void bootstrap();
