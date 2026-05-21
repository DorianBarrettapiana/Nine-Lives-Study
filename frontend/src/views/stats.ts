/**
 * Stats view.
 *
 * Tasks section: expandable day list showing diary + completed tasks per day.
 * Pomodoro section: SVG line chart (minutes/day) + time-of-day distribution.
 */

import { listMoodEntries, type MoodEntryRead } from "../api/mood";
import { getUserStats, getUserXp, type UserProgressRead, type UserStatsRead } from "../api/stats";
import { getDailyState, type DailyStateRead } from "../api/tracker";
import { updateMe } from "../api/users";
import { escapeHtml, fmtMinutes, makeDateLabel, parseApiDate } from "../utils";
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
let dailyGoalLine: HTMLDivElement | null;
let perfectDayBadge: HTMLParagraphElement | null;

let userStats: UserStatsRead | null = null;
let userProgress: UserProgressRead | null = null;
let moodEntries: MoodEntryRead[] = [];

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
  // Levels are progressive — current level's XP capacity = xp_in_level +
  // xp_to_next_level. Use that as the denominator so the bar fills to 100%
  // exactly when the user reaches the next level.
  const levelCap = userProgress.xp_in_level + userProgress.xp_to_next_level;
  xpLevel.textContent = String(userProgress.level);
  xpBarFill.style.width = `${Math.round((userProgress.xp_in_level / Math.max(1, levelCap)) * 100)}%`;
  xpLabel.textContent = `${userProgress.xp_in_level} / ${levelCap} XP`;

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

  // Daily work-time goal: progress bar with editable target.
  if (dailyGoalLine) {
    const done = userProgress.today_work_minutes;
    const goal = Math.max(1, userProgress.today_work_minutes_goal);
    const pct = Math.min(100, Math.round((done / goal) * 100));
    const hit = done >= goal;
    dailyGoalLine.innerHTML = `
      <div class="daily-goal-row">
        <span class="daily-goal-text">
          Today: <strong>${fmtMinutes(done)}</strong> /
          <button class="goal-edit-btn" type="button" data-edit-goal="1"
                  title="Click to change daily goal">${fmtMinutes(goal)}</button>
        </span>
        ${hit ? `<span class="goal-hit">✓ goal!</span>` : ""}
      </div>
      <div class="daily-goal-bar"><div class="daily-goal-fill${hit ? " hit" : ""}" style="width:${pct}%"></div></div>
    `;
  }

  // Perfect-day badge.
  if (perfectDayBadge) {
    perfectDayBadge.classList.toggle("hidden", !userProgress.is_today_perfect);
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

  // Daily average across the selected window — gives "are you actually
  // putting in time most days?" at a glance, independent of the chart shape.
  const avgPerDay = Math.round(totalMinutes / Math.max(1, statsDays));
  statsPomodoroChart.innerHTML = `
    <div class="pomo-total-label">
      Total: <strong>${fmtMinutes(totalMinutes)}</strong>
      · Daily avg: <strong>${fmtMinutes(avgPerDay)}</strong>
    </div>
    ${svgHtml}`;
}

// --- Mood ---
// Color per mood emoji — kept in the same order as the picker for visual
// consistency between recording and review.
const MOOD_ORDER = ["😩", "😔", "😐", "🙂", "🔥"] as const;
const MOOD_COLORS: Record<string, string> = {
  "😩": "#6b7280", // exhausted — grey
  "😔": "#3b82f6", // low — blue
  "😐": "#a3a3a3", // neutral — light grey
  "🙂": "#10b981", // good — green
  "🔥": "#f59e0b", // on fire — orange
};
const TIME_BUCKETS = [
  { key: "morning",   label: "Morning",   from: 6,  to: 12 },
  { key: "afternoon", label: "Afternoon", from: 12, to: 18 },
  { key: "evening",   label: "Evening",   from: 18, to: 22 },
  { key: "night",     label: "Night",     from: 22, to: 30 }, // 22-06
];
function bucketForHour(h: number): string {
  if (h >= 6  && h < 12) return "morning";
  if (h >= 12 && h < 18) return "afternoon";
  if (h >= 18 && h < 22) return "evening";
  return "night";
}
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Stacked bar — given { [emoji]: count } per category, returns an SVG of
 *  vertical bars one per category. Heights are normalized to maxTotal. */
function renderStackedBars(categories: { key: string; label: string; counts: Record<string, number> }[], maxTotal: number): string {
  const W = 480;
  const H = 130;
  const PAD = { top: 14, right: 14, bottom: 28, left: 24 };
  const chartH = H - PAD.top - PAD.bottom;
  const barSlot = (W - PAD.left - PAD.right) / Math.max(1, categories.length);
  const barW = Math.max(8, Math.min(48, barSlot * 0.65));

  let rects = "";
  let labels = "";
  let counts = "";
  categories.forEach((cat, i) => {
    const total = Object.values(cat.counts).reduce((a, b) => a + b, 0);
    const cx = PAD.left + barSlot * (i + 0.5);
    const x = cx - barW / 2;
    let yCursor = PAD.top + chartH; // start at bottom and stack upward
    for (const emoji of MOOD_ORDER) {
      const c = cat.counts[emoji] || 0;
      if (c === 0) continue;
      const segH = (c / Math.max(1, maxTotal)) * chartH;
      yCursor -= segH;
      rects += `<rect x="${x}" y="${yCursor}" width="${barW}" height="${segH}" fill="${MOOD_COLORS[emoji]}" />`;
    }
    labels += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${cat.label}</text>`;
    if (total > 0) {
      counts += `<text x="${cx}" y="${PAD.top + chartH - (total / Math.max(1, maxTotal)) * chartH - 4}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text-soft)">${total}</text>`;
    }
  });

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" class="mood-bar-svg">${rects}${counts}${labels}</svg>`;
}

function renderMoodLegend(): string {
  return `<div class="mood-legend">${
    MOOD_ORDER.map(e =>
      `<span class="mood-legend-item">
        <span class="mood-legend-swatch" style="background:${MOOD_COLORS[e]}"></span>
        ${e}
      </span>`
    ).join("")
  }</div>`;
}

function renderMoodChart(): void {
  if (!userStats) return;
  if (moodEntries.length === 0) {
    statsMoodChart.innerHTML = `<div class="empty-state">No mood data yet.</div>`;
    return;
  }

  // --- Bucket A: by time-of-day ----------------------------------------
  const byTime: Record<string, Record<string, number>> = {};
  for (const b of TIME_BUCKETS) byTime[b.key] = {};
  for (const e of moodEntries) {
    const d = parseApiDate(e.created_at);
    const bucket = bucketForHour(d.getHours());
    byTime[bucket][e.mood] = (byTime[bucket][e.mood] || 0) + 1;
  }
  const timeCategories = TIME_BUCKETS.map(b => ({
    key: b.key, label: b.label, counts: byTime[b.key],
  }));
  const maxTime = Math.max(1, ...timeCategories.map(c => Object.values(c.counts).reduce((a, b) => a + b, 0)));

  // --- Bucket B: by date — last N days, oldest → newest -----------------
  const days: { key: string; label: string }[] = [];
  for (let i = statsDays - 1; i >= 0; i--) {
    const dd = new Date();
    dd.setDate(dd.getDate() - i);
    days.push({ key: localDate(dd), label: `${dd.getMonth() + 1}/${dd.getDate()}` });
  }
  const byDate: Record<string, Record<string, number>> = {};
  for (const d of days) byDate[d.key] = {};
  for (const e of moodEntries) {
    const localKey = localDate(parseApiDate(e.created_at));
    if (byDate[localKey] !== undefined) {
      byDate[localKey][e.mood] = (byDate[localKey][e.mood] || 0) + 1;
    }
  }
  // For 30/90 day windows we sparsify the labels so they don't overlap.
  const labelStep = Math.max(1, Math.floor(days.length / 10));
  const dateCategories = days.map((d, i) => ({
    key: d.key,
    label: (i % labelStep === 0 || i === days.length - 1) ? d.label : "",
    counts: byDate[d.key],
  }));
  const maxDate = Math.max(1, ...dateCategories.map(c => Object.values(c.counts).reduce((a, b) => a + b, 0)));

  statsMoodChart.innerHTML = `
    <div class="mood-subchart">
      <p class="mood-subchart-title">By time of day</p>
      ${renderStackedBars(timeCategories, maxTime)}
    </div>
    <div class="mood-subchart">
      <p class="mood-subchart-title">By date</p>
      ${renderStackedBars(dateCategories, maxDate)}
    </div>
    ${renderMoodLegend()}`;
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
    [userStats, userProgress, moodEntries] = await Promise.all([
      getUserStats(statsDays),
      getUserXp(),
      // Fetch raw mood entries so we can build the time-of-day and per-day
      // bar charts client-side (no extra backend aggregation needed).
      listMoodEntries(statsDays),
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
  dailyGoalLine = document.querySelector<HTMLDivElement>("#daily-goal-line");
  perfectDayBadge = document.querySelector<HTMLParagraphElement>("#perfect-day-badge");

  // Inline goal editor — small prompt to keep the implementation tiny.
  // Could later become a proper inline input; for now it's just a prompt.
  dailyGoalLine?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.editGoal !== "1") return;
    const current = userProgress?.today_work_minutes_goal ?? 120;
    const raw = window.prompt(
      "Daily work-time goal (in minutes, 15–720):",
      String(current),
    );
    if (raw === null) return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 15 || parsed > 720) {
      window.alert("Please enter a number between 15 and 720.");
      return;
    }
    try {
      await updateMe({ daily_goal_minutes: Math.round(parsed) });
      await refresh();
    } catch (e) {
      console.error(e);
    }
  });

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
