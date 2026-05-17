/**
 * Authentication view: login + register screen shown before the app.
 */

import { login, register, type UserRead } from "../api/users";
import { ApiError } from "../api/client";
import { applyTheme } from "../theme";
import { setMessage } from "../utils";

type Mode = "login" | "register";

const AUTH_HTML = `
  <div class="auth-shell">
    <header class="auth-topbar">
      <h1>Nine Lives Study</h1>
      <button id="auth-theme-toggle" class="theme-toggle" title="Toggle theme">☀️</button>
    </header>

    <main class="auth-card-wrap">
      <section class="card auth-card">
        <div class="auth-tabs">
          <button id="auth-tab-login" class="auth-tab active" data-mode="login">Log in</button>
          <button id="auth-tab-register" class="auth-tab" data-mode="register">Create account</button>
        </div>

        <form id="auth-form" class="form">
          <label>Username
            <input id="auth-username" type="text" autocomplete="username" required />
          </label>
          <label>Password
            <input id="auth-password" type="password" autocomplete="current-password" minlength="8" required />
          </label>

          <div id="auth-register-fields" class="hidden">
            <label>Invite code
              <input id="auth-invite-code" type="text" autocomplete="off" />
            </label>
            <label>Language
              <select id="auth-language">
                <option value="fr">Français</option>
                <option value="en" selected>English</option>
                <option value="zh">中文</option>
              </select>
            </label>
          </div>

          <button id="auth-submit" type="submit">Log in</button>
          <p id="auth-message" class="message"></p>
        </form>

        <p class="hint auth-hint">
          Your password is hashed on the server. Sessions are kept in an
          HTTP-only cookie — log out anytime to end your session.
        </p>
      </section>
    </main>
  </div>
`;

function updateThemeButton(button: HTMLButtonElement, theme: string): void {
  button.textContent = theme === "dark" ? "☀️" : "🌙";
  button.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

/**
 * Render the auth screen into #app and return a promise that resolves with
 * the authenticated user once the user logs in or registers successfully.
 */
export function showAuthScreen(root: HTMLDivElement): Promise<UserRead> {
  root.innerHTML = AUTH_HTML;

  const tabLogin = root.querySelector<HTMLButtonElement>("#auth-tab-login")!;
  const tabRegister = root.querySelector<HTMLButtonElement>("#auth-tab-register")!;
  const form = root.querySelector<HTMLFormElement>("#auth-form")!;
  const usernameInput = root.querySelector<HTMLInputElement>("#auth-username")!;
  const passwordInput = root.querySelector<HTMLInputElement>("#auth-password")!;
  const inviteInput = root.querySelector<HTMLInputElement>("#auth-invite-code")!;
  const languageSelect = root.querySelector<HTMLSelectElement>("#auth-language")!;
  const registerFields = root.querySelector<HTMLDivElement>("#auth-register-fields")!;
  const submitBtn = root.querySelector<HTMLButtonElement>("#auth-submit")!;
  const message = root.querySelector<HTMLParagraphElement>("#auth-message")!;
  const themeBtn = root.querySelector<HTMLButtonElement>("#auth-theme-toggle")!;

  let mode: Mode = "login";

  const setMode = (next: Mode): void => {
    mode = next;
    tabLogin.classList.toggle("active", mode === "login");
    tabRegister.classList.toggle("active", mode === "register");
    registerFields.classList.toggle("hidden", mode === "login");
    submitBtn.textContent = mode === "login" ? "Log in" : "Create account";
    passwordInput.autocomplete = mode === "login" ? "current-password" : "new-password";
    setMessage(message, "", "neutral");
  };

  tabLogin.addEventListener("click", () => setMode("login"));
  tabRegister.addEventListener("click", () => setMode("register"));

  themeBtn.addEventListener("click", () => {
    const isDark = !document.body.classList.contains("theme-light");
    const next = isDark ? "light" : "dark";
    applyTheme(next);
    updateThemeButton(themeBtn, next);
  });
  updateThemeButton(themeBtn, document.body.classList.contains("theme-light") ? "light" : "dark");

  usernameInput.focus();

  return new Promise<UserRead>((resolve) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const username = usernameInput.value.trim();
      const password = passwordInput.value;
      if (!username || !password) {
        setMessage(message, "Username and password are required.", "error");
        return;
      }
      submitBtn.disabled = true;
      try {
        let user: UserRead;
        if (mode === "login") {
          user = await login({ username, password });
        } else {
          const inviteCode = inviteInput.value.trim();
          if (!inviteCode) {
            setMessage(message, "Invite code is required to create an account.", "error");
            submitBtn.disabled = false;
            return;
          }
          user = await register({
            username,
            password,
            invite_code: inviteCode,
            language: languageSelect.value,
            theme: document.body.classList.contains("theme-light") ? "light" : "dark",
          });
        }
        resolve(user);
      } catch (error) {
        submitBtn.disabled = false;
        if (error instanceof ApiError) {
          let detail = error.body;
          try {
            const parsed = JSON.parse(error.body);
            if (parsed?.detail) detail = parsed.detail;
          } catch { /* keep raw body */ }
          setMessage(message, detail, "error");
        } else {
          console.error(error);
          setMessage(message, "Network error. Please try again.", "error");
        }
      }
    });
  });
}
