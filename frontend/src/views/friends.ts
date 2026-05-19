/**
 * Friends view.
 *
 * Search users → send request; accept/decline incoming requests;
 * view friends list; click a friend to see their daily study time
 * (line chart) and time-of-day distribution.
 */

import {
  acceptFriendRequest,
  getFriendStudyStats,
  listFriendRequests,
  listFriends,
  removeFriend,
  searchUsers,
  sendFriendRequest,
  type FriendEntry,
  type FriendRequestEntry,
  type FriendStudyStats,
} from "../api/friends";
import { escapeHtml, fmtMinutes, setMessage } from "../utils";

let friendSearchInput: HTMLInputElement;
let friendSearchButton: HTMLButtonElement;
let friendSearchResults: HTMLDivElement;
let friendRequestsList: HTMLDivElement;
let friendsList: HTMLDivElement;
let friendStatsPanel: HTMLDivElement;
let friendSearchMessage: HTMLParagraphElement;

let friends: FriendEntry[] = [];
let requests: FriendRequestEntry[] = [];
let selectedFriendDays = 7;

// ---------------------------------------------------------------------------
// Shared chart helpers (mirrors stats.ts logic for consistency)
// ---------------------------------------------------------------------------

const TIME_PERIODS = [
  { key: "morning",   label: "Morning" },
  { key: "afternoon", label: "Afternoon" },
  { key: "evening",   label: "Evening" },
  { key: "night",     label: "Night" },
];


function renderLineChart(
  dailyMinutes: { date: string; minutes: number }[],
  totalMinutes: number,
  periodMins: Record<string, number>,
): string {
  const W = 600; const H = 130;
  const PAD = { top: 16, right: 16, bottom: 30, left: 46 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const values = dailyMinutes.map(d => d.minutes);
  const maxVal = Math.max(...values, 1);

  const xPos = (i: number) =>
    PAD.left + (values.length <= 1 ? chartW / 2 : (i / (values.length - 1)) * chartW);
  const yPos = (v: number) =>
    PAD.top + chartH - (v / maxVal) * chartH;

  const linePoints = values.map((v, i) => `${xPos(i)},${yPos(v)}`).join(" ");
  const areaPoints = [
    `${xPos(0)},${PAD.top + chartH}`,
    ...values.map((v, i) => `${xPos(i)},${yPos(v)}`),
    `${xPos(values.length - 1)},${PAD.top + chartH}`,
  ].join(" ");

  const yTicks = [0, Math.round(maxVal / 2), maxVal].map(v => ({
    v, y: yPos(v), label: fmtMinutes(v),
  }));

  const labelStep = Math.max(1, Math.floor(values.length / 6));
  const xLabels = dailyMinutes.map((d, i) => {
    if (i % labelStep !== 0 && i !== values.length - 1) return "";
    const parts = d.date.split("-");
    return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
  });

  const svgHtml = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         class="pomo-line-chart" preserveAspectRatio="none">
      <defs>
        <linearGradient id="friendAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#6366f1" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#6366f1" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      ${yTicks.map(t =>
        `<line x1="${PAD.left}" y1="${t.y}" x2="${W - PAD.right}" y2="${t.y}"
               stroke="var(--border-soft)" stroke-width="1"/>`
      ).join("")}
      <polygon points="${areaPoints}" fill="url(#friendAreaGrad)"/>
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

  const maxPeriod = Math.max(...Object.values(periodMins), 1);
  const distributionHtml = `
    <div class="pomo-period-grid">
      ${TIME_PERIODS.map(p => {
        const mins = periodMins[p.key] ?? 0;
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

  return `
    <div class="pomo-total-label">Total: <strong>${fmtMinutes(totalMinutes)}</strong></div>
    ${totalMinutes > 0 ? svgHtml : ""}
    ${totalMinutes > 0 ? `<p class="pomo-dist-title">Time of day</p>${distributionHtml}` : ""}`;
}

// ---------------------------------------------------------------------------
// Friend stats panel
// ---------------------------------------------------------------------------

async function showFriendStats(friend: FriendEntry): Promise<void> {
  friendStatsPanel.innerHTML = `
    <div class="friend-stats-header">
      <strong>${escapeHtml(friend.username)}</strong>
      <div class="days-selector">
        ${[7, 30, 90].map(d =>
          `<button class="days-btn friend-days-btn${d === selectedFriendDays ? " active" : ""}"
                   data-days="${d}" data-uid="${friend.user_id}">${d} days</button>`
        ).join("")}
      </div>
    </div>
    <div class="hint" style="padding:0.5rem 0">Loading…</div>`;
  friendStatsPanel.classList.remove("hidden");

  friendStatsPanel.querySelectorAll<HTMLButtonElement>(".friend-days-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      selectedFriendDays = Number(btn.dataset.days);
      await showFriendStats(friend);
    });
  });

  try {
    const stats = await getFriendStudyStats(friend.user_id, selectedFriendDays);
    renderFriendStatsContent(stats);
  } catch {
    friendStatsPanel.querySelector(".hint")!.textContent = "Failed to load stats.";
  }
}

function renderFriendStatsContent(stats: FriendStudyStats): void {
  const chartHtml = stats.total_minutes === 0
    ? `<div class="empty-state">No study sessions in this period.</div>`
    : renderLineChart(stats.daily_minutes, stats.total_minutes, stats.period_minutes);

  const header = friendStatsPanel.querySelector(".friend-stats-header");
  friendStatsPanel.innerHTML = "";
  if (header) friendStatsPanel.appendChild(header);

  // Re-render header with correct selected state, then add chart
  friendStatsPanel.innerHTML = `
    <div class="friend-stats-header">
      <strong>${escapeHtml(stats.username)}</strong>
      <div class="days-selector">
        ${[7, 30, 90].map(d =>
          `<button class="days-btn friend-days-btn${d === selectedFriendDays ? " active" : ""}"
                   data-days="${d}" data-uid="${stats.user_id}">${d} days</button>`
        ).join("")}
      </div>
    </div>
    ${chartHtml}`;

  friendStatsPanel.querySelectorAll<HTMLButtonElement>(".friend-days-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      selectedFriendDays = Number(btn.dataset.days);
      const uid = Number(btn.dataset.uid);
      const friend = friends.find(f => f.user_id === uid);
      if (friend) await showFriendStats(friend);
    });
  });
}

// ---------------------------------------------------------------------------
// Render sections
// ---------------------------------------------------------------------------

function renderRequests(): void {
  if (requests.length === 0) {
    friendRequestsList.innerHTML = `<div class="empty-state">No pending requests.</div>`;
    return;
  }
  friendRequestsList.innerHTML = requests.map(r => `
    <div class="friend-row" data-uid="${r.user_id}">
      <span class="friend-name">${escapeHtml(r.username)}</span>
      <div class="friend-actions">
        <button class="btn-accept" data-uid="${r.user_id}">Accept</button>
        <button class="secondary btn-decline" data-uid="${r.user_id}">Decline</button>
      </div>
    </div>`).join("");

  friendRequestsList.querySelectorAll<HTMLButtonElement>(".btn-accept").forEach(btn => {
    btn.addEventListener("click", async () => {
      await acceptFriendRequest(Number(btn.dataset.uid));
      await refresh();
    });
  });
  friendRequestsList.querySelectorAll<HTMLButtonElement>(".btn-decline").forEach(btn => {
    btn.addEventListener("click", async () => {
      await removeFriend(Number(btn.dataset.uid));
      await refresh();
    });
  });
}

function renderFriends(): void {
  if (friends.length === 0) {
    friendsList.innerHTML = `<div class="empty-state">No friends yet. Search for a user above.</div>`;
    return;
  }
  friendsList.innerHTML = friends.map(f => `
    <div class="friend-row" data-uid="${f.user_id}">
      <span class="friend-name">${escapeHtml(f.username)}</span>
      <div class="friend-actions">
        <button class="secondary btn-view-stats" data-uid="${f.user_id}">View stats</button>
        <button class="secondary btn-remove" data-uid="${f.user_id}">Remove</button>
      </div>
    </div>`).join("");

  friendsList.querySelectorAll<HTMLButtonElement>(".btn-view-stats").forEach(btn => {
    btn.addEventListener("click", async () => {
      const uid = Number(btn.dataset.uid);
      const friend = friends.find(f => f.user_id === uid);
      if (friend) await showFriendStats(friend);
    });
  });
  friendsList.querySelectorAll<HTMLButtonElement>(".btn-remove").forEach(btn => {
    btn.addEventListener("click", async () => {
      await removeFriend(Number(btn.dataset.uid));
      friendStatsPanel.classList.add("hidden");
      await refresh();
    });
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function handleSearch(): Promise<void> {
  const q = friendSearchInput.value.trim();
  if (!q) return;
  friendSearchResults.innerHTML = `<div class="hint">Searching…</div>`;
  try {
    const results = await searchUsers(q);
    if (results.length === 0) {
      friendSearchResults.innerHTML = `<div class="empty-state">No users found.</div>`;
      return;
    }
    friendSearchResults.innerHTML = results.map(u => `
      <div class="friend-row">
        <span class="friend-name">${escapeHtml(u.username)}</span>
        <button class="secondary btn-add" data-username="${escapeHtml(u.username)}">Add friend</button>
      </div>`).join("");

    friendSearchResults.querySelectorAll<HTMLButtonElement>(".btn-add").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const res = await sendFriendRequest(btn.dataset.username!);
          btn.textContent = res.status === "accepted" ? "Friends!" : "Request sent";
          await refresh();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Error";
          setMessage(friendSearchMessage, msg, "error");
          btn.disabled = false;
        }
      });
    });
  } catch {
    friendSearchResults.innerHTML = `<div class="empty-state">Search failed.</div>`;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function refresh(): Promise<void> {
  try {
    [friends, requests] = await Promise.all([listFriends(), listFriendRequests()]);
    renderRequests();
    renderFriends();
  } catch (e) {
    console.error(e);
  }
}

export function init(_onRefreshNeeded: () => Promise<void>): void {
  friendSearchInput   = document.querySelector<HTMLInputElement>("#friend-search-input")!;
  friendSearchButton  = document.querySelector<HTMLButtonElement>("#friend-search-button")!;
  friendSearchResults = document.querySelector<HTMLDivElement>("#friend-search-results")!;
  friendRequestsList  = document.querySelector<HTMLDivElement>("#friend-requests-list")!;
  friendsList         = document.querySelector<HTMLDivElement>("#friends-list")!;
  friendStatsPanel    = document.querySelector<HTMLDivElement>("#friend-stats-panel")!;
  friendSearchMessage = document.querySelector<HTMLParagraphElement>("#friend-search-message")!;

  friendSearchButton.addEventListener("click", handleSearch);
  friendSearchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") void handleSearch();
  });
}
