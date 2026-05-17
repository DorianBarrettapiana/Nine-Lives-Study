# Nine Lives Study — User Guide

This is a guide for **end users** of the app. For developer setup, see [DEVELOPMENT.md](DEVELOPMENT.md). For server administration, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Accessing the app

Open <https://ninelives.foussistan.fr> in any modern browser.

> The instance is currently single-tenant: there is no authentication, all users registered share the same database. Don't put sensitive data in there.

## First steps

1. **Pick or create a user.** In the left sidebar, the *Local user* card lets you choose an existing user from the dropdown or click *New user* to create one. The chosen user is remembered in your browser (localStorage), so you don't have to pick again on the same device.
2. **Pick a language.** French / English / 中文. Set once at user creation.
3. **Start using the tabs.**

## Features

### 📄 Paper notes

Lightweight literature notes — title, authors, year, key ideas, open questions, tags.

- Fill the form and click *Add note*.
- Saved notes appear below; click *Edit* to update one or *Delete* to remove it.

### 🧠 Feynman

A four-step guided record to test understanding of a concept:

1. **Choose a topic** — pick what you want to explain
2. **Explain it simply** — write it as if for a complete beginner
3. **Spot the gaps** — identify what you can't explain well
4. **Refine and simplify**

Use *Previous / Next* to navigate, *Reset* to start over. Records are listed below.

### 📅 Daily tracker

Three things per day:
- **Tasks** — add quick to-dos for today, tick them off
- **Mood** — pick an emoji
- **Reflection** — short journaling text

The progress bar at the top shows the % of tasks done today. Click *Save daily log* to commit the day's reflection.

### 🍅 Pomodoro

Standard 25 min work / 5 min break timer.

- *Start* / *Reset* buttons control it
- The mode badge (*Work* / *Break*) updates automatically
- Today's completed sessions appear below — each one grants XP

### 😊 Mood

Lightweight mood journal independent of the daily tracker — log mood multiple times a day.

- Pick an emoji + optional reflection text → *Record mood*
- History below, filterable to 7 / 30 / 90 days

### 📊 Stats

Overview of activity:
- Totals card with tasks done, pomodoros completed, XP earned
- Tasks / Pomodoro / Mood charts
- 7 / 30 / 90 day windows

### 🎮 XP & levels

Most actions grant XP:
- Finishing a task
- Completing a Pomodoro
- Logging a mood
- Adding a paper note / Feynman record
- Saving a daily reflection

XP fills the bar in the sidebar; reaching the threshold levels you up.

## Theming

Top-right ☀️ / 🌙 toggle switches between light and dark. The choice is saved per browser.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Could not load users. Is the backend running?" | Backend down, or you're offline | Refresh in a few minutes. If it persists, ping the admin. |
| Site doesn't load at all | DNS / proxy / cert issue | Try again later. Check <https://www.cloudflarestatus.com/>. |
| Lost your user | localStorage cleared | Just pick your user again in the dropdown — data is server-side. |
| Theme reset to light | localStorage cleared | Toggle to dark again. |

## Data & privacy

- All data is stored in a SQLite file on the server (no cloud, no analytics).
- The server is a personal PC at the admin's home. Availability is best-effort.
- Backups are the admin's responsibility — see [DEPLOYMENT.md](DEPLOYMENT.md#backups).
- There is no password protection currently — anyone with the URL can use the app. Don't put confidential data in it.
