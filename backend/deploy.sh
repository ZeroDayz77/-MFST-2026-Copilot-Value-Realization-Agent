#!/usr/bin/env bash
# One-command deploy of the Copilot CRM backend to Azure App Service (Linux, Node 20),
# JS scoring engine (no Python at runtime). No Entra app registration / OIDC required.
# Designed for Azure for Students (defaults to the free F1 tier).
#
# Usage:
#   ./deploy.sh -n my-copilot-crm                              # no LLM (mock fallback)
#   ./deploy.sh -n my-copilot-crm -p openai  --openai-key "$OPENAI_KEY"
#   ./deploy.sh -n my-copilot-crm -p azure \
#       --aoai-endpoint https://my-aoai.openai.azure.com \
#       --aoai-deployment gpt-4o-mini --aoai-key "$AOAI_KEY"
set -euo pipefail

RG="copilot-crm-rg"; LOCATION="eastus2"; SKU="F1"; PRODUCT="Microsoft 365 Copilot"
APP=""; PROVIDER="mock"; SKIP_TESTS="false"
AOAI_ENDPOINT=""; AOAI_DEPLOYMENT=""; AOAI_VERSION="2024-08-01-preview"; AOAI_KEY=""
OPENAI_KEY=""; OPENAI_MODEL="gpt-4o-mini"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--app) APP="$2"; shift 2;;
    -g|--resource-group) RG="$2"; shift 2;;
    -l|--location) LOCATION="$2"; shift 2;;
    --sku) SKU="$2"; shift 2;;
    -p|--provider) PROVIDER="$2"; shift 2;;
    --aoai-endpoint) AOAI_ENDPOINT="$2"; shift 2;;
    --aoai-deployment) AOAI_DEPLOYMENT="$2"; shift 2;;
    --aoai-version) AOAI_VERSION="$2"; shift 2;;
    --aoai-key) AOAI_KEY="$2"; shift 2;;
    --openai-key) OPENAI_KEY="$2"; shift 2;;
    --openai-model) OPENAI_MODEL="$2"; shift 2;;
    --skip-tests) SKIP_TESTS="true"; shift;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done

step() { echo -e "\n=== $1 ==="; }
[[ -n "$APP" ]] || { echo "ERROR: -n/--app <name> is required." >&2; exit 1; }

BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$BACKEND")"

step "Checking prerequisites"
command -v az >/dev/null  || { echo "Azure CLI not found." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm not found." >&2; exit 1; }
az account show >/dev/null 2>&1 || { echo "Not logged in. Run 'az login'." >&2; exit 1; }

if [[ "$PROVIDER" == "azure" && ( -z "$AOAI_ENDPOINT" || -z "$AOAI_DEPLOYMENT" || -z "$AOAI_KEY" ) ]]; then
  echo "ERROR: provider=azure needs --aoai-endpoint, --aoai-deployment and --aoai-key." >&2; exit 1
fi
if [[ "$PROVIDER" == "openai" && -z "$OPENAI_KEY" ]]; then
  echo "ERROR: provider=openai needs --openai-key." >&2; exit 1
fi

step "Bundling model parameters"
PARAMS="$REPO_ROOT/Models/artifacts/model_params.json"
if [[ ! -f "$PARAMS" ]]; then
  echo "model_params.json missing; trying to generate it..."
  command -v python >/dev/null && python "$REPO_ROOT/Models/export_params.py" || true
  [[ -f "$PARAMS" ]] || { echo "Run 'python Models/export_params.py' first." >&2; exit 1; }
fi

step "Installing dependencies (npm ci)"
( cd "$BACKEND" && npm ci )
if [[ "$SKIP_TESTS" != "true" ]]; then
  step "Running tests"
  ( cd "$BACKEND" && npm test )
fi

step "Building deploy package"
STAGE="$(mktemp -d)"
ZIP="$(mktemp -u).zip"
cp -r "$BACKEND/src" "$STAGE/src"
cp -r "$BACKEND/node_modules" "$STAGE/node_modules"
cp "$BACKEND/package.json" "$BACKEND/package-lock.json" "$STAGE/"
mkdir -p "$STAGE/artifacts" "$STAGE/data"
cp "$PARAMS" "$STAGE/artifacts/model_params.json"
: > "$STAGE/data/.gitkeep"
# Bundle the static frontend so the backend serves the dashboard same-origin.
if [[ -f "$REPO_ROOT/frontend/index.html" ]]; then
  cp -r "$REPO_ROOT/frontend" "$STAGE/frontend"
  echo "Bundled frontend/ into the package."
else
  echo "No frontend/ found; deploying API only."
fi
( cd "$STAGE" && zip -qr "$ZIP" . )

step "Ensuring Azure resources"
az group create -n "$RG" -l "$LOCATION" -o none
PLAN="$APP-plan"
if ! az appservice plan show -g "$RG" -n "$PLAN" -o none 2>/dev/null; then
  echo "Creating plan $PLAN ($SKU, Linux)..."
  if ! az appservice plan create -g "$RG" -n "$PLAN" --sku "$SKU" --is-linux -o none; then
    echo "ERROR: plan creation failed (SKU '$SKU'). Student/free subs often have F1 quota 0; retry with --sku B1." >&2
    exit 1
  fi
fi
if ! az webapp show -g "$RG" -n "$APP" -o none 2>/dev/null; then
  # Resolve a Node runtime the installed CLI supports (label format varies by version).
  RT="${RUNTIME:-}"
  if [[ -z "$RT" ]]; then
    echo "Detecting a supported Node runtime..."
    RUNTIMES="$(az webapp list-runtimes --os-type linux -o tsv 2>/dev/null)"
    for pref in "NODE:22-lts" "NODE:20-lts" "NODE:18-lts"; do
      if grep -qx "$pref" <<< "$RUNTIMES"; then RT="$pref"; break; fi
    done
    [[ -z "$RT" ]] && RT="$(grep '^NODE' <<< "$RUNTIMES" | head -n1)"
    [[ -z "$RT" ]] && RT="NODE:20-lts"
  fi
  echo "Creating web app $APP ($RT)..."
  if ! az webapp create -g "$RG" -p "$PLAN" -n "$APP" --runtime "$RT" -o none; then
    echo "ERROR: web app creation failed. Name '$APP' may be taken (must be globally unique), or runtime '$RT' is unsupported. Run 'az webapp list-runtimes --os-type linux'." >&2
    exit 1
  fi
fi
az webapp show -g "$RG" -n "$APP" -o none 2>/dev/null || { echo "ERROR: web app '$APP' missing after provisioning; aborting." >&2; exit 1; }

step "Applying app settings"
SETTINGS=( "SCM_DO_BUILD_DURING_DEPLOYMENT=false" "NODE_ENV=production" \
           "SCORING_ENGINE=js" "LLM_PROVIDER=$PROVIDER" "PRODUCT_NAME=$PRODUCT" )
if [[ "$PROVIDER" == "azure" ]]; then
  SETTINGS+=( "AZURE_OPENAI_ENDPOINT=$AOAI_ENDPOINT" "AZURE_OPENAI_DEPLOYMENT=$AOAI_DEPLOYMENT" \
              "AZURE_OPENAI_API_VERSION=$AOAI_VERSION" "AZURE_OPENAI_API_KEY=$AOAI_KEY" )
elif [[ "$PROVIDER" == "openai" ]]; then
  SETTINGS+=( "OPENAI_API_KEY=$OPENAI_KEY" "OPENAI_MODEL=$OPENAI_MODEL" )
fi
az webapp config appsettings set -g "$RG" -n "$APP" --settings "${SETTINGS[@]}" -o none
az webapp config set -g "$RG" -n "$APP" --startup-file 'npm start' -o none

step "Deploying package"
az webapp deploy -g "$RG" -n "$APP" --src-path "$ZIP" --type zip -o none

step "Verifying"
BASE="https://$(az webapp show -g "$RG" -n "$APP" --query defaultHostName -o tsv)"
OK="false"
for i in $(seq 1 6); do
  sleep 10
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then OK="true"; break; fi
  echo "  waiting for app to start ($i/6)..."
done

rm -rf "$STAGE" "$ZIP" 2>/dev/null || true

if [[ "$OK" == "true" ]]; then
  echo -e "\nDeployed: $BASE"
  curl -fsS "$BASE/api/meta" | sed -n 's/.*"provider":"\([a-z]*\)".*/  llm provider: \1 (mock = no\/invalid key)/p' || true
  echo "Try: curl $BASE/api/meta"
else
  echo "Deployed, but health check not passing yet. Logs: az webapp log tail -g $RG -n $APP"
fi
