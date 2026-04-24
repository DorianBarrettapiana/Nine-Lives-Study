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

export async function listUsers(): Promise<UserRead[]> {
  return apiFetch<UserRead[]>("/users");
}

export async function createUser(payload: UserCreate): Promise<UserRead> {
  return apiFetch<UserRead>("/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}