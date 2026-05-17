# ============================================================================
# Script d'installation des services Nine Lives Study sur Windows.
# À LANCER UNE FOIS, EN ADMINISTRATEUR.
#
#   powershell -ExecutionPolicy Bypass -File .\deploy\install-services.ps1
#
# Avant de le lancer, place ton token Cloudflare dans la variable d'env :
#   $env:CF_API_TOKEN = "ton_token_cloudflare"
# ou bien crée le fichier C:\srv\ddns\.cf-token (1 ligne, le token).
#
# Ce script :
#   1. Copie les scripts de deploy/ vers C:\srv\... (emplacements canoniques)
#   2. Crée la tâche planifiée DDNS Cloudflare (toutes les 5 min)
#   3. Crée la tâche planifiée Backend FastAPI (au démarrage)
#   4. Crée la tâche planifiée Caddy (au démarrage)
#   5. Ouvre les ports 80 et 443 dans le pare-feu Windows
#   6. Démarre tout
# ============================================================================

# Vérification admin
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Write-Host "ERREUR : ce script doit être lancé en tant qu'administrateur." -ForegroundColor Red
    Read-Host "Appuie sur Entrée pour quitter"
    exit 1
}

$ErrorActionPreference = "Stop"

# Lecture du token : env var d'abord, sinon fichier
$Token = $env:CF_API_TOKEN
if (-not $Token) {
    $TokenFile = "C:\srv\ddns\.cf-token"
    if (Test-Path $TokenFile) {
        $Token = (Get-Content $TokenFile -Raw).Trim()
    }
}
if (-not $Token) {
    Write-Host "ERREUR : CF_API_TOKEN non défini. Voir l'en-tête de ce script." -ForegroundColor Red
    Read-Host "Appuie sur Entrée pour quitter"
    exit 1
}

$RepoDir   = Split-Path -Parent $PSScriptRoot
$DeployDir = $PSScriptRoot

Write-Host "`n=== 0. Préparation des dossiers ===" -ForegroundColor Cyan
foreach ($d in "C:\srv", "C:\srv\caddy", "C:\srv\caddy\logs", "C:\srv\backend", "C:\srv\ddns") {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
}

# Persiste le token machine pour Caddy + DDNS
[Environment]::SetEnvironmentVariable("CF_API_TOKEN", $Token, "Machine")
Set-Content -Path "C:\srv\ddns\.cf-token" -Value $Token -NoNewline
Write-Host "  -> CF_API_TOKEN persisté (env var Machine + C:\srv\ddns\.cf-token)"

Write-Host "`n=== 1. Copie des scripts vers C:\srv ===" -ForegroundColor Cyan
Copy-Item -Path "$DeployDir\Caddyfile"              -Destination "C:\srv\caddy\Caddyfile" -Force
Copy-Item -Path "$DeployDir\start-backend.ps1"      -Destination "C:\srv\backend\start-backend.ps1" -Force
Copy-Item -Path "$DeployDir\update-cloudflare.ps1"  -Destination "C:\srv\ddns\update-cloudflare.ps1" -Force
Write-Host "  -> Caddyfile, start-backend.ps1, update-cloudflare.ps1 copiés"

# Téléchargement de Caddy avec le plugin Cloudflare DNS si pas déjà présent
if (-not (Test-Path "C:\srv\caddy\caddy.exe")) {
    Write-Host "  -> Téléchargement de Caddy + plugin Cloudflare DNS..."
    $url = "https://caddyserver.com/api/download?os=windows&arch=amd64&p=github.com/caddy-dns/cloudflare"
    Invoke-WebRequest -Uri $url -OutFile "C:\srv\caddy\caddy.exe" -UseBasicParsing
}

Write-Host "`n=== 2. Tâche planifiée DDNS Cloudflare ===" -ForegroundColor Cyan
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\srv\ddns\update-cloudflare.ps1"'
$trigStartup = New-ScheduledTaskTrigger -AtStartup
$trigPeriod  = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName "NineLives-DDNS" -Action $action `
    -Trigger @($trigStartup, $trigPeriod) -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "  -> Tâche NineLives-DDNS enregistrée"

Write-Host "`n=== 3. Tâche planifiée Backend FastAPI ===" -ForegroundColor Cyan
$action2 = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument '-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\srv\backend\start-backend.ps1"'
$trigStartup2 = New-ScheduledTaskTrigger -AtStartup
$principal2 = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings2  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName "NineLives-Backend" -Action $action2 `
    -Trigger $trigStartup2 -Principal $principal2 -Settings $settings2 -Force | Out-Null
Write-Host "  -> Tâche NineLives-Backend enregistrée"

Write-Host "`n=== 4. Tâche planifiée Caddy ===" -ForegroundColor Cyan
$actionCaddy = New-ScheduledTaskAction -Execute "C:\srv\caddy\caddy.exe" `
    -Argument 'run --config "C:\srv\caddy\Caddyfile" --adapter caddyfile' `
    -WorkingDirectory "C:\srv\caddy"
$trigStartupCaddy = New-ScheduledTaskTrigger -AtStartup
$principalCaddy = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settingsCaddy  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName "NineLives-Caddy" -Action $actionCaddy `
    -Trigger $trigStartupCaddy -Principal $principalCaddy -Settings $settingsCaddy -Force | Out-Null
Write-Host "  -> Tâche NineLives-Caddy enregistrée"

Write-Host "`n=== 5. Pare-feu Windows (ports 80 et 443 entrants) ===" -ForegroundColor Cyan
foreach ($port in 80, 443) {
    $ruleName = "NineLives-HTTP-$port"
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
        -LocalPort $port -Action Allow -Profile Any | Out-Null
    Write-Host "  -> Règle pare-feu inbound TCP $port ajoutée"
}

Write-Host "`n=== 6. Démarrage immédiat ===" -ForegroundColor Cyan
# Stop d'éventuels caddy/uvicorn lancés à la main
Get-Process caddy  -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName "NineLives-DDNS"
Start-ScheduledTask -TaskName "NineLives-Backend"
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName "NineLives-Caddy"
Start-Sleep -Seconds 5

Write-Host "`n=== Vérifications ===" -ForegroundColor Cyan
try {
    $h = Invoke-RestMethod "http://127.0.0.1:8000/health" -TimeoutSec 5
    Write-Host "  -> Backend OK (health=$($h.status))" -ForegroundColor Green
} catch {
    Write-Host "  -> Backend KO : $($_.Exception.Message)" -ForegroundColor Red
}

$localIp = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.InterfaceAlias -notlike '*Loopback*' -and $_.IPAddress -notlike '169.*' -and $_.PrefixOrigin -eq 'Dhcp' } |
    Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host "`nInstallation terminée." -ForegroundColor Green
Write-Host "`nIl reste à faire MANUELLEMENT :"
Write-Host "  1. Port forwarding sur ta box : TCP 80 et 443 -> $localIp"
Write-Host "  2. Cloudflare > foussistan.fr > SSL/TLS > Overview : 'Full (strict)'"
Write-Host ""
Read-Host "Appuie sur Entrée pour quitter"
