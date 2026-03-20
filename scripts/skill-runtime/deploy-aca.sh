#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy-aca.sh — Initial provisioning of skill-runtime on Azure Container Apps
#
# Creates:
#   1. Resource Group
#   2. Storage Account + Blob container
#   3. Container App (with system-assigned managed identity + Blob env vars)
#   4. Storage Blob Data Contributor role assignment
#
# Usage:
#   chmod +x deploy-aca.sh
#   ./deploy-aca.sh                              # uses defaults
#   ./deploy-aca.sh -g my-rg -l japaneast        # override resource group & location
#
# Prerequisites:
#   - Azure CLI (az) installed and logged in
#   - az extension "containerapp" (added automatically if missing)
# ---------------------------------------------------------------------------
set -euo pipefail

# ---- Defaults (override with flags) ----------------------------------------
APP_NAME="skill-runtime"
RESOURCE_GROUP=""
LOCATION="japaneast"
STORAGE_ACCOUNT=""
STORAGE_CONTAINER="skill-runtime"
STORAGE_PREFIX="skills"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  -n NAME       Container App name             (default: skill-runtime)
  -g GROUP      Resource Group name            (default: <APP_NAME>-rg)
  -l LOCATION   Azure region                   (default: japaneast)
  -s ACCOUNT    Storage Account name           (default: <APP_NAME without hyphens>sa)
  -c CONTAINER  Blob container name            (default: skill-runtime)
  -p PREFIX     Blob path prefix               (default: skills)
  -h            Show this help
EOF
  exit 0
}

while getopts "n:g:l:s:c:p:h" opt; do
  case "$opt" in
    n) APP_NAME="$OPTARG" ;;
    g) RESOURCE_GROUP="$OPTARG" ;;
    l) LOCATION="$OPTARG" ;;
    s) STORAGE_ACCOUNT="$OPTARG" ;;
    c) STORAGE_CONTAINER="$OPTARG" ;;
    p) STORAGE_PREFIX="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

# Derive defaults from APP_NAME if not explicitly set
RESOURCE_GROUP="${RESOURCE_GROUP:-${APP_NAME}-rg}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-${APP_NAME//\-/}sa}"

# Resolve skill-runtime source directory (relative to this script)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$(cd "$SCRIPT_DIR/../../skill-runtime" && pwd)"

if [ ! -f "$RUNTIME_DIR/main.py" ]; then
  echo "ERROR: skill-runtime/main.py not found at $RUNTIME_DIR" >&2
  exit 1
fi

STORAGE_ACCOUNT_URL="https://${STORAGE_ACCOUNT}.blob.core.windows.net"

echo "========================================"
echo " skill-runtime — ACA initial deploy"
echo "========================================"
echo " App Name:          $APP_NAME"
echo " Resource Group:    $RESOURCE_GROUP"
echo " Location:          $LOCATION"
echo " Storage Account:   $STORAGE_ACCOUNT"
echo " Storage URL:       $STORAGE_ACCOUNT_URL"
echo " Blob Container:    $STORAGE_CONTAINER"
echo " Blob Prefix:       $STORAGE_PREFIX"
echo " Runtime Source:    $RUNTIME_DIR"
echo "========================================"
echo ""

# 0. Verify az login
echo ">> Checking Azure CLI login..."
az account show --output none

# 1. containerapp extension
echo ">> Ensuring containerapp CLI extension..."
az extension add --name containerapp --upgrade --only-show-errors 2>/dev/null || true

# 2. Resource Group
echo ">> Creating resource group $RESOURCE_GROUP in $LOCATION..."
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output none

# 3. Storage Account
echo ">> Creating storage account $STORAGE_ACCOUNT..."
az storage account create \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --allow-blob-public-access false \
  --output none

# 4. Blob container
echo ">> Creating blob container $STORAGE_CONTAINER..."
az storage container create \
  --name "$STORAGE_CONTAINER" \
  --account-name "$STORAGE_ACCOUNT" \
  --auth-mode login \
  --output none 2>/dev/null || echo "   (container may already exist)"

# 5. Deploy Container App
echo ">> Deploying Container App $APP_NAME from $RUNTIME_DIR..."
az containerapp up \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --ingress external \
  --target-port 8000 \
  --source "$RUNTIME_DIR"

# 6. Enable system-assigned managed identity
echo ">> Enabling system-assigned managed identity..."
az containerapp identity assign \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --system-assigned \
  --output none

# 7. Set environment variables
echo ">> Setting Blob Storage environment variables..."
az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars \
    "SKILL_STORAGE_ACCOUNT_URL=$STORAGE_ACCOUNT_URL" \
    "SKILL_STORAGE_CONTAINER=$STORAGE_CONTAINER" \
    "SKILL_STORAGE_PREFIX=$STORAGE_PREFIX" \
  --output none

# 8. RBAC — Storage Blob Data Contributor
echo ">> Resolving managed identity principal ID..."
PRINCIPAL_ID=$(az containerapp identity show \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query principalId \
  --output tsv)

echo "   Principal ID: $PRINCIPAL_ID"

STORAGE_ID=$(az storage account show \
  --name "$STORAGE_ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --query id \
  --output tsv)

echo ">> Assigning Storage Blob Data Contributor role..."
az role assignment create \
  --assignee-object-id "$PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" \
  --scope "$STORAGE_ID" \
  --output none 2>/dev/null || echo "   (role assignment may already exist)"

# 9. Show result
FQDN=$(az containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn \
  --output tsv)

echo ""
echo "========================================"
echo " Deploy complete!"
echo "========================================"
echo " Runtime URL:   https://$FQDN"
echo " Execute URL:   https://$FQDN/execute"
echo " Health URL:    https://$FQDN/health"
echo " Upload URL:    https://$FQDN/upload"
echo ""
echo " Set this as the Custom Skill URI in Azure AI Search:"
echo "   https://$FQDN/execute"
echo "========================================"
