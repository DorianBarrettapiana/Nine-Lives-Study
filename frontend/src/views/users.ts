/**
 * User panel view.
 */

import { createUser, listUsers, type UserRead } from "../api/users";
import { escapeHtml, setMessage } from "../utils";
import { applyTheme } from "../theme";

const CURRENT_USER_ID_KEY = "phdstudylab_current_user_id";

let userSelect: HTMLSelectElement;
let selectUserButton: HTMLButtonElement;
let newUserToggle: HTMLButtonElement;
let userForm: HTMLFormElement;
let usernameInput: HTMLInputElement;
let languageSelect: HTMLSelectElement;
let userMessage: HTMLParagraphElement;
let currentUserLabel: HTMLDivElement;
let themeToggleButton: HTMLButtonElement;

let users: UserRead[] = [];
let currentUser: UserRead | null = null;

export function getCurrentUser(): UserRead | null { return currentUser; }
export function getUsers(): UserRead[] { return users; }

function getStoredUserId(): number | null {
  const raw = localStorage.getItem(CURRENT_USER_ID_KEY);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function storeCurrentUserId(userId: number): void {
  localStorage.setItem(CURRENT_USER_ID_KEY, String(userId));
}

function renderUserSelect(): void {
  userSelect.innerHTML = users.length === 0
    ? `<option value="">No user available</option>`
    : users.map((u) => `<option value="${u.id}">${escapeHtml(u.username)}</option>`).join("");
  if (currentUser) userSelect.value = String(currentUser.id);
}

function updateThemeButton(theme: string): void {
  if (!themeToggleButton) return;
  themeToggleButton.textContent = theme === "dark" ? "☀️" : "🌙";
  themeToggleButton.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

export function renderCurrentUser(): void {
  if (!currentUser) {
    currentUserLabel.textContent = "No user selected";
    currentUserLabel.className = "current-user warning";
    applyTheme("dark");
    updateThemeButton("dark");
    return;
  }
  currentUserLabel.textContent = currentUser.username;
  currentUserLabel.className = "current-user";
  applyTheme(currentUser.theme);
  updateThemeButton(currentUser.theme);
}

export async function refresh(): Promise<void> {
  try {
    users = await listUsers();
    const storedId = getStoredUserId();
    currentUser = storedId ? users.find((u) => u.id === storedId) ?? null : currentUser;
    if (!currentUser && users.length > 0) {
      currentUser = users[0];
      storeCurrentUserId(currentUser.id);
    }
    renderUserSelect();
    renderCurrentUser();
  } catch (error) {
    console.error(error);
    setMessage(userMessage, "Could not load users. Is the backend running?", "error");
  }
}

export function init(onUserChanged: () => Promise<void>): void {
  currentUserLabel = document.querySelector<HTMLDivElement>("#current-user-label")!;
  userSelect = document.querySelector<HTMLSelectElement>("#user-select")!;
  selectUserButton = document.querySelector<HTMLButtonElement>("#select-user-button")!;
  newUserToggle = document.querySelector<HTMLButtonElement>("#new-user-toggle")!;
  userForm = document.querySelector<HTMLFormElement>("#user-form")!;
  usernameInput = document.querySelector<HTMLInputElement>("#username")!;
  languageSelect = document.querySelector<HTMLSelectElement>("#language")!;
  userMessage = document.querySelector<HTMLParagraphElement>("#user-message")!;
  themeToggleButton = document.querySelector<HTMLButtonElement>("#theme-toggle-button")!;

  // Theme toggle — independent of user
  themeToggleButton.addEventListener("click", () => {
    const isDark = document.body.classList.contains("theme-dark") || !document.body.classList.contains("theme-light");
    const next = isDark ? "light" : "dark";
    applyTheme(next);
    updateThemeButton(next);
  });

  // New user form collapse toggle
  newUserToggle.addEventListener("click", () => {
    const isHidden = userForm.classList.contains("hidden");
    userForm.classList.toggle("hidden", !isHidden);
    newUserToggle.textContent = isHidden ? "− Cancel" : "+ New user";
    if (isHidden) usernameInput.focus();
  });

  userForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = usernameInput.value.trim();
    if (!username) { setMessage(userMessage, "Username is required.", "error"); return; }
    const activeTheme = document.body.classList.contains("theme-light") ? "light" : "dark";
    try {
      const user = await createUser({ username, language: languageSelect.value, theme: activeTheme });
      currentUser = user;
      storeCurrentUserId(user.id);
      setMessage(userMessage, `User created: ${user.username}`, "success");
      userForm.reset();
      userForm.classList.add("hidden");
      newUserToggle.textContent = "+ New user";
      await refresh();
      await onUserChanged();
    } catch (error) {
      console.error(error);
      setMessage(userMessage, "Could not create user. The username may already exist.", "error");
    }
  });

  selectUserButton.addEventListener("click", async () => {
    const selectedId = Number(userSelect.value);
    const selected = users.find((u) => u.id === selectedId);
    if (!selected) { setMessage(userMessage, "No valid user selected.", "error"); return; }
    currentUser = selected;
    storeCurrentUserId(selected.id);
    renderCurrentUser();
    setMessage(userMessage, `Selected user: ${selected.username}`, "success");
    await onUserChanged();
  });
}
