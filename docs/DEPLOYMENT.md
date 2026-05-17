# Nine Lives Study — Deployment & Server Operations

Comprehensive guide for the **production server** running at <https://ninelives.foussistan.fr>.

If you only want to run the app locally for development, see [DEVELOPMENT.md](DEVELOPMENT.md) instead.

---

## 1. Architecture overview

```
   Internet
      │
      ▼
 ┌─────────────────────────────────┐
 │ Cloudflare (proxy, SSL Full)    │   foussistan.fr  ─ DNS-only (A record)
 │                                 │   ninelives.foussistan.fr ─ proxied (orange cloud)
 └────────────────┬────────────────┘
                  │ HTTPS
                  ▼
 ┌─────────────────────────────────┐
 │ Home internet box (Livebox)     │   Port forwarding TCP 80 + 443 ─► local PC
 └────────────────┬────────────────┘
                  │
                  ▼
 ┌─────────────────────────────────┐
 │ Windows PC ─ LAN 192.168.1.11   │
 │                                 │
 │  Caddy ── HTTPS termination     │   :443 (+ :80 → redirect)
 │    │                            │
 │    ├─ /api/*  → 127.0.0.1:8000  │   reverse proxy (path strip)
 │    └─ /*      → frontend/dist   │   static SPA
 │                                 │
 │  FastAPI / uvicorn              │   127.0.0.1:8000 (loopback only)
 │    └─ SQLite (phdstudylab.db)   │
 │                                 │
 │  DDNS script                    │   updates A records every 5 min
 │    └─ Cloudflare API            │
 └─────────────────────────────────┘
```

### TLS

- Caddy obtains a Let's Encrypt certificate via **DNS-01 challenge** through the Cloudflare API (using the `caddy-dns/cloudflare` plugin).
- Cloudflare is configured in **Full (strict)** mode → client ↔ CF and CF ↔ origin both encrypted, origin cert validated.
- Cloudflare proxy hides the home IP; the orange cloud must stay on for `ninelives.foussistan.fr`.

### Why the `foussistan.fr` apex stays DNS-only

The apex record exists only so DDNS keeps the home IP available for direct access if needed. Nothing currently serves traffic on the apex. If you eventually host another service on the apex, switch it to proxied and add a Caddy block.

---

## 2. Filesystem layout (production server)

| Path | Role |
|---|---|
| `D:\Documents\Dev\srv\PhD-Study-Lab\` | Git working tree (repo clone) |
| `D:\Documents\Dev\srv\PhD-Study-Lab\frontend\dist\` | Built SPA, served by Caddy |
| `D:\Documents\Dev\srv\PhD-Study-Lab\backend\phdstudylab.db` | SQLite database (live data) |
| `D:\Documents\Dev\srv\PhD-Study-Lab\deploy\` | Source of truth for ops scripts (versioned) |
| `C:\srv\caddy\caddy.exe` | Caddy binary (with `caddy-dns/cloudflare` plugin) |
| `C:\srv\caddy\Caddyfile` | Active Caddy config (copy of `deploy/Caddyfile`) |
| `C:\srv\caddy\logs\access.log` | Caddy access log (rotated) |
| `C:\srv\backend\start-backend.ps1` | uvicorn launcher (copy of `deploy/start-backend.ps1`) |
| `C:\srv\backend\backend.log` | uvicorn stdout/stderr |
| `C:\srv\ddns\update-cloudflare.ps1` | DDNS updater (copy of `deploy/update-cloudflare.ps1`) |
| `C:\srv\ddns\.cf-token` | Cloudflare API token, **not in git** |
| `C:\srv\backend\.invite-code` | Invite code required to register, **not in git** |
| `C:\srv\ddns\update-cloudflare.log` | DDNS log |

The `deploy/` folder in the repo is the source of truth. `install-services.ps1` copies the three scripts (`Caddyfile`, `start-backend.ps1`, `update-cloudflare.ps1`) to their `C:\srv\` destinations.

---

## 3. Initial setup (from scratch)

Run this **once** on a fresh Windows machine.

### 3.1 Prerequisites

- Windows 10/11 with admin access
- Git installed (`winget install --id Git.Git`)
- Node.js ≥ 18 (`winget install OpenJS.NodeJS.LTS`)
- Python ≥ 3.10 — current install uses miniforge at `C:\Users\barre\miniforge3\envs\dev\python.exe`. Adjust `deploy/start-backend.ps1` if your Python lives elsewhere.

### 3.2 Clone and build

```powershell
cd D:\Documents\Dev\srv
git clone https://github.com/<owner>/PhD-Study-Lab.git
cd PhD-Study-Lab

# Backend deps
& "C:\Users\barre\miniforge3\envs\dev\python.exe" -m pip install -r backend\requirements.txt

# Frontend build
cd frontend
npm install
npm run build
cd ..
```

### 3.3 Cloudflare prerequisites

1. Create an API token on <https://dash.cloudflare.com/profile/api-tokens> with **Zone:DNS:Edit** on the `foussistan.fr` zone.
2. Create two A records (any IP, DDNS will fix them):
   - `foussistan.fr`            — DNS-only
   - `ninelives.foussistan.fr`  — **proxied**
3. Note the zone ID and the two record IDs; paste them in `deploy/update-cloudflare.ps1` (`$Zone` and the `$Records` array).

### 3.4 Run the install script (in admin PowerShell)

> ⚠️ **Remplace `<...>` par tes vraies valeurs avant d'exécuter.** Le script refuse les placeholders qui commencent par `<` et finissent par `>`, mais une chaîne courte ou tronquée passerait silencieusement et casserait Caddy.

```powershell
$env:CF_API_TOKEN = "<colle ici ton vrai token Cloudflare (~48 chars, commence par cfut_)>"
$env:INVITE_CODE  = "<colle ici l'invite code que tu veux partager>"
powershell -ExecutionPolicy Bypass -File .\deploy\install-services.ps1
```

This:
- creates `C:\srv\{caddy,backend,ddns}\` directories
- persists the Cloudflare token in `Machine` env var **and** `C:\srv\ddns\.cf-token`
- persists the invite code in `Machine` env var **and** `C:\srv\backend\.invite-code`
- copies the three ops scripts to `C:\srv\...`
- downloads Caddy with the Cloudflare DNS plugin
- registers three scheduled tasks running as `SYSTEM` at boot:
  - `NineLives-DDNS` (also every 5 minutes)
  - `NineLives-Backend`
  - `NineLives-Caddy`
- adds firewall rules for inbound TCP 80 and 443
- starts everything

### 3.5 Router / Cloudflare manual steps

1. **Livebox** (or your box) → reserve `192.168.1.11` for this PC in DHCP, then port-forward TCP 80 and 443 to it.
2. **Cloudflare dashboard** → zone `foussistan.fr` → SSL/TLS → Overview → set mode **Full (strict)**.

### 3.6 Verify

```powershell
Invoke-RestMethod https://ninelives.foussistan.fr/api/health
# → status: ok
```

The first hit may take 30 s–2 min while Caddy obtains the Let's Encrypt cert.

---

## 4. Routine operations

### 4.1 Deploy a new version (manual)

After pulling fresh code on the server:

```powershell
cd D:\Documents\Dev\srv\PhD-Study-Lab

git pull

# Frontend
cd frontend
npm install
npm run build
cd ..

# Backend deps (only if requirements.txt changed)
& "C:\Users\barre\miniforge3\envs\dev\python.exe" -m pip install -r backend\requirements.txt

# Restart backend (in admin PowerShell)
Stop-ScheduledTask  -TaskName NineLives-Backend
Start-ScheduledTask -TaskName NineLives-Backend
```

Caddy doesn't need restarting — it serves the new files immediately from `dist/`.

If you changed `deploy/Caddyfile` or the ops scripts:

```powershell
# Copy updated scripts into place
Copy-Item .\deploy\Caddyfile             C:\srv\caddy\Caddyfile             -Force
Copy-Item .\deploy\start-backend.ps1     C:\srv\backend\start-backend.ps1   -Force
Copy-Item .\deploy\update-cloudflare.ps1 C:\srv\ddns\update-cloudflare.ps1  -Force

# Hot-reload Caddy
& "C:\srv\caddy\caddy.exe" reload --config C:\srv\caddy\Caddyfile
```

### 4.2 Status check

```powershell
Get-ScheduledTask -TaskName "NineLives-*" | ForEach-Object {
    $i = Get-ScheduledTaskInfo $_
    [PSCustomObject]@{
        Name       = $_.TaskName
        State      = $_.State
        LastRun    = $i.LastRunTime
        LastResult = $i.LastTaskResult
    }
} | Format-Table -AutoSize

Invoke-RestMethod http://127.0.0.1:8000/health           # backend
Invoke-RestMethod https://ninelives.foussistan.fr/api/health   # end-to-end
```

### 4.3 Logs

```powershell
Get-Content C:\srv\caddy\logs\access.log     -Tail 20
Get-Content C:\srv\backend\backend.log       -Tail 50
Get-Content C:\srv\ddns\update-cloudflare.log -Tail 10
```

### 4.4 Reload / restart

| Component | Reload (config) | Hard restart |
|---|---|---|
| Caddy   | `caddy reload --config C:\srv\caddy\Caddyfile` | `Stop-ScheduledTask NineLives-Caddy; Start-ScheduledTask NineLives-Caddy` |
| Backend | n/a (no hot-reload in prod) | `Stop-ScheduledTask NineLives-Backend; Start-ScheduledTask NineLives-Backend` |
| DDNS    | n/a (one-shot script) | `Start-ScheduledTask NineLives-DDNS` |

### 4.5 Backups

The database is the only stateful artifact.

```powershell
$ts = Get-Date -Format "yyyyMMdd-HHmm"
Copy-Item D:\Documents\Dev\srv\PhD-Study-Lab\backend\phdstudylab.db `
          D:\Backups\NineLives\phdstudylab-$ts.db
```

Recommend a scheduled task running this daily. SQLite is fine to copy live for small databases (the WAL is flushed on close); for a safer copy use:

```powershell
& "C:\Users\barre\miniforge3\envs\dev\python.exe" -c @"
import sqlite3, shutil
src = sqlite3.connect(r'D:\Documents\Dev\srv\PhD-Study-Lab\backend\phdstudylab.db')
dst = sqlite3.connect(r'D:\Backups\NineLives\phdstudylab.db')
src.backup(dst); src.close(); dst.close()
"@
```

---

## 5. Troubleshooting

### Site unreachable

1. **Check from the server itself:**
   ```powershell
   Invoke-RestMethod http://127.0.0.1:8000/health
   ```
   - 200 OK → backend fine, problem upstream (Caddy / network / Cloudflare)
   - connection refused → backend down → restart `NineLives-Backend` task and check `backend.log`

2. **Check Caddy is binding 443:**
   ```powershell
   Get-NetTCPConnection -LocalPort 443 -State Listen
   ```

3. **Check DNS:**
   ```powershell
   Resolve-DnsName ninelives.foussistan.fr
   ```
   Should return Cloudflare IPs (1xx.x.x.x). If it returns your home IP, the proxy is off.

4. **Cloudflare dashboard → Analytics → Traffic** to see if traffic is reaching CF at all.

### Cert renewal failures

Caddy renews automatically. If `caddy.log` shows ACME errors:
- Verify `CF_API_TOKEN` env var is still valid: `[Environment]::GetEnvironmentVariable("CF_API_TOKEN", "Machine")`
- Verify the token's permissions (Zone:DNS:Edit on `foussistan.fr`).
- Caddy stores certs at `C:\Windows\System32\config\systemprofile\AppData\Roaming\Caddy\` (because it runs as SYSTEM).

### Caddy refuses to start with "API token '<...>' appears invalid"

The Cloudflare API token got overwritten with a placeholder (typically by re-running `install-services.ps1` with the doc command pasted verbatim — `$env:CF_API_TOKEN = "<...>"` literally). Manually validate `caddy.exe validate --config C:\srv\caddy\Caddyfile` will show the corrupt value.

Fix in **admin PowerShell**:

```powershell
$Token = "your_real_cloudflare_token"   # ~48 chars, starts with cfut_
Set-Content -Path "C:\srv\ddns\.cf-token" -Value $Token -NoNewline
[Environment]::SetEnvironmentVariable("CF_API_TOKEN", $Token, "Machine")
Stop-ScheduledTask  -TaskName "NineLives-Caddy" -ErrorAction SilentlyContinue
Stop-ScheduledTask  -TaskName "NineLives-DDNS"  -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName "NineLives-DDNS"
Start-ScheduledTask -TaskName "NineLives-Caddy"
```

### "Could not load users" in the browser

Already-known scenario. Cause is almost always the backend not running. See §4.2.

### IP changed but DNS not updated

```powershell
Get-Content C:\srv\ddns\update-cloudflare.log -Tail 20
Start-ScheduledTask -TaskName "NineLives-DDNS"
```

### Caddy port 80/443 already in use

Some Windows services bind 80 by default. Check who's holding the port:
```powershell
Get-Process -Id (Get-NetTCPConnection -LocalPort 80 -State Listen).OwningProcess
```
Frequent suspects: World Wide Web Publishing Service (IIS), Skype older versions.

---

## 6. Security notes

- The **Cloudflare API token** lives in `C:\srv\ddns\.cf-token` and as a `Machine` env var. **Not committed to git.** If it ever leaks, rotate it on the Cloudflare dashboard.
- The **invite code** lives in `C:\srv\backend\.invite-code` and as a `Machine` env var. **Not committed.** Rotate by updating both and restarting `NineLives-Backend`. Existing accounts are unaffected; only new sign-ups need the new code.
- The backend listens on **127.0.0.1 only** — it can't be hit directly from the LAN or internet, only through Caddy.
- **Authentication** uses HTTP-only session cookies. Passwords are bcrypt-hashed. Sessions last 30 days (configurable via `SESSION_LIFETIME_DAYS` env var) and are stored server-side in the `sessions` table.
- `COOKIE_SECURE` is on by default (cookies only sent over HTTPS). Set to `0` only for local HTTP dev.
- The `phdstudylab.db` file contains user data and password hashes — back it up, don't share it.

### Managing accounts

There is no admin UI yet. Drop into SQLite to inspect or remove accounts:

```powershell
sqlite3 D:\Documents\Dev\srv\PhD-Study-Lab\backend\phdstudylab.db
sqlite> .headers on
sqlite> SELECT id, username, is_active FROM users;
sqlite> DELETE FROM users WHERE username = 'spammer';   -- cascades to all their data
sqlite> .quit
```

---

## 7. Future: CI/CD

Planned: a GitHub Actions workflow that on push to `main`:

1. Runs lints / tests
2. Builds the frontend
3. SSH into the server (or uses a self-hosted runner) and:
   - `git pull`
   - rsync `dist/` into place
   - restart `NineLives-Backend`

Once the runner is set up, the *Routine operations* section above becomes "merge a PR, wait 60 s".
