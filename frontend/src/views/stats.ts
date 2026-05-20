/**
 * Stats view.
 *
 * Tasks section: expandable day list showing diary + completed tasks per day.
 * Pomodoro section: SVG line chart (minutes/day) + time-of-day distribution.
 */

import { getUserStats, getUserXp, type UserProgressRead, type UserStatsRead } from "../api/stats";
import { getDailyState, type DailyStateRead } from "../api/tracker";
import { escapeHtml, fmtMinutes, makeDateLabel } from "../utils";
import { renderFlameIconSvg } from "./icons";

let statsTotals: HTMLDivElement;
let weeklyCard: HTMLElement | null;
let weeklyGrid: HTMLDivElement | null;
let statsTasksChart: HTMLDivElement;
let statsPomodoroChart: HTMLDivElement;
let statsMoodChart: HTMLDivElement;
let statsTasksTitle: HTMLHeadingElement;
let statsPomodoroTitle: HTMLHeadingElement;
let statsMoodTitle: HTMLHeadingElement;
let xpLevel: HTMLSpanElement;
let xpBarFill: HTMLDivElement;
let xpLabel: HTMLParagraphElement;
let streakLine: HTMLParagraphElement | null;

let userStats: UserStatsRead | null = null;
let userProgress: UserProgressRead | null = null;

/** Read-only accessor used by the pomodoro/stopwatch views so they can
 *  display today's work-minutes without a separate /xp round trip. */
export function getTodayWorkMinutes(): number {
  return userProgress?.today_work_minutes ?? 0;
}
let expandedDay: string | null = null;
const dayCache = new Map<string, DailyStateRead>();

export let statsDays = 7;

// --- XP ---
export function renderXp(): void {
  if (!userProgress) return;
  xpLevel.textContent = String(userProgress.level);
  xpBarFill.style.width = `${Math.round((userProgress.xp_in_level / 100) * 100)}%`;
  xpLabel.textContent = `${userProgress.xp_in_level} / 100 XP`;

  if (streakLine) {
    const n = userProgress.streak_days;
    if (n <= 0) {
      // textContent (not innerHTML) so the prompt has no leading icon.
      streakLine.textContent = "Complete a work session today to start a streak.";
      streakLine.classList.remove("streak-active", "streak-grace");
    } else if (userProgress.streak_active_today) {
      streakLine.innerHTML = `${renderFlameIconSvg()} ${n}-day streak`;
      streakLine.classList.add("streak-active");
      streakLine.classList.remove("streak-grace");
    } else {
      // Streak alive thanks to yesterday — grace day until midnight.
      streakLine.innerHTML = `${renderFlameIconSvg()} ${n}-day streak — keep it alive today`;
      streakLine.classList.add("streak-grace");
      streakLine.classList.remove("streak-active");
    }
  }
}

// --- Weekly summary ---
function renderWeeklySummary(): void {
  if (!weeklyCard || !weeklyGrid) return;
  const ws = userStats?.weekly_summary;
  if (!ws) {
    weeklyCard.classList.add("hidden");
    return;
  }
  // `format` lets us render minutes as "Xh Ym" while keeping integers raw.
  const items: Array<{ label: string; a: number; b: number; format?: (n: number) => string }> = [
    { label: "Work time",    a: ws.this_week.work_minutes, b: ws.prev_week.work_minutes, format: fmtMinutes },
    { label: "Tasks done",   a: ws.this_week.tasks_done,   b: ws.prev_week.tasks_done },
    { label: "Paper notes",  a: ws.this_week.notes,        b: ws.prev_week.notes },
    { label: "Feynman",      a: ws.this_week.feynman,      b: ws.prev_week.feynman },
    { label: "Mood entries", a: ws.this_week.moods,        b: ws.prev_week.moods },
  ];
  const anyData = items.some((i) => i.a > 0 || i.b > 0);
  if (!anyData) {
    weeklyCard.classList.add("hidden");
    return;
  }
  weeklyCard.classList.remove("hidden");
  weeklyGrid.innerHTML = items.map(({ label, a, b, format }) => {
    let deltaHtml = `<span class="weekly-delta neutral">—</span>`;
    if (b === 0 && a > 0) {
      deltaHtml = `<span class="weekly-delta up">new ↑</span>`;
    } else if (b > 0) {
      const pct = Math.round(((a - b) / b) * 100);
      if (pct > 0) deltaHtml = `<span class="weekly-delta up">+${pct}% ↑</span>`;
      else if (pct < 0) deltaHtml = `<span class="weekly-delta down">${pct}% ↓</span>`;
      else deltaHtml = `<span class="weekly-delta neutral">=</span>`;
    }
    const fmt = format ?? ((n: number) => String(n));
    const aStr = fmt(a);
    const bStr = fmt(b);
    return `
      <div class="stat-card weekly-stat">
        <strong>${aStr}</strong>
        <span>${label}</span>
        <span class="weekly-prev">prev: ${bStr}</span>
        ${deltaHtml}
      </div>`;
  }).join("");
}

// --- Totals ---
function renderTotals(): void {
  if (!userStats) { statsTotals.innerHTML = `<div class="empty-state">Stats not loaded.</div>`; return; }
  statsTotals.innerHTML = [
    { label: "Work time",      value: fmtMinutes(userStats.total_work_minutes) },
    { label: "Paper notes",    value: String(userStats.total_notes) },
    { label: "Feynman records",value: String(userStats.total_feynman) },
    { label: "Mood entries",   value: String(userStats.total_moods ?? 0) },
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

// --- Work time: minutes-per-day line chart ---
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderWorkSection(): void {
  // Server returns minutes per local day for pomodoro + stopwatch combined.
  const dataset = userStats?.daily_work_minutes ?? [];
  const minutesByDay = new Map<string, number>();
  for (const d of dataset) minutesByDay.set(d.date, d.minutes);

  // Build full day range for x-axis so empty days show as 0.
  const days: string[] = [];
  for (let i = statsDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(localDateStr(d));
  }
  const values = days.map(d => minutesByDay.get(d) ?? 0);
  const totalMinutes = values.reduce((a, b) => a + b, 0);

  if (totalMinutes === 0) {
    statsPomodoroChart.innerHTML = `<div class="empty-state">No work time logged yet.</div>`;
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

  statsPomodoroChart.innerHTML = `
    <div class="pomo-total-label">Total: <strong>${fmtMinutes(totalMinutes)}</strong></div>
    ${svgHtml}`;
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
  statsPomodoroTitle.textContent = `${label} — work time`;
  statsMoodTitle.textContent = `${label} — mood`;

  renderWeeklySummary();
  renderTotals();
  renderTaskDayList();
  renderWorkSection();
  renderMoodChart();
}

export async function refresh(): Promise<void> {
  try {
    [userStats, userProgress] = await Promise.all([
      getUserStats(statsDays),
      getUserXp(),
    ]);
    dayCache.clear();
    render();
    renderXp();
    // Tell views that show today's work minutes (pomodoro, stopwatch) to
    // pick up the new value. Loose coupling: those views don't need to
    // know about stats internals.
    window.dispatchEvent(new CustomEvent("progress:updated"));
  } catch (error) {
    console.error(error);
  }
}

export function init(onRefreshNeeded: () => Promise<void>): void {
  statsTotals = document.querySelector<HTMLDivElement>("#stats-totals")!;
  weeklyCard = document.querySelector<HTMLElement>("#weekly-summary-card");
  weeklyGrid = document.querySelector<HTMLDivElement>("#weekly-summary-grid");
  statsTasksChart = document.querySelector<HTMLDivElement>("#stats-tasks-chart")!;
  statsPomodoroChart = document.querySelector<HTMLDivElement>("#stats-pomodoro-chart")!;
  statsMoodChart = document.querySelector<HTMLDivElement>("#stats-mood-chart")!;
  statsTasksTitle = document.querySelector<HTMLHeadingElement>("#stats-tasks-title")!;
  statsPomodoroTitle = document.querySelector<HTMLHeadingElement>("#stats-pomodoro-title")!;
  statsMoodTitle = document.querySelector<HTMLHeadingElement>("#stats-mood-title")!;
  xpLevel = document.querySelector<HTMLSpanElement>("#xp-level")!;
  xpBarFill = document.querySelector<HTMLDivElement>("#xp-bar-fill")!;
  xpLabel = document.querySelector<HTMLParagraphElement>("#xp-label")!;
  streakLine = document.querySelector<HTMLParagraphElement>("#streak-line");

  // Scope to #stats-view so we don't accidentally pick up mood-view days
  // buttons (same class) and trigger cross-view side effects.
  document.querySelectorAll<HTMLButtonElement>("#stats-view .days-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const days = Number(btn.dataset.days);
      if (!days) return;
      statsDays = days;
      expandedDay = null;
      document.querySelectorAll<HTMLButtonElement>("#stats-view .days-btn").forEach(b =>
        b.classList.toggle("active", b === btn)
      );
      await onRefreshNeeded();
    });
  });
}
