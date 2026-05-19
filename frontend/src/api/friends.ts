/**
 * Friends API functions.
 */

import { apiFetch } from "./client";

export interface UserSearchResult {
  id: number;
  username: string;
}

export interface FriendEntry {
  user_id: number;
  username: string;
}

export interface FriendRequestEntry {
  user_id: number;
  username: string;
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
  period_minutes: Record<string, number>;
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
  return apiFetch<FriendStudyStats>(`/friends/${userId}/study-stats?days=${days}`);
}
