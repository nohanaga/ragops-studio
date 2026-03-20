#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# update-aca.sh — Rebuild and redeploy skill-runtime on Azure Container Apps
#
# Use this after the initial deploy (deploy-aca.sh) to push runtime code
# changes (main.py, requirements.txt, Dockerfile, etc.) without recreating
# the Storage Account, identity, or RBAC.
#
# Usage:
#   chmod +x update-aca.sh
#   ./update-aca.sh                              # uses defaults
#   ./update-aca.sh -n skill-runtime -g my-rg    # override
#
# Prerequisites:
#   - Azure CLI (az) installed and logged in
#   - Container App already provisioned via deploy-aca.sh
# ---------------------------------------------------------------------------
set -euo pipefail

APP_NAME="skill-runtime"
RESOURCE_GROUP=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  -n NAME    Container App name      (default: skill-runtime)
  -g GROUP   Resource Group name     (default: <APP_NAME>-rg)
  -h         Show this help
EOF
  exit 0
}

while getopts "n:g:h" opt; do
  case "$opt" in
    n) APP_NAME="$OPTARG" ;;
    g) RESOURCE_GROUP="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

RESOURCE_GROUP="${RESOURCE_GROUP:-${APP_NAME}-rg}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$(cd "$SCRIPT_DIR/../../skill-runtime" && pwd)"

if [ ! -f "$RUNTIME_DIR/main.py" ]; then
  echo "ERROR: skill-runtime/main.py not found at $RUNTIME_DIR" >&2
  exit 1
fi

echo "========================================"
echo " skill-runtime — ACA update"
echo "========================================"
echo " App Name:        $APP_NAME"
echo " Resource Group:  $RESOURCE_GROUP"
echo " Runtime Source:  $RUNTIME_DIR"
echo "========================================"
echo ""

# 0. Verify az login
echo ">> Checking Azure CLI login..."
az account show --output none

# 1. Rebuild and redeploy
echo ">> Rebuilding and redeploying $APP_NAME from $RUNTIME_DIR..."
az containerapp up \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --source "$RUNTIME_DIR"

# 2. Get FQDN
FQDN=$(az containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn \
  --output tsv)

# 3. Health check (wait up to 60s)
echo ">> Waiting for runtime to become healthy..."
HEALTH_URL="https://$FQDN/health"
for i in $(seq 1 12); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "   Health check passed."
    HEALTH_JSON=$(curl -s "$HEALTH_URL" 2>/dev/null)
    echo "   $HEALTH_JSON"
    break
  fi
  echo "   Attempt $i/12 — HTTP $HTTP_CODE, retrying in 5s..."
  sleep 5
done

echo ""
echo "========================================"
echo " Update complete!"
echo "========================================"
echo " Runtime URL:   https://$FQDN"
echo " Execute URL:   https://$FQDN/execute"
echo " Health URL:    https://$FQDN/health"
echo "========================================"
