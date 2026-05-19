/**
 * Friends API functions.
 */

import { apiFetch } from "./client";

export interface UserSearchResult {
  id: number;
  username: string;
  cat_skin: string;
}

export interface FriendEntry {
  user_id: number;
  username: string;
  cat_skin: string;
}

export interface FriendRequestEntry {
  user_id: number;
  username: string;
  cat_skin: string;
}

export interface DailyMinutes {
  date: string;
  minutes: number;
}

export interface FriendStudyStats {
  user_id: number;
  username: string;
  days: number;
  daily_minutes: DailyMinutes[];
  total_minutes: number;
}

export async function searchUsers(q: string): Promise<UserSearchResult[]> {
  return apiFetch<UserSearchResult[]>(`/users/search?q=${encodeURIComponent(q)}`);
}

export async function listFriends(): Promise<FriendEntry[]> {
  return apiFetch<FriendEntry[]>("/friends");
}

export async function listFriendRequests(): Promise<FriendRequestEntry[]> {
  return apiFetch<FriendRequestEntry[]>("/friends/requests");
}

export async function sendFriendRequest(username: string): Promise<{ status: string }> {
  return apiFetch<{ status: string }>("/friends", {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

export async function acceptFriendRequest(userId: number): Promise<{ status: string }> {
  return apiFetch<{ status: string }>(`/friends/${userId}/accept`, { method: "POST" });
}

export async function removeFriend(userId: number): Promise<void> {
  await apiFetch<void>(`/friends/${userId}`, { method: "DELETE" });
}

export async function getFriendStudyStats(userId: number, days = 7): Promise<FriendStudyStats> {
  const tz = new Date().getTimezoneOffset() * -1;
  return apiFetch<FriendStudyStats>(`/friends/${userId}/study-stats?days=${days}&tz_offset=${tz}`);
}

export interface FeedItem {
  id: number;
  user_id: number;
  username: string;
  cat_skin: string;
  event_type: string;
  amount: number;
  created_at: string;
  like_count: number;
  liked_by_me: boolean;
  cheer_count: number;
  cheered_by_me: boolean;
}

export async function getFeed(limit = 30): Promise<FeedItem[]> {
  return apiFetch<FeedItem[]>(`/friends/feed?limit=${limit}`);
}

export async function toggleLike(eventId: number): Promise<{ liked: boolean }> {
  return apiFetch<{ liked: boolean }>(`/friends/feed/${eventId}/like`, { method: "POST" });
}

export async function cheerEvent(eventId: number): Promise<{ cheered: boolean; already: boolean }> {
  return apiFetch<{ cheered: boolean; already: boolean }>(`/friends/feed/${eventId}/cheer`, { method: "POST" });
}

export interface NotificationItem {
  liker_username: string;
  liker_cat_skin: string;
  event_type: string;
  created_at: string;
}

export interface NotificationsResponse {
  unread_count: number;
  items: NotificationItem[];
}

export async function getNotifications(): Promise<NotificationsResponse> {
  return apiFetch<NotificationsResponse>("/friends/notifications");
}

export async function markNotificationsRead(): Promise<void> {
  await apiFetch<void>("/friends/notifications/read", { method: "POST" });
}
