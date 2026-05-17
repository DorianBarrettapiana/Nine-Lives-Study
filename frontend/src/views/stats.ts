/**
 * Stats view.
 */

import { getUserStats, getUserXp, type UserProgressRead, type UserStatsRead } from "../api/stats";
import { makeDateLabel } from "../utils";
import type { UserRead } from "../api/users";

let statsTotals: HTMLDivElement;
let statsTasksChart: HTMLDivElement;
let statsPomodoroChart: HTMLDivElement;
let statsMoodChart: HTMLDivElement;
let statsTasksTitle: HTMLHeadingElement;
let statsPomodoroTitle: HTMLHeadingElement;
let statsMoodTitle: HTMLHeadingElement;
let refreshStatsButton: HTMLButtonElement;
let xpLevel: HTMLSpanElement;
let xpBarFill: HTMLDivElement;
let xpLabel: HTMLParagraphElement;

let userStats: UserStatsRead | null = null;
let userProgress: UserProgressRead | null = null;
export let statsDays = 7;

function renderBarChart(
  container: HTMLDivElement,
  rows: { label: string; value: number; max: number; suffix: string }[],
): void {
  if (rows.length === 0) { container.innerHTML = `<div class="empty-state">No data yet.</div>`; return; }
  container.innerHTML = rows.map(({ label, value, max, suffix }) => {
    const pct = max > 0 ? Math.round((value / max) * 100) : 0;
    return `
      <div class="chart-row">
        <span class="chart-label">${label}</span>
        <div class="chart-bar-bg" style="width:100%"><div class="chart-bar-fill" style="width:${pct}%"></div></div>
        <span class="chart-value">${value}${suffix}</span>
      </div>`;
  }).join("");
}

export function renderXp(): void {
  if (!userProgress) return;
  xpLevel.textContent = String(userProgress.level);
  xpBarFill.style.width = `${Math.round((userProgress.xp_in_level / 100) * 100)}%`;
  xpLabel.textContent = `${userProgress.xp_in_level} / 100 XP`;
}

export function render(): void {
  const label = `Last ${statsDays} day${statsDays > 1 ? "s" : ""}`;
  statsTasksTitle.textContent = `${label} — tasks`;
  statsPomodoroTitle.textContent = `${label} — Pomodoro sessions`;
  statsMoodTitle.textContent = `${label} — mood`;

  if (!userStats) {
    statsTotals.innerHTML = `<div class="empty-state">Stats not loaded.</div>`;
    statsTasksChart.innerHTML = "";
    statsPomodoroChart.innerHTML = "";
    statsMoodChart.innerHTML = "";
    return;
  }

  statsTotals.innerHTML = [
    { label: "Tasks done", value: userStats.total_tasks_done },
    { label: "Pomodoros", value: userStats.total_pomodoros },
    { label: "Paper notes", value: userStats.total_notes },
    { label: "Feynman records", value: userStats.total_feynman },
  ].map((item) => `<div class="stat-card"><strong>${item.value}</strong><span>${item.label}</span></div>`).join("");

  const maxTasks = Math.max(...userStats.daily_tasks.map((d) => d.total), 1);
  renderBarChart(statsTasksChart, userStats.daily_tasks.map((d) => ({
    label: makeDateLabel(d.date), value: d.done, max: maxTasks, suffix: `/${d.total}`,
  })));

  const maxPom = Math.max(...userStats.daily_pomodoros.map((d) => d.count), 1);
  renderBarChart(statsPomodoroChart, userStats.daily_pomodoros.map((d) => ({
    label: makeDateLabel(d.date), value: d.count, max: maxPom, suffix: " sessions",
  })));

  statsMoodChart.innerHTML = userStats.daily_moods.length === 0
    ? `<div class="empty-state">No mood data yet.</div>`
    : userStats.daily_moods.map((d) =>
        `<div class="mood-history-item"><span class="hint">${makeDateLabel(d.date)}</span><span class="mood-emoji">${d.mood || "—"}</span></div>`
      ).join("");
}

export async function refresh(currentUser: UserRead | null): Promise<void> {
  if (!currentUser) { userStats = null; render(); renderXp(); return; }
  try {
    [userStats, userProgress] = await Promise.all([
      getUserStats(currentUser.id, statsDays),
      getUserXp(currentUser.id),
    ]);
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
  refreshStatsButton = document.querySelector<HTMLButtonElement>("#refresh-stats-button")!;
  xpLevel = document.querySelector<HTMLSpanElement>("#xp-level")!;
  xpBarFill = document.querySelector<HTMLDivElement>("#xp-bar-fill")!;
  xpLabel = document.querySelector<HTMLParagraphElement>("#xp-label")!;

  refreshStatsButton.addEventListener("click", async () => await onRefreshNeeded());

  document.querySelectorAll<HTMLButtonElement>(".days-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const days = Number(btn.dataset.days);
      if (!days) return;
      statsDays = days;
      document.querySelectorAll<HTMLButtonElement>(".days-btn").forEach((b) =>
        b.classList.toggle("active", b === btn),
      );
      await onRefreshNeeded();
    });
  });
}
