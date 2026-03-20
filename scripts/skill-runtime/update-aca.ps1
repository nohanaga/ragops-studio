<#
.SYNOPSIS
    Rebuild and redeploy skill-runtime on Azure Container Apps.

.DESCRIPTION
    Use this after the initial deploy (deploy-aca.ps1) to push runtime code
    changes (main.py, requirements.txt, Dockerfile, etc.) without recreating
    the Storage Account, identity, or RBAC.

.PARAMETER AppName
    Container App name (default: skill-runtime)

.PARAMETER ResourceGroup
    Resource Group name (default: <AppName>-rg)

.EXAMPLE
    .\update-aca.ps1
    .\update-aca.ps1 -AppName skill-runtime -ResourceGroup my-rg
#>
[CmdletBinding()]
param(
    [string]$AppName = "skill-runtime",
    [string]$ResourceGroup = ""
)

$ErrorActionPreference = "Stop"

if (-not $ResourceGroup) { $ResourceGroup = "$AppName-rg" }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RuntimeDir = Join-Path (Split-Path -Parent (Split-Path -Parent $ScriptDir)) "skill-runtime"
if (-not (Test-Path (Join-Path $RuntimeDir "main.py"))) {
    Write-Error "skill-runtime/main.py not found at $RuntimeDir"
    exit 1
}

Write-Host "========================================"
Write-Host " skill-runtime - ACA update"
Write-Host "========================================"
Write-Host " App Name:        $AppName"
Write-Host " Resource Group:  $ResourceGroup"
Write-Host " Runtime Source:  $RuntimeDir"
Write-Host "========================================"
Write-Host ""

# 0. Verify az login
Write-Host ">> Checking Azure CLI login..."
az account show --output none
if ($LASTEXITCODE -ne 0) { Write-Error "Not logged in. Run 'az login' first."; exit 1 }

# 1. Rebuild and redeploy
Write-Host ">> Rebuilding and redeploying $AppName from $RuntimeDir..."
az containerapp up `
    --name $AppName `
    --resource-group $ResourceGroup `
    --source $RuntimeDir
if ($LASTEXITCODE -ne 0) { Write-Error "az containerapp up failed."; exit 1 }

# 2. Get FQDN
$Fqdn = az containerapp show `
    --name $AppName `
    --resource-group $ResourceGroup `
    --query properties.configuration.ingress.fqdn `
    --output tsv

# 3. Health check (wait up to 60s)
Write-Host ">> Waiting for runtime to become healthy..."
$HealthUrl = "https://$Fqdn/health"
for ($i = 1; $i -le 12; $i++) {
    try {
        $response = Invoke-RestMethod -Method Get -Uri $HealthUrl -TimeoutSec 5
        Write-Host "   Health check passed."
        Write-Host "   $($response | ConvertTo-Json -Compress)"
        break
    }
    catch {
        Write-Host "   Attempt $i/12 - not ready, retrying in 5s..."
        Start-Sleep -Seconds 5
    }
}

Write-Host ""
Write-Host "========================================"
Write-Host " Update complete!"
Write-Host "========================================"
Write-Host " Runtime URL:   https://$Fqdn"
Write-Host " Execute URL:   https://$Fqdn/execute"
Write-Host " Health URL:    https://$Fqdn/health"
Write-Host "========================================"
