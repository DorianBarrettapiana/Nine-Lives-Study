# Nine Lives Study — Development Guide

Workflow, code layout, and conventions for contributing to the project.

For the production server, see [DEPLOYMENT.md](DEPLOYMENT.md). For end-user docs, see [USER.md](USER.md).

---

## 1. Prerequisites

- **Python** ≥ 3.10 (3.12 recommended)
- **Node.js** ≥ 18 with npm
- **Git**

A virtual env or conda env for Python is strongly recommended.

---

## 2. Repository layout

```
PhD-Study-Lab/
├── backend/
│   ├── app/
│   │   ├── api/routes/          ← FastAPI routers, one per feature
│   │   ├── core/                ← config, database engine, session helper
│   │   ├── models/              ← SQLAlchemy ORM models
│   │   ├── schemas/             ← Pydantic schemas (request/response shapes)
│   │   └── main.py              ← FastAPI app, CORS, router registration
│   ├── phdstudylab.db           ← SQLite (gitignored — local dev DB)
│   └── requirements.txt
│
├── frontend/
│   ├── src/
│   │   ├── api/                 ← Thin fetch wrappers, one per backend resource
│   │   ├── views/               ← Per-feature UI controllers (vanilla TS)
│   │   ├── main.html            ← App shell HTML (loaded as template)
│   │   ├── main.ts              ← Entry point, view router
│   │   ├── theme.ts             ← Theme toggle
│   │   ├── utils.ts             ← Shared helpers
│   │   └── style.css            ← Global styles
│   ├── .env.production          ← Build-time API base URL
│   ├── index.html               ← Vite entry
│   ├── package.json
│   └── tsconfig.json
│
├── deploy/                      ← Production server scripts (versioned)
│   ├── Caddyfile
│   ├── install-services.ps1
│   ├── start-backend.ps1
│   └── update-cloudflare.ps1
│
├── docs/
│   ├── USER.md
│   ├── DEVELOPMENT.md           ← (this file)
│   └── DEPLOYMENT.md
│
└── README.md
```

### Feature pattern

Each domain (paper notes, Feynman, daily tracker, Pomodoro, mood, stats, XP) follows the same pattern across the stack. All resource routes are **scoped to the authenticated user** via the `get_current_user` FastAPI dependency. Authentication itself lives in `app.core.auth` (password hashing, session creation, cookie helpers) and `app.api.routes.auth` (register/login/logout/me/password).

| Layer | File |
|---|---|
| ORM model         | `backend/app/models/<feature>.py` |
| Pydantic schemas  | `backend/app/schemas/<feature>.py` |
| API router        | `backend/app/api/routes/<feature>.py` (registered in `main.py`) |
| Frontend client   | `frontend/src/api/<feature>.ts` |
| Frontend view     | `frontend/src/views/<feature>.ts` |

When adding a new feature, copy one of the existing slices end-to-end and adjust.

---

## 3. Local setup

### Backend

```bash
cd backend
# create a fresh env (recommended)
conda create -n ninelives python=3.12
conda activate ninelives
pip install -r requirements.txt
```

The DB file is created on first run (SQLAlchemy `Base.metadata.create_all`).

### Env vars

| Variable | Default | Purpose |
|---|---|---|
| `INVITE_CODE` | (empty) | Required string for users to register via `POST /auth/register`. If empty, registration is disabled. |
| `COOKIE_SECURE` | `1` | If `1`, session cookie is `Secure` (HTTPS only). Set to `0` for local dev over HTTP. |
| `SESSION_LIFETIME_DAYS` | `30` | Session validity in days. |
| `DATABASE_URL` | `sqlite:///backend/phdstudylab.db` | SQLAlchemy DB URL. |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allowed origins. |

For local dev with the Vite dev server on a different origin, run with:

```bash
INVITE_CODE=dev COOKIE_SECURE=0 uvicorn app.main:app --reload
```

### Frontend

```bash
cd frontend
npm install
```

---

## 4. Running locally

Two terminals:

```bash
# Terminal A — backend
cd backend
uvicorn app.main:app --reload
# → http://127.0.0.1:8000
```

```bash
# Terminal B — frontend
cd frontend
npm run dev
# → http://127.0.0.1:5173
```

The dev server reads `VITE_API_BASE_URL` from env if set; otherwise it defaults to `http://127.0.0.1:8000` (see `frontend/src/api/client.ts`). CORS in the backend allows `http://localhost:5173` by default (`backend/app/main.py`); override with the `CORS_ORIGINS` env var (comma-separated).

### Switching DB

By default the backend uses SQLite at `backend/phdstudylab.db`. To use Postgres (or another SQLAlchemy-supported DB):

```bash
export DATABASE_URL=postgresql://user:pass@host:5432/dbname
```

The config normalizes `postgres://` to `postgresql://` for Render-style URLs.

---

## 5. Common dev tasks

### Add a new endpoint

1. Define / extend the ORM model in `backend/app/models/<feature>.py`.
2. Add the Pydantic schemas in `backend/app/schemas/<feature>.py`.
3. Add the route in `backend/app/api/routes/<feature>.py`. **Always inject `current_user: User = Depends(get_current_user)`** and scope all queries to `current_user.id`. For resource-scoped routes (`/notes/{note_id}`), use a helper that 404s if the resource doesn't belong to the user.
4. If it's a new feature, import the router in `backend/app/main.py` and call `app.include_router(...)`.
5. Add a typed fetch wrapper in `frontend/src/api/<feature>.ts`.
6. Use it from the corresponding view in `frontend/src/views/<feature>.ts`.

### Inspect the database

```bash
sqlite3 backend/phdstudylab.db
sqlite> .tables
sqlite> SELECT * FROM users;
```

### Reset the local DB

```bash
rm backend/phdstudylab.db    # tables are recreated on next startup
```

### Add a Python dependency

```bash
pip install some-pkg
pip freeze | findstr some-pkg >> backend/requirements.txt  # Windows
# or, on Unix:
pip freeze | grep some-pkg >> backend/requirements.txt
```

Pin to a specific version.

### Add a frontend dependency

```bash
cd frontend
npm install --save some-pkg
```

---

## 6. Git workflow

### Branches

- `main`           — protected, stable, what's deployed in production
- `web-deployment` — current integration branch for web hosting work
- feature branches — `feat/<short-name>`, `fix/<short-name>`

### Day-to-day flow

```bash
git checkout main
git pull
git checkout -b feat/something-cool

# ... hack ...

# Test backend + frontend locally (see §4)

git add -p
git commit -m "Add something cool"
git push -u origin feat/something-cool
```

Open a PR against `main` on GitHub. Once merged:

```bash
git checkout main
git pull
git branch -d feat/something-cool
```

### Commits to avoid

- Don't commit `frontend/dist/` (gitignored — built on the server).
- Don't commit `backend/phdstudylab.db` (gitignored — runtime data).
- Don't commit `.env.local` or any file with secrets.
- The Cloudflare API token must **never** appear in a commit. If it ever does: rotate the token on the Cloudflare dashboard immediately.

### Pre-merge checklist

- [ ] Backend starts cleanly: `uvicorn app.main:app --reload` shows no errors.
- [ ] Frontend builds: `npm run build` succeeds.
- [ ] The feature works end-to-end in the browser.
- [ ] No `console.error`s in the browser dev tools on a fresh load.
- [ ] If you changed `deploy/` scripts: documented in the PR description and tested.
- [ ] If you changed dependencies: `requirements.txt` / `package.json` updated.

---

## 7. Deploying to production

While a CI/CD pipeline isn't in place yet, the deployment is a manual `git pull` + rebuild on the server. See [DEPLOYMENT.md §4.1](DEPLOYMENT.md#41-deploy-a-new-version-manual).

Once GitHub Actions is wired up, merging into `main` will trigger the deploy automatically.

---

## 8. Conventions

### Backend

- **Type hints everywhere.** FastAPI relies on them.
- Routers use `APIRouter(prefix="/<feature>", tags=["<feature>"])`.
- Use Pydantic schemas at the API boundary; never return ORM objects directly from endpoints.
- DB sessions come from `app.core.database.get_db` via `Depends`.
- Run `Base.metadata.create_all(bind=engine)` once at startup (already in `main.py`) — no Alembic yet, schema changes are additive only or require a manual migration.

### Frontend

- TypeScript strict + `verbatimModuleSyntax`.
- No framework — vanilla TS + a custom view router in `main.ts`.
- Each view module exposes an `init<View>()` function called when its tab is activated.
- API calls go through `apiFetch<T>(path, options)` from `src/api/client.ts`.
- DOM access by ID, no shadow DOM, styles in `style.css` (BEM-ish naming).

### General

- French / English / 中文 supported in the UI. New strings should ideally be added in all three; otherwise English-only is acceptable temporarily.
- Keep PRs focused — one feature or fix per PR.
