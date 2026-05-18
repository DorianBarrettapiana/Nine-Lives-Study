/**
 * Stats view.
 *
 * Tasks section: expandable day list showing diary + completed tasks per day.
 * Pomodoro section: SVG line chart (minutes/day) + time-of-day distribution.
 */

import { getUserStats, getUserXp, type UserProgressRead, type UserStatsRead } from "../api/stats";
import { getDailyState, type DailyStateRead } from "../api/tracker";
import { listSessions, type PomodoroSessionRead } from "../api/pomodoro";
import { escapeHtml, makeDateLabel } from "../utils";

let statsTotals: HTMLDivElement;
let statsTasksChart: HTMLDivElement;
let statsPomodoroChart: HTMLDivElement;
let statsMoodChart: HTMLDivElement;
let statsTasksTitle: HTMLHeadingElement;
let statsPomodoroTitle: HTMLHeadingElement;
let statsMoodTitle: HTMLHeadingElement;
let xpLevel: HTMLSpanElement;
let xpBarFill: HTMLDivElement;
let xpLabel: HTMLParagraphElement;

let userStats: UserStatsRead | null = null;
let userProgress: UserProgressRead | null = null;
let allSessions: PomodoroSessionRead[] = [];
let expandedDay: string | null = null;
const dayCache = new Map<string, DailyStateRead>();

export let statsDays = 7;

// --- XP ---
export function renderXp(): void {
  if (!userProgress) return;
  xpLevel.textContent = String(userProgress.level);
  xpBarFill.style.width = `${Math.round((userProgress.xp_in_level / 100) * 100)}%`;
  xpLabel.textContent = `${userProgress.xp_in_level} / 100 XP`;
}

// --- Totals ---
function renderTotals(): void {
  if (!userStats) { statsTotals.innerHTML = `<div class="empty-state">Stats not loaded.</div>`; return; }
  statsTotals.innerHTML = [
    { label: "Pomodoros", value: userStats.total_pomodoros },
    { label: "Paper notes", value: userStats.total_notes },
    { label: "Feynman records", value: userStats.total_feynman },
    { label: "Mood entries", value: userStats.total_moods ?? 0 },
  ].map(({ label, value }) =>
    `<div class="stat-card"><strong>${value}</strong><span>${label}</span></div>`
  ).join("");
}

// --- Tasks: expandable day list ---
function renderDayDetail(state: DailyStateRead, container: HTMLDivElement): void {
  const { tasks, log } = state;
  if (tasks.length === 0 && !log) {
    container.innerHTML = `<div class="empty-state" style="padding:0.5rem 0">No data for this day.</div>`;
    return;
  }
  let html = "";
  if (tasks.length > 0) {
    html += `<ul class="day-task-list">` + tasks.map(t =>
      `<li class="${t.is_done ? "done" : ""}">
        <span class="task-check">${t.is_done ? "✓" : "○"}</span>
        <span>${escapeHtml(t.text)}</span>
      </li>`
    ).join("") + `</ul>`;
  }
  if (log && (log.reflection || log.mood)) {
    html += `<div class="day-log-detail">`;
    if (log.mood) html += `<span class="mood-emoji">${log.mood}</span>`;
    if (log.reflection) html += `<p class="day-reflection">${escapeHtml(log.reflection)}</p>`;
    html += `</div>`;
  }
  container.innerHTML = html;
}

function renderTaskDayList(): void {
  if (!userStats) { statsTasksChart.innerHTML = `<div class="empty-state">No data yet.</div>`; return; }

  const dateSet = new Set<string>();
  userStats.daily_tasks.forEach(d => dateSet.add(d.date));
  userStats.daily_moods.forEach(d => dateSet.add(d.date));
  const dates = Array.from(dateSet).sort().reverse();

  if (dates.length === 0) {
    statsTasksChart.innerHTML = `<div class="empty-state">No data yet.</div>`;
    return;
  }

  const moodByDate = new Map(userStats.daily_moods.map(d => [d.date, d.mood]));
  const tasksByDate = new Map(userStats.daily_tasks.map(d => [d.date, d]));

  statsTasksChart.innerHTML = dates.map(date => {
    const taskStat = tasksByDate.get(date);
    const mood = moodByDate.get(date) ?? "";
    const done = taskStat?.done ?? 0;
    const total = taskStat?.total ?? 0;
    const isExpanded = expandedDay === date;
    return `
      <div class="day-row${isExpanded ? " expanded" : ""}" data-date="${date}">
        <div class="day-row-header">
          <span class="day-row-label">${makeDateLabel(date)}</span>
          <span class="day-row-meta">
            ${total > 0 ? `<span class="day-task-count">${done}/${total} tasks</span>` : ""}
            ${mood ? `<span class="mood-emoji-sm">${mood}</span>` : ""}
          </span>
          <span class="day-row-arrow">${isExpanded ? "▲" : "▼"}</span>
        </div>
        <div class="day-row-detail"${isExpanded ? "" : ' style="display:none"'}></div>
      </div>`;
  }).join("");

  statsTasksChart.querySelectorAll<HTMLDivElement>(".day-row").forEach(row => {
    const date = row.dataset.date!;
    const header = row.querySelector<HTMLDivElement>(".day-row-header")!;
    const detail = row.querySelector<HTMLDivElement>(".day-row-detail")!;

    if (expandedDay === date && dayCache.has(date)) {
      renderDayDetail(dayCache.get(date)!, detail);
    }

    header.addEventListener("click", async () => {
      if (expandedDay === date) {
        expandedDay = null;
        renderTaskDayList();
        return;
      }
      expandedDay = date;
      renderTaskDayList();
      const freshDetail = statsTasksChart.querySelector<HTMLDivElement>(
        `.day-row[data-date="${date}"] .day-row-detail`
      )!;
      if (dayCache.has(date)) {
        renderDayDetail(dayCache.get(date)!, freshDetail);
      } else {
        freshDetail.innerHTML = `<div class="hint" style="padding:0.5rem 0">Loading…</div>`;
        const state = await getDailyState(date);
        dayCache.set(date, state);
        renderDayDetail(state, freshDetail);
      }
    });
  });
}

// --- Pomodoro: line chart + time-of-day distribution ---
const TIME_PERIODS = [
  { key: "morning",   label: "Morning",   start: 6,  end: 12 },
  { key: "afternoon", label: "Afternoon", start: 12, end: 18 },
  { key: "evening",   label: "Evening",   start: 18, end: 22 },
  { key: "night",     label: "Night",     start: 22, end: 30 },
];

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timePeriodKey(hour: number): string {
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

function fmtMinutes(mins: number): string {
  if (mins === 0) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function renderPomodoroSection(): void {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - statsDays + 1);
  cutoff.setHours(0, 0, 0, 0);

  const completedWork = allSessions.filter(s =>
    s.is_completed && s.session_type === "work" && new Date(s.started_at) >= cutoff
  );

  const minutesByDay = new Map<string, number>();
  const periodMins: Record<string, number> = { morning: 0, afternoon: 0, evening: 0, night: 0 };

  for (const s of completedWork) {
    const d = new Date(s.started_at);
    const dateStr = localDateStr(d);
    minutesByDay.set(dateStr, (minutesByDay.get(dateStr) ?? 0) + s.duration_minutes);
    periodMins[timePeriodKey(d.getHours())] += s.duration_minutes;
  }

  // Build full day range for x-axis
  const days: string[] = [];
  for (let i = statsDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(localDateStr(d));
  }

  const values = days.map(d => minutesByDay.get(d) ?? 0);
  const totalMinutes = values.reduce((a, b) => a + b, 0);

  if (totalMinutes === 0) {
    statsPomodoroChart.innerHTML = `<div class="empty-state">No pomodoro data yet.</div>`;
    return;
  }

  // SVG line chart
  const W = 600; const H = 130;
  const PAD = { top: 16, right: 16, bottom: 30, left: 46 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const maxVal = Math.max(...values, 1);

  const xPos = (i: number) =>
    PAD.left + (days.length <= 1 ? chartW / 2 : (i / (days.length - 1)) * chartW);
  const yPos = (v: number) =>
    PAD.top + chartH - (v / maxVal) * chartH;

  const linePoints = values.map((v, i) => `${xPos(i)},${yPos(v)}`).join(" ");
  const areaPoints = [
    `${xPos(0)},${PAD.top + chartH}`,
    ...values.map((v, i) => `${xPos(i)},${yPos(v)}`),
    `${xPos(days.length - 1)},${PAD.top + chartH}`,
  ].join(" ");

  // Y axis ticks
  const yTicks = [0, Math.round(maxVal / 2), maxVal].map(v => ({
    v, y: yPos(v), label: fmtMinutes(v),
  }));

  // X axis labels (sparse)
  const labelStep = Math.max(1, Math.floor(days.length / 6));
  const xLabels = days.map((date, i) => {
    if (i % labelStep !== 0 && i !== days.length - 1) return "";
    const parts = date.split("-");
    return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
  });

  const svgHtml = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         class="pomo-line-chart" preserveAspectRatio="none">
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#6366f1" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#6366f1" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      ${yTicks.map(t =>
        `<line x1="${PAD.left}" y1="${t.y}" x2="${W - PAD.right}" y2="${t.y}"
               stroke="var(--border-soft)" stroke-width="1"/>`
      ).join("")}
      <polygon points="${areaPoints}" fill="url(#areaGrad)"/>
      <polyline points="${linePoints}" fill="none" stroke="#6366f1"
                stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${values.map((v, i) => v > 0
        ? `<circle cx="${xPos(i)}" cy="${yPos(v)}" r="3.5" fill="#6366f1"/>`
        : ""
      ).join("")}
      ${yTicks.map(t =>
        `<text x="${PAD.left - 6}" y="${t.y + 4}" text-anchor="end"
               font-size="10" fill="var(--text-muted)">${t.label}</text>`
      ).join("")}
      ${xLabels.map((lbl, i) => lbl
        ? `<text x="${xPos(i)}" y="${H - 5}" text-anchor="middle"
                 font-size="10" fill="var(--text-muted)">${lbl}</text>`
        : ""
      ).join("")}
    </svg>`;

  // Time-of-day distribution bars
  const maxPeriod = Math.max(...Object.values(periodMins), 1);
  const distributionHtml = `
    <div class="pomo-period-grid">
      ${TIME_PERIODS.map(p => {
        const mins = periodMins[p.key];
        const pct = Math.round((mins / maxPeriod) * 100);
        return `
          <div class="pomo-period-row">
            <span class="pomo-period-label">${p.label}</span>
            <div class="chart-bar-bg">
              <div class="chart-bar-fill" style="width:${pct}%"></div>
            </div>
            <span class="chart-value">${fmtMinutes(mins)}</span>
          </div>`;
      }).join("")}
    </div>`;

  statsPomodoroChart.innerHTML = `
    <div class="pomo-total-label">Total: <strong>${fmtMinutes(totalMinutes)}</strong></div>
    ${svgHtml}
    <p class="pomo-dist-title">Time of day</p>
    ${distributionHtml}`;
}

// --- Mood ---
function renderMoodChart(): void {
  if (!userStats) return;
  statsMoodChart.innerHTML = userStats.daily_moods.length === 0
    ? `<div class="empty-state">No mood data yet.</div>`
    : userStats.daily_moods
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date))
        .map(d =>
          `<div class="mood-history-item">
            <span class="hint">${makeDateLabel(d.date)}</span>
            <span class="mood-emoji">${d.mood || "—"}</span>
          </div>`
        ).join("");
}

export function render(): void {
  const label = `Last ${statsDays} day${statsDays > 1 ? "s" : ""}`;
  statsTasksTitle.textContent = `${label} — daily log`;
  statsPomodoroTitle.textContent = `${label} — Pomodoro`;
  statsMoodTitle.textContent = `${label} — mood`;

  renderTotals();
  renderTaskDayList();
  renderPomodoroSection();
  renderMoodChart();
}

export async function refresh(): Promise<void> {
  try {
    [userStats, userProgress, allSessions] = await Promise.all([
      getUserStats(statsDays),
      getUserXp(),
      listSessions(),
    ]);
    dayCache.clear();
    render();
    renderXp();
  } catch (error) {
    console.error(error);
  }
}

export function init(onRefreshNeeded: () => Promise<void>): void {
  statsTotals = document.querySelector<HTMLDivElement>("#stats-totals")!;
  statsTasksChart = document.querySelector<HTMLDivElement>("#stats-tasks-chart")!;
  statsPomodoroChart = document.querySelector<HTMLDivElement>("#stats-pomodoro-chart")!;
  statsMoodChart = document.querySelector<HTMLDivElement>("#stats-mood-chart")!;
  statsTasksTitle = document.querySelector<HTMLHeadingElement>("#stats-tasks-title")!;
  statsPomodoroTitle = document.querySelector<HTMLHeadingElement>("#stats-pomodoro-title")!;
  statsMoodTitle = document.querySelector<HTMLHeadingElement>("#stats-mood-title")!;
  xpLevel = document.querySelector<HTMLSpanElement>("#xp-level")!;
  xpBarFill = document.querySelector<HTMLDivElement>("#xp-bar-fill")!;
  xpLabel = document.querySelector<HTMLParagraphElement>("#xp-label")!;

  document.querySelectorAll<HTMLButtonElement>(".days-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const days = Number(btn.dataset.days);
      if (!days) return;
      statsDays = days;
      expandedDay = null;
      document.querySelectorAll<HTMLButtonElement>(".days-btn").forEach(b =>
        b.classList.toggle("active", b === btn)
      );
      await onRefreshNeeded();
    });
  });
}
