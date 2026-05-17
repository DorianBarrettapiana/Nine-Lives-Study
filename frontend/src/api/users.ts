/**
 * User API functions.
 */

import { apiFetch } from "./client";

export interface UserRead {
  id: number;
  username: string;
  language: string;
  theme: string;
  is_active: boolean;
}

export interface UserCreate {
  username: string;
  language: string;
  theme: string;
}

export interface UserUpdate {
  language?: string;
  theme?: string;
  is_active?: boolean;
}

export async function listUsers(): Promise<UserRead[]> {
  return apiFetch<UserRead[]>("/users");
}

export async function getUser(userId: number): Promise<UserRead> {
  return apiFetch<UserRead>(`/users/${userId}`);
}

export async function createUser(payload: UserCreate): Promise<UserRead> {
  return apiFetch<UserRead>("/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateUser(userId: number, payload: UserUpdate): Promise<UserRead> {
  return apiFetch<UserRead>(`/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteUser(userId: number): Promise<void> {
  await apiFetch<void>(`/users/${userId}`, { method: "DELETE" });
}