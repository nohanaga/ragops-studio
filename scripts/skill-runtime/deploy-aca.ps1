<#
.SYNOPSIS
    Initial provisioning of skill-runtime on Azure Container Apps.

.DESCRIPTION
    Creates:
      1. Resource Group
      2. Storage Account + Blob container
      3. Container App (with system-assigned managed identity + Blob env vars)
      4. Storage Blob Data Contributor role assignment

.PARAMETER AppName
    Container App name (default: skill-runtime)

.PARAMETER ResourceGroup
    Resource Group name (default: <AppName>-rg)

.PARAMETER Location
    Azure region (default: japaneast)

.PARAMETER StorageAccount
    Storage Account name (default: <AppName without hyphens>sa)

.PARAMETER StorageContainer
    Blob container name (default: skill-runtime)

.PARAMETER StoragePrefix
    Blob path prefix (default: skills)

.EXAMPLE
    .\deploy-aca.ps1
    .\deploy-aca.ps1 -ResourceGroup my-rg -Location japaneast
#>
[CmdletBinding()]
param(
    [string]$AppName = "skill-runtime",
    [string]$ResourceGroup = "",
    [string]$Location = "japaneast",
    [string]$StorageAccount = "",
    [string]$StorageContainer = "skill-runtime",
    [string]$StoragePrefix = "skills"
)

$ErrorActionPreference = "Stop"

# Derive defaults
if (-not $ResourceGroup) { $ResourceGroup = "$AppName-rg" }
if (-not $StorageAccount) { $StorageAccount = ($AppName -replace '-', '') + "sa" }

# Resolve skill-runtime source directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RuntimeDir = Join-Path (Split-Path -Parent (Split-Path -Parent $ScriptDir)) "skill-runtime"
if (-not (Test-Path (Join-Path $RuntimeDir "main.py"))) {
    Write-Error "skill-runtime/main.py not found at $RuntimeDir"
    exit 1
}

$StorageAccountUrl = "https://$StorageAccount.blob.core.windows.net"

Write-Host "========================================"
Write-Host " skill-runtime - ACA initial deploy"
Write-Host "========================================"
Write-Host " App Name:          $AppName"
Write-Host " Resource Group:    $ResourceGroup"
Write-Host " Location:          $Location"
Write-Host " Storage Account:   $StorageAccount"
Write-Host " Storage URL:       $StorageAccountUrl"
Write-Host " Blob Container:    $StorageContainer"
Write-Host " Blob Prefix:       $StoragePrefix"
Write-Host " Runtime Source:    $RuntimeDir"
Write-Host "========================================"
Write-Host ""

# 0. Verify az login
Write-Host ">> Checking Azure CLI login..."
az account show --output none
if ($LASTEXITCODE -ne 0) { Write-Error "Not logged in. Run 'az login' first."; exit 1 }

# 1. containerapp extension
Write-Host ">> Ensuring containerapp CLI extension..."
az extension add --name containerapp --upgrade --only-show-errors 2>$null

# 2. Resource Group
Write-Host ">> Creating resource group $ResourceGroup in $Location..."
az group create --name $ResourceGroup --location $Location --output none

# 3. Storage Account
Write-Host ">> Creating storage account $StorageAccount..."
az storage account create `
    --name $StorageAccount `
    --resource-group $ResourceGroup `
    --location $Location `
    --sku Standard_LRS `
    --kind StorageV2 `
    --allow-blob-public-access false `
    --output none

# 4. Blob container
Write-Host ">> Creating blob container $StorageContainer..."
az storage container create `
    --name $StorageContainer `
    --account-name $StorageAccount `
    --auth-mode login `
    --output none 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "   (container may already exist)" }

# 5. Deploy Container App
Write-Host ">> Deploying Container App $AppName from $RuntimeDir..."
az containerapp up `
    --name $AppName `
    --resource-group $ResourceGroup `
    --location $Location `
    --ingress external `
    --target-port 8000 `
    --source $RuntimeDir
if ($LASTEXITCODE -ne 0) { Write-Error "az containerapp up failed."; exit 1 }

# 6. Enable system-assigned managed identity
Write-Host ">> Enabling system-assigned managed identity..."
az containerapp identity assign `
    --name $AppName `
    --resource-group $ResourceGroup `
    --system-assigned `
    --output none

# 7. Set environment variables
Write-Host ">> Setting Blob Storage environment variables..."
az containerapp update `
    --name $AppName `
    --resource-group $ResourceGroup `
    --set-env-vars `
        "SKILL_STORAGE_ACCOUNT_URL=$StorageAccountUrl" `
        "SKILL_STORAGE_CONTAINER=$StorageContainer" `
        "SKILL_STORAGE_PREFIX=$StoragePrefix" `
    --output none

# 8. RBAC
Write-Host ">> Resolving managed identity principal ID..."
$PrincipalId = az containerapp identity show `
    --name $AppName `
    --resource-group $ResourceGroup `
    --query principalId `
    --output tsv
Write-Host "   Principal ID: $PrincipalId"

$StorageId = az storage account show `
    --name $StorageAccount `
    --resource-group $ResourceGroup `
    --query id `
    --output tsv

Write-Host ">> Assigning Storage Blob Data Contributor role..."
az role assignment create `
    --assignee-object-id $PrincipalId `
    --assignee-principal-type ServicePrincipal `
    --role "Storage Blob Data Contributor" `
    --scope $StorageId `
    --output none 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "   (role assignment may already exist)" }

# 9. Show result
$Fqdn = az containerapp show `
    --name $AppName `
    --resource-group $ResourceGroup `
    --query properties.configuration.ingress.fqdn `
    --output tsv

Write-Host ""
Write-Host "========================================"
Write-Host " Deploy complete!"
Write-Host "========================================"
Write-Host " Runtime URL:   https://$Fqdn"
Write-Host " Execute URL:   https://$Fqdn/execute"
Write-Host " Health URL:    https://$Fqdn/health"
Write-Host " Upload URL:    https://$Fqdn/upload"
Write-Host ""
Write-Host " Set this as the Custom Skill URI in Azure AI Search:"
Write-Host "   https://$Fqdn/execute"
Write-Host "========================================"
