# Lance le backend FastAPI de Nine Lives Study.
# Appelé par la tâche planifiée NineLives-Backend au démarrage du PC.

$ErrorActionPreference = "Continue"

$BackendDir = "D:\Documents\Dev\srv\PhD-Study-Lab\backend"
$PythonExe  = "C:\Users\barre\miniforge3\envs\dev\python.exe"
$LogFile    = "C:\srv\backend\backend.log"

# INVITE_CODE: required to allow account registration. Read from Machine env var
# (set by install-services.ps1) or from C:\srv\backend\.invite-code as fallback.
if (-not $env:INVITE_CODE) {
    $tokenFile = "C:\srv\backend\.invite-code"
    if (Test-Path $tokenFile) {
        $env:INVITE_CODE = (Get-Content $tokenFile -Raw).Trim()
    }
}

# ANTHROPIC_API_KEY: optional. Enables the AI summary routes (/summaries/*).
# Same pattern as INVITE_CODE — Machine env var first, then a file in
# C:\srv\backend\ as a non-git-tracked fallback. When absent, the AI features
# silently hide themselves in the frontend (graceful 503 from
# /summaries/config); the rest of the app works unchanged.
if (-not $env:ANTHROPIC_API_KEY) {
    $aiKeyFile = "C:\srv\backend\.anthropic-key"
    if (Test-Path $aiKeyFile) {
        $env:ANTHROPIC_API_KEY = (Get-Content $aiKeyFile -Raw).Trim()
    }
}

$logDir = Split-Path $LogFile -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Starting backend..." | Add-Content -Path $LogFile

Set-Location $BackendDir

# Bind sur 127.0.0.1 uniquement : Caddy fait le reverse proxy depuis le même hôte,
# donc le backend ne doit pas être exposé directement sur le réseau.
& $PythonExe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 *>> $LogFile

"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Backend exited." | Add-Content -Path $LogFile
