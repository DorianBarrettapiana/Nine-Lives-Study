/**
 * Friends view.
 *
 * Search users → send request; accept/decline incoming requests;
 * view friends list with daily study durations.
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
import { escapeHtml, fmtMinutes, makeDateLabel, setMessage } from "../utils";

let friendSearchInput: HTMLInputElement;
let friendSearchButton: HTMLButtonElement;
let friendSearchResults: HTMLDivElement;
let friendRequestsList: HTMLDivElement;
let friendsList: HTMLDivElement;
let friendStatsPanel: HTMLDivElement;
let friendSearchMessage: HTMLParagraphElement;
let friendSearchCard: HTMLElement;
let friendRequestsCard: HTMLElement;
let friendRequestsBadge: HTMLSpanElement;

let friends: FriendEntry[] = [];
let requests: FriendRequestEntry[] = [];
let selectedFriendDays = 7;

// ---------------------------------------------------------------------------
// Friend stats panel
// ---------------------------------------------------------------------------

function renderDailyList(stats: FriendStudyStats): string {
  if (stats.total_minutes === 0) {
    return `<div class="empty-state">No study sessions in this period.</div>`;
  }
  const rows = [...stats.daily_minutes].reverse().map(d => {
    const label = makeDateLabel(d.date);
    return `
      <div class="friend-day-row">
        <span class="friend-day-date">${label}</span>
        <span class="friend-day-mins">${fmtMinutes(d.minutes)}</span>
      </div>`;
  }).join("");

  return `
    <div class="friend-total-label">Total: <strong>${fmtMinutes(stats.total_minutes)}</strong></div>
    <div class="friend-daily-list">${rows}</div>`;
}

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

  bindDayButtons(friend);

  try {
    const stats = await getFriendStudyStats(friend.user_id, selectedFriendDays);
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
      ${renderDailyList(stats)}`;
    bindDayButtons(friend);
  } catch {
    friendStatsPanel.querySelector(".hint")!.textContent = "Failed to load stats.";
  }
}

function bindDayButtons(friend: FriendEntry): void {
  friendStatsPanel.querySelectorAll<HTMLButtonElement>(".friend-days-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      selectedFriendDays = Number(btn.dataset.days);
      const uid = Number(btn.dataset.uid);
      const f = friends.find(x => x.user_id === uid) ?? friend;
      await showFriendStats(f);
    });
  });
}

// ---------------------------------------------------------------------------
// Render sections
// ---------------------------------------------------------------------------

function renderRequests(): void {
  if (requests.length === 0) {
    friendRequestsCard.classList.add("hidden");
    return;
  }
  friendRequestsCard.classList.remove("hidden");
  friendRequestsBadge.textContent = String(requests.length);
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

function setupCollapsible(card: HTMLElement): void {
  const header = card.querySelector<HTMLElement>(".collapsible-header")!;
  const body = card.querySelector<HTMLElement>(".collapsible-body")!;
  const arrow = card.querySelector<HTMLElement>(".collapse-arrow")!;
  header.addEventListener("click", () => {
    const open = !body.classList.contains("hidden");
    body.classList.toggle("hidden", open);
    arrow.textContent = open ? "▸" : "▾";
  });
}

export function init(_onRefreshNeeded: () => Promise<void>): void {
  friendSearchInput   = document.querySelector<HTMLInputElement>("#friend-search-input")!;
  friendSearchButton  = document.querySelector<HTMLButtonElement>("#friend-search-button")!;
  friendSearchResults = document.querySelector<HTMLDivElement>("#friend-search-results")!;
  friendRequestsList  = document.querySelector<HTMLDivElement>("#friend-requests-list")!;
  friendsList         = document.querySelector<HTMLDivElement>("#friends-list")!;
  friendStatsPanel    = document.querySelector<HTMLDivElement>("#friend-stats-panel")!;
  friendSearchMessage = document.querySelector<HTMLParagraphElement>("#friend-search-message")!;
  friendSearchCard    = document.querySelector<HTMLElement>("#friend-search-card")!;
  friendRequestsCard  = document.querySelector<HTMLElement>("#friend-requests-card")!;
  friendRequestsBadge = document.querySelector<HTMLSpanElement>("#friend-requests-badge")!;

  setupCollapsible(friendSearchCard);
  setupCollapsible(friendRequestsCard);

  friendSearchButton.addEventListener("click", handleSearch);
  friendSearchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") void handleSearch();
  });
}
