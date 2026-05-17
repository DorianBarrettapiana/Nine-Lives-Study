# Met à jour les enregistrements DNS Cloudflare avec l'IP publique courante (DDNS).
# Exécuté toutes les 5 min par la tâche planifiée NineLives-DDNS.
#
# Le token Cloudflare est lu depuis :
#   - la variable d'environnement Machine CF_API_TOKEN, ou
#   - un fichier C:\srv\ddns\.cf-token  (1 ligne, le token)
#
# Cet ordre permet de garder le token hors du repo Git.

$Token = $env:CF_API_TOKEN
if (-not $Token) {
    $TokenFile = "C:\srv\ddns\.cf-token"
    if (Test-Path $TokenFile) {
        $Token = (Get-Content $TokenFile -Raw).Trim()
    }
}
if (-not $Token) {
    Write-Error "CF_API_TOKEN introuvable (ni env var, ni C:\srv\ddns\.cf-token)"
    exit 1
}

$Zone = "e44366bc9e23298c8b1ad6353fa0dfda"

# Liste des records DNS à maintenir à jour avec l'IP publique courante.
# - foussistan.fr : record racine, non-proxied (TTL court pour DDNS direct)
# - ninelives.foussistan.fr : sous-domaine de l'app, proxied via Cloudflare
$Records = @(
    @{ Id = "db19075e96c615f3d76f1e9235cab83c"; Name = "foussistan.fr";            Proxied = $false; Ttl = 60 },
    @{ Id = "0c02079eba6d089b1d33bd90f965f4c1"; Name = "ninelives.foussistan.fr"; Proxied = $true;  Ttl = 1  }
)

$logFile = "C:\srv\ddns\update-cloudflare.log"
$logDir  = Split-Path $logFile -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

try {
    $ip = (Invoke-RestMethod "https://api.ipify.org?format=json").ip

    $headers = @{
        Authorization  = "Bearer $Token"
        "Content-Type" = "application/json"
    }

    foreach ($r in $Records) {
        $body = @{
            type    = "A"
            name    = $r.Name
            content = $ip
            ttl     = $r.Ttl
            proxied = $r.Proxied
        } | ConvertTo-Json

        $resp = Invoke-RestMethod -Method Put `
            -Uri "https://api.cloudflare.com/client/v4/zones/$Zone/dns_records/$($r.Id)" `
            -Headers $headers -Body $body

        $line = "{0} OK {1} ip={2} success={3}" -f (Get-Date -Format "yyyy-MM-dd HH:mm"), $r.Name, $ip, $resp.success
        Add-Content -Path $logFile -Value $line
    }
}
catch {
    $line = "{0} ERR {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm"), $_.Exception.Message
    Add-Content -Path $logFile -Value $line
}
