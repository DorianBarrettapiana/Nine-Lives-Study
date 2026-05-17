/**
 * User & auth API functions.
 */

import { apiFetch } from "./client";

export interface UserRead {
  id: number;
  username: string;
  language: string;
  theme: string;
  is_active: boolean;
}

export interface RegisterPayload {
  username: string;
  password: string;
  invite_code: string;
  language?: string;
  theme?: string;
}

export interface LoginPayload {
  username: string;
  password: string;
}

export interface UserUpdate {
  language?: string;
  theme?: string;
}

export async function register(payload: RegisterPayload): Promise<UserRead> {
  return apiFetch<UserRead>("/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function login(payload: LoginPayload): Promise<UserRead> {
  return apiFetch<UserRead>("/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function logout(): Promise<void> {
  await apiFetch<void>("/auth/logout", { method: "POST" });
}

export async function getMe(): Promise<UserRead> {
  return apiFetch<UserRead>("/auth/me");
}

export async function updateMe(payload: UserUpdate): Promise<UserRead> {
  return apiFetch<UserRead>("/users/me", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteMe(): Promise<void> {
  await apiFetch<void>("/users/me", { method: "DELETE" });
}
