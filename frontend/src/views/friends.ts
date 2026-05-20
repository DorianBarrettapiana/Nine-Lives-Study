/**
 * Friends view.
 *
 * Search users → send request; accept/decline incoming requests;
 * view friends list with daily study durations.
 */

import {
  acceptFriendRequest,
  cheerFriend,
  getFeed,
  getFriendStudyStats,
  getNotifications,
  listFriendRequests,
  listFriends,
  markNotificationsRead,
  removeFriend,
  searchUsers,
  sendFriendRequest,
  toggleLike,
  type FeedItem,
  type FriendEntry,
  type FriendRequestEntry,
  type FriendStudyStats,
  type NotificationItem,
} from "../api/friends";
import { escapeHtml, fmtMinutes, parseApiDate, setMessage } from "../utils";
import { renderAvatarSvg } from "./avatar";
import { renderBeerIconSvg, renderEmptyStateWithCat, renderFlowerIconSvg } from "./icons";

function avatarRowHtml(skin: string, sizePx = 26): string {
  return `<span class="avatar avatar-sm row-avatar">${renderAvatarSvg(skin, sizePx)}</span>`;
}

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
let friendFeed: HTMLDivElement;

let friends: FriendEntry[] = [];
let requests: FriendRequestEntry[] = [];
let selectedFriendDays = 7;

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

const EVENT_LABELS: Record<string, string> = {
  pomodoro_done: "completed a pomodoro session",
  task_done: "completed a task",
  daily_log: "wrote a daily log",
  feynman: "added a Feynman entry",
  note: "added a paper note",
  mood: "recorded their mood",
  mood_logged: "recorded their mood",
};

// For "X liked your <noun>" notifications, what noun to use per event type.
// Keep these short and human — they read inline.
const LIKED_OBJECT: Record<string, string> = {
  pomodoro_done: "pomodoro session",
  task_done: "completed task",
  daily_log: "daily log",
  daily_log_saved: "daily log",
  feynman: "Feynman entry",
  feynman_created: "Feynman entry",
  note: "paper note",
  note_created: "paper note",
  mood: "mood log",
  mood_logged: "mood log",
};

// Build the full notification sentence (everything after "<username> ...").
// Returns { icon, body } so the caller can place the icon outside <strong>.
function notifMessage(n: NotificationItem): { icon: string; body: string } {
  if (n.event_type === "cheered_you") {
    // Match the cheer button's beer icon for consistency across the feature.
    return { icon: renderBeerIconSvg(2), body: "sent you a cheer (+1 XP)" };
  }
  const obj = LIKED_OBJECT[n.event_type] ?? "activity";
  return { icon: "🌸", body: `liked your ${obj}` };
}

// How many notifs / feed items to show before "Show more". Match-ish to
// give the panel a stable preview size.
const NOTIFS_PREVIEW = 4;
const FEED_PREVIEW = 5;
let notifsExpanded = false;
let feedExpanded = false;

function timeAgo(isoStr: string): string {
  const dt = parseApiDate(isoStr);
  const diff = Math.max(0, Date.now() - dt.getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Track latest data so the show-more toggles can re-render without re-fetching.
let lastFeedItems: FeedItem[] = [];
let lastNotifs: NotificationItem[] = [];

function renderFeed(items: FeedItem[], notifs: NotificationItem[] = []): void {
  lastFeedItems = items;
  lastNotifs = notifs;

  if (items.length === 0 && notifs.length === 0) {
    friendFeed.innerHTML = renderEmptyStateWithCat("No activity yet.");
    return;
  }

  // --- Notifications block (collapsible) -------------------------------
  let notifHtml = "";
  if (notifs.length > 0) {
    const showN = notifsExpanded ? notifs.length : Math.min(notifs.length, NOTIFS_PREVIEW);
    const visible = notifs.slice(0, showN);
    const hiddenCount = notifs.length - showN;
    notifHtml = `
      <div class="feed-notifs">
        ${visible.map(n => {
          const { icon, body } = notifMessage(n);
          return `<div class="feed-notif-item">
            <span class="notif-icon">${icon}</span>${avatarRowHtml(n.liker_cat_skin)}<strong>${escapeHtml(n.liker_username)}</strong> ${body}
            <span class="feed-time">${timeAgo(n.created_at)}</span>
          </div>`;
        }).join("")}
        ${(notifs.length > NOTIFS_PREVIEW)
          ? `<button type="button" class="show-more-toggle" data-toggle="notifs">${
              notifsExpanded ? "Show less ▴" : `Show ${hiddenCount} more ▾`
            }</button>`
          : ""}
      </div>`;
  }

  // --- Activity feed block (collapsible) -------------------------------
  const showM = feedExpanded ? items.length : Math.min(items.length, FEED_PREVIEW);
  const visibleItems = items.slice(0, showM);
  const hiddenItems = items.length - showM;
  const feedHtml = visibleItems.map(item => {
    const label = EVENT_LABELS[item.event_type] ?? item.event_type;
    const likedClass = item.liked_by_me ? " liked" : "";
    return `
      <div class="feed-item">
        <div class="feed-item-content">
          ${avatarRowHtml(item.cat_skin)}<strong>${escapeHtml(item.username)}</strong> ${label}
          <span class="feed-time">${timeAgo(item.created_at)}</span>
        </div>
        <button class="feed-like-btn${likedClass}" data-eid="${item.id}" title="Like">
          <span class="flower-icon">${renderFlowerIconSvg(2)}</span>
          <span class="like-count">${item.like_count || ""}</span>
        </button>
      </div>`;
  }).join("");
  const feedToggle = items.length > FEED_PREVIEW
    ? `<button type="button" class="show-more-toggle" data-toggle="feed">${
        feedExpanded ? "Show less ▴" : `Show ${hiddenItems} more ▾`
      }</button>`
    : "";

  friendFeed.innerHTML = notifHtml + feedHtml + feedToggle;

  friendFeed.querySelectorAll<HTMLButtonElement>(".feed-like-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const eid = Number(btn.dataset.eid);
      const res = await toggleLike(eid);
      btn.classList.toggle("liked", res.liked);
      const countEl = btn.querySelector<HTMLSpanElement>(".like-count")!;
      const cur = parseInt(countEl.textContent || "0") || 0;
      const next = res.liked ? cur + 1 : Math.max(0, cur - 1);
      countEl.textContent = next ? String(next) : "";
    });
  });

  friendFeed.querySelectorAll<HTMLButtonElement>(".show-more-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.toggle === "notifs") notifsExpanded = !notifsExpanded;
      else if (btn.dataset.toggle === "feed") feedExpanded = !feedExpanded;
      renderFeed(lastFeedItems, lastNotifs);
    });
  });
}

// ---------------------------------------------------------------------------
// Friend stats panel
// ---------------------------------------------------------------------------

function renderLineChart(stats: FriendStudyStats): string {
  if (stats.total_minutes === 0) {
    return `<div class="empty-state">No study sessions in this period.</div>`;
  }

  const W = 600; const H = 140;
  const PAD = { top: 16, right: 16, bottom: 30, left: 46 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const values = stats.daily_minutes.map(d => d.minutes);
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
    y: yPos(v), label: fmtMinutes(v),
  }));

  const labelStep = Math.max(1, Math.floor(values.length / 6));
  const xLabels = stats.daily_minutes.map((d, i) => {
    if (i % labelStep !== 0 && i !== values.length - 1) return "";
    const parts = d.date.split("-");
    return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
  });

  return `
    <div class="friend-total-label">Total: <strong>${fmtMinutes(stats.total_minutes)}</strong></div>
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
}

async function showFriendStats(friend: FriendEntry): Promise<void> {
  friendStatsPanel.innerHTML = `
    <div class="friend-stats-header">
      <strong>${avatarRowHtml(friend.cat_skin, 32)}${escapeHtml(friend.username)}</strong>
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
        <strong>${avatarRowHtml(friend.cat_skin, 32)}${escapeHtml(stats.username)}</strong>
        <div class="days-selector">
          ${[7, 30, 90].map(d =>
            `<button class="days-btn friend-days-btn${d === selectedFriendDays ? " active" : ""}"
                     data-days="${d}" data-uid="${stats.user_id}">${d} days</button>`
          ).join("")}
        </div>
      </div>
      ${renderLineChart(stats)}`;
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
      <span class="friend-name">${avatarRowHtml(r.cat_skin)}${escapeHtml(r.username)}</span>
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
    friendsList.innerHTML = renderEmptyStateWithCat("No friends yet. Search for a user above.");
    return;
  }
  friendsList.innerHTML = friends.map(f => `
    <div class="friend-row" data-uid="${f.user_id}">
      <span class="friend-name">${avatarRowHtml(f.cat_skin)}${escapeHtml(f.username)}</span>
      <div class="friend-actions">
        <button class="btn-cheer${f.can_cheer ? "" : " disabled"}"
                data-cheer-uid="${f.user_id}"
                title="${f.can_cheer ? "Send a cheer (+1 XP to them, once a day)" : "Already cheered today"}"
                ${f.can_cheer ? "" : "disabled"}>
          ${renderBeerIconSvg(2)} Cheer
        </button>
        <button class="secondary btn-view-stats" data-uid="${f.user_id}">View stats</button>
        <button class="btn-remove-small" data-uid="${f.user_id}" title="Remove friend">&times;</button>
      </div>
    </div>`).join("");

  friendsList.querySelectorAll<HTMLButtonElement>(".btn-view-stats").forEach(btn => {
    btn.addEventListener("click", async () => {
      const uid = Number(btn.dataset.uid);
      const friend = friends.find(f => f.user_id === uid);
      if (friend) await showFriendStats(friend);
    });
  });
  friendsList.querySelectorAll<HTMLButtonElement>(".btn-remove-small").forEach(btn => {
    btn.addEventListener("click", async () => {
      await removeFriend(Number(btn.dataset.uid));
      friendStatsPanel.classList.add("hidden");
      await refresh();
    });
  });
  friendsList.querySelectorAll<HTMLButtonElement>(".btn-cheer").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const uid = Number(btn.dataset.cheerUid);
      try {
        await cheerFriend(uid);
        btn.classList.add("disabled");
        btn.title = "Already cheered today";
        // Optimistic refresh: the local state lags the server's can_cheer
        // bit until the next listFriends. Re-fetch so the row is consistent.
        await refresh();
      } catch (e) {
        btn.disabled = false;
        setMessage(friendSearchMessage, parseApiDetail(e), "error");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function friendStatus(username: string): "friend" | "pending" | null {
  if (friends.some(f => f.username === username)) return "friend";
  if (requests.some(r => r.username === username)) return "pending";
  return null;
}

function parseApiDetail(e: unknown): string {
  if (e instanceof Error && "body" in e) {
    try {
      const parsed = JSON.parse((e as { body: string }).body);
      if (parsed.detail) return parsed.detail;
    } catch { /* use fallback */ }
  }
  return e instanceof Error ? e.message : "Error";
}

async function handleSearch(): Promise<void> {
  const q = friendSearchInput.value.trim();
  if (!q) return;
  friendSearchResults.innerHTML = `<div class="hint">Searching…</div>`;
  setMessage(friendSearchMessage, "", "neutral");
  try {
    const results = await searchUsers(q);
    if (results.length === 0) {
      friendSearchResults.innerHTML = `<div class="empty-state">No users found.</div>`;
      return;
    }
    friendSearchResults.innerHTML = results.map(u => {
      const status = friendStatus(u.username);
      const nameHtml = `${avatarRowHtml(u.cat_skin)}${escapeHtml(u.username)}`;
      if (status === "friend") {
        return `<div class="friend-row">
          <span class="friend-name">${nameHtml}</span>
          <span class="friend-status-label">Already friends</span>
        </div>`;
      }
      if (status === "pending") {
        return `<div class="friend-row">
          <span class="friend-name">${nameHtml}</span>
          <span class="friend-status-label">Request pending</span>
        </div>`;
      }
      return `<div class="friend-row">
        <span class="friend-name">${nameHtml}</span>
        <button class="secondary btn-add" data-username="${escapeHtml(u.username)}">Add friend</button>
      </div>`;
    }).join("");

    friendSearchResults.querySelectorAll<HTMLButtonElement>(".btn-add").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const res = await sendFriendRequest(btn.dataset.username!);
          btn.textContent = res.status === "accepted" ? "Friends!" : "Request sent";
          await refresh();
        } catch (e: unknown) {
          setMessage(friendSearchMessage, parseApiDetail(e), "error");
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
    const [f, r, feed, notifs] = await Promise.all([
      listFriends(), listFriendRequests(), getFeed(), getNotifications(),
    ]);
    friends = f;
    requests = r;
    renderRequests();
    renderFriends();
    renderFeed(feed, notifs.items);
    updateNotifBadge(notifs.unread_count);
  } catch (e) {
    console.error(e);
  }
}

/**
 * Call when the user actually opens the Friends tab. Marks notifications as
 * read on the server and clears the in-tab unread badge optimistically.
 */
export async function onViewActivated(): Promise<void> {
  try {
    await markNotificationsRead();
  } catch (e) {
    console.error(e);
    return;
  }
  updateNotifBadge(0);
}

function updateNotifBadge(count: number): void {
  const tab = document.querySelector<HTMLButtonElement>('.feature-tab[data-view="friends"]');
  if (!tab) return;
  let badge = tab.querySelector<HTMLSpanElement>(".tab-badge");
  if (count > 0) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "tab-badge";
      tab.appendChild(badge);
    }
    badge.textContent = String(count);
  } else {
    badge?.remove();
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
  friendFeed          = document.querySelector<HTMLDivElement>("#friend-feed")!;
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
