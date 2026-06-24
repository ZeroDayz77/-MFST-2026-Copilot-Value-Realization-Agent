<#
.SYNOPSIS
  One-command deploy of the Copilot CRM backend to Azure App Service (Linux, Node 20),
  using the pure-JS scoring engine (no Python at runtime). Built for Azure for Students:
  no Entra app registration / OIDC required, and defaults to the free F1 tier.

.DESCRIPTION
  Bundles the trained-model params, runs the tests, builds a clean deploy package
  (excludes .env, tests, and local data), creates the resource group / plan / web app
  if missing, zip-deploys, applies app settings, and health-checks the result.

.EXAMPLE
  # Deploy without an LLM (scoring/ranking work; text uses deterministic fallback)
  ./deploy.ps1 -AppName my-copilot-crm

.EXAMPLE
  # Deploy with Azure OpenAI
  ./deploy.ps1 -AppName my-copilot-crm -LlmProvider azure `
    -AzureOpenAiEndpoint https://my-aoai.openai.azure.com `
    -AzureOpenAiDeployment gpt-4o-mini -AzureOpenAiApiKey $env:AOAI_KEY

.EXAMPLE
  # Deploy with an OpenAI.com key (easiest on a student account)
  ./deploy.ps1 -AppName my-copilot-crm -LlmProvider openai -OpenAiApiKey $env:OPENAI_KEY
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppName,
  [string]$ResourceGroup = 'copilot-crm-rg',
  [string]$Location = 'eastus2',
  [string]$Sku = 'F1',
  [string]$ProductName = 'Microsoft 365 Copilot',

  [ValidateSet('mock', 'azure', 'openai')]
  [string]$LlmProvider = 'mock',

  [string]$AzureOpenAiEndpoint,
  [string]$AzureOpenAiDeployment,
  [string]$AzureOpenAiApiVersion = '2024-08-01-preview',
  [string]$AzureOpenAiApiKey,

  [string]$OpenAiApiKey,
  [string]$OpenAiModel = 'gpt-4o-mini',

  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$backend = $PSScriptRoot
$repoRoot = Split-Path $backend -Parent

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Fail($msg) { Write-Error $msg; exit 1 }

# --- Preconditions --------------------------------------------------------
Step 'Checking prerequisites'
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { Fail 'Azure CLI (az) not found. Install: https://aka.ms/azure-cli' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm not found. Install Node.js 18+.' }
$acct = az account show 2>$null | ConvertFrom-Json
if (-not $acct) { Fail "Not logged in. Run 'az login' first." }
Write-Host "Subscription: $($acct.name)"

if ($LlmProvider -eq 'azure' -and -not ($AzureOpenAiEndpoint -and $AzureOpenAiDeployment -and $AzureOpenAiApiKey)) {
  Fail 'LlmProvider=azure requires -AzureOpenAiEndpoint, -AzureOpenAiDeployment and -AzureOpenAiApiKey.'
}
if ($LlmProvider -eq 'openai' -and -not $OpenAiApiKey) {
  Fail 'LlmProvider=openai requires -OpenAiApiKey.'
}

# --- Bundle trained-model params (JS engine needs this at runtime) --------
Step 'Bundling model parameters'
$paramsSrc = Join-Path $repoRoot 'Models/artifacts/model_params.json'
if (-not (Test-Path $paramsSrc)) {
  Write-Host 'model_params.json missing; trying to generate from the .pkl models...'
  if (Get-Command python -ErrorAction SilentlyContinue) {
    python (Join-Path $repoRoot 'Models/export_params.py')
  }
  if (-not (Test-Path $paramsSrc)) {
    Fail "Could not find or generate $paramsSrc. Run 'python Models/export_params.py'."
  }
}

# --- Install deps + test --------------------------------------------------
Step 'Installing dependencies (npm ci)'
Push-Location $backend
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed.' }

  if (-not $SkipTests) {
    Step 'Running tests'
    npm test
    if ($LASTEXITCODE -ne 0) { Fail 'Tests failed. Fix them or re-run with -SkipTests.' }
  }
}
finally { Pop-Location }

# --- Build a clean deploy package (NO .env / tests / local data) ----------
Step 'Building deploy package'
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("crm-deploy-" + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $stage
Copy-Item (Join-Path $backend 'src') (Join-Path $stage 'src') -Recurse
Copy-Item (Join-Path $backend 'node_modules') (Join-Path $stage 'node_modules') -Recurse
Copy-Item (Join-Path $backend 'package.json') $stage
Copy-Item (Join-Path $backend 'package-lock.json') $stage
$null = New-Item -ItemType Directory -Path (Join-Path $stage 'artifacts')
Copy-Item $paramsSrc (Join-Path $stage 'artifacts/model_params.json')
$null = New-Item -ItemType Directory -Path (Join-Path $stage 'data')
Set-Content -Path (Join-Path $stage 'data/.gitkeep') -Value ''

$zip = Join-Path ([System.IO.Path]::GetTempPath()) ("crm-deploy-" + [guid]::NewGuid().ToString('N') + '.zip')
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Write-Host "Package: $zip"

# --- Provision (idempotent) ----------------------------------------------
Step 'Ensuring Azure resources'
az group create -n $ResourceGroup -l $Location | Out-Null

$planName = "$AppName-plan"
$planExists = az appservice plan show -g $ResourceGroup -n $planName 2>$null
if (-not $planExists) {
  Write-Host "Creating plan $planName ($Sku, Linux)"
  az appservice plan create -g $ResourceGroup -n $planName --sku $Sku --is-linux | Out-Null
}

$appExists = az webapp show -g $ResourceGroup -n $AppName 2>$null
if (-not $appExists) {
  Write-Host "Creating web app $AppName (NODE:20-lts)"
  az webapp create -g $ResourceGroup -p $planName -n $AppName --runtime 'NODE:20-lts' | Out-Null
}

# --- App settings ---------------------------------------------------------
Step 'Applying app settings'
$settings = @(
  'SCM_DO_BUILD_DURING_DEPLOYMENT=false',
  'NODE_ENV=production',
  'SCORING_ENGINE=js',
  "LLM_PROVIDER=$LlmProvider",
  "PRODUCT_NAME=$ProductName"
)
if ($LlmProvider -eq 'azure') {
  $settings += "AZURE_OPENAI_ENDPOINT=$AzureOpenAiEndpoint"
  $settings += "AZURE_OPENAI_DEPLOYMENT=$AzureOpenAiDeployment"
  $settings += "AZURE_OPENAI_API_VERSION=$AzureOpenAiApiVersion"
  $settings += "AZURE_OPENAI_API_KEY=$AzureOpenAiApiKey"
}
elseif ($LlmProvider -eq 'openai') {
  $settings += "OPENAI_API_KEY=$OpenAiApiKey"
  $settings += "OPENAI_MODEL=$OpenAiModel"
}
az webapp config appsettings set -g $ResourceGroup -n $AppName --settings $settings | Out-Null
az webapp config set -g $ResourceGroup -n $AppName --startup-file 'npm start' | Out-Null

# --- Deploy ---------------------------------------------------------------
Step 'Deploying package'
az webapp deploy -g $ResourceGroup -n $AppName --src-path $zip --type zip | Out-Null

# --- Verify ---------------------------------------------------------------
Step 'Verifying'
$host_ = az webapp show -g $ResourceGroup -n $AppName --query defaultHostName -o tsv
$base = "https://$host_"
$ok = $false
for ($i = 1; $i -le 6; $i++) {
  Start-Sleep -Seconds 10
  try {
    $r = Invoke-RestMethod "$base/api/health" -TimeoutSec 15
    if ($r.status -eq 'ok') { $ok = $true; break }
  }
  catch { Write-Host "  waiting for app to start ($i/6)..." }
}

# --- Cleanup --------------------------------------------------------------
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zip -Force -ErrorAction SilentlyContinue

if ($ok) {
  $meta = Invoke-RestMethod "$base/api/meta" -TimeoutSec 15
  Write-Host "`nDeployed: $base" -ForegroundColor Green
  Write-Host "  health : ok"
  Write-Host "  llm    : $($meta.llm.provider)   (mock = no/!invalid key)"
  Write-Host "  scoring: $($meta.scoring.engine)"
  Write-Host "`nTry: curl $base/api/meta"
}
else {
  Write-Warning "Deployed, but health check did not pass yet. Check logs:"
  Write-Host "  az webapp log tail -g $ResourceGroup -n $AppName"
}
