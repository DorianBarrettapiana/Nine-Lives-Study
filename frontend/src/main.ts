/**
 * Frontend entry point.
 */

import "./style.css";
import { createUser, listUsers, type UserRead } from "./api/users";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Could not find #app root element.");
}

app.innerHTML = `
  <div class="container">
    <h1>PhDStudyLab</h1>
    <p class="subtitle">Frontend HTML/CSS/TypeScript + Backend Python</p>

    <section class="card">
      <h2>Create a user</h2>
      <form id="user-form" class="form">
        <label>
          Username
          <input id="username" type="text" placeholder="Enter a username" required />
        </label>

        <label>
          Language
          <select id="language">
            <option value="en">English</option>
            <option value="fr">Français</option>
            <option value="zh">中文</option>
          </select>
        </label>

        <label>
          Theme
          <select id="theme">
            <option value="dark">dark</option>
            <option value="light">light</option>
          </select>
        </label>

        <button type="submit">Create user</button>
      </form>
      <p id="message" class="message"></p>
    </section>

    <section class="card">
      <h2>Users</h2>
      <button id="refresh-users">Refresh users</button>
      <ul id="users-list" class="users-list"></ul>
    </section>
  </div>
`;

const userForm = document.querySelector<HTMLFormElement>("#user-form");
const usernameInput = document.querySelector<HTMLInputElement>("#username");
const languageSelect = document.querySelector<HTMLSelectElement>("#language");
const themeSelect = document.querySelector<HTMLSelectElement>("#theme");
const message = document.querySelector<HTMLParagraphElement>("#message");
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh-users");
const usersList = document.querySelector<HTMLUListElement>("#users-list");

if (!userForm || !usernameInput || !languageSelect || !themeSelect || !message || !refreshButton || !usersList) {
  throw new Error("Could not find one or more DOM elements.");
}

function renderUsers(users: UserRead[]): void {
  if (users.length === 0) {
    usersList.innerHTML = `<li>No users yet.</li>`;
    return;
  }

  usersList.innerHTML = users
    .map(
      (user) => `
        <li>
          <strong>${user.username}</strong>
          <span>language=${user.language}</span>
          <span>theme=${user.theme}</span>
          <span>active=${user.is_active}</span>
        </li>
      `,
    )
    .join("");
}

async function refreshUsers(): Promise<void> {
  try {
    const users = await listUsers();
    renderUsers(users);
  } catch (error) {
    console.error(error);
    message.textContent = "Could not load users.";
    message.className = "message error";
  }
}

userForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const username = usernameInput.value.trim();
  const language = languageSelect.value;
  const theme = themeSelect.value;

  if (!username) {
    message.textContent = "Username is required.";
    message.className = "message error";
    return;
  }

  try {
    const user = await createUser({
      username,
      language,
      theme,
    });

    message.textContent = `User created: ${user.username}`;
    message.className = "message success";
    userForm.reset();
    await refreshUsers();
  } catch (error) {
    console.error(error);
    message.textContent = "Could not create user.";
    message.className = "message error";
  }
});

refreshButton.addEventListener("click", async () => {
  await refreshUsers();
});

void refreshUsers();