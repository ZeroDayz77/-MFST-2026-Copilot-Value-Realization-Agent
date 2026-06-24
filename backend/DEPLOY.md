# Deploying the Copilot CRM backend to Azure

**Azure App Service (Node 20) with the pure‑JS scoring engine.** No Python runs in
production: the trained‑model parameters are bundled from the committed `.pkl` files
(`model_params.json`). Results are identical to the Python engine (verified: Northstar
finance ROI = 287.09 either way). The static **dashboard** (`frontend/`) is bundled and
served by the backend, so one App Service hosts both UI and API.

Deployment is **manual via the bundled one‑command script** (`deploy.ps1` / `deploy.sh`).
There is no CI/CD pipeline — the script does build + test + provision + deploy in one go,
which is the right fit for Azure for Students (no Entra app registration / OIDC needed).

```
./deploy.ps1 ──► npm test ──► zip {backend + frontend + model_params}
                                 │
                                 ▼
                          Azure App Service (Node 20, F1 free)
                          SCORING_ENGINE=js · LLM via App Settings
```

## What gets created
| Resource | Purpose |
|----------|---------|
| Resource Group | Container for the deployment |
| App Service Plan (Linux, F1) | Compute for the web app (free tier by default) |
| Web App (Node 20) | Runs the Express backend (`npm start`) + serves the dashboard |

Azure OpenAI is **bring‑your‑own** — create it in Foundry/portal and pass the endpoint,
deployment name, and key to the script (or use an OpenAI.com key instead).

> After deploy, browse to `https://<app>.azurewebsites.net/` for the dashboard and
> `/api/meta` for the API.

---

## 1. Prerequisites
- **Azure CLI** (`az`) and an Azure subscription (Contributor on the target resource group).
- **Node.js 18+** and **PowerShell** (Windows) or **bash** (Cloud Shell / macOS / Linux).
- An **LLM** (optional — runs in mock mode without one):
  - **Azure OpenAI** (Foundry): a chat **deployment** (e.g. `gpt-5-mini`) + endpoint + key, **or**
  - **OpenAI.com**: an API key.

> **Azure for Students note:** student subscriptions sometimes **can't create Azure OpenAI**
> (quota 0 / blocked by policy). If so, point the app at an **OpenAI.com** key
> (`-LlmProvider openai`) instead. The free **F1** tier keeps cost near zero.

## 2. Deploy (one command)
```powershell
# Windows PowerShell — from the backend/ folder
az login   # then select your subscription if you have more than one

# No LLM yet (scoring/ranking work; pitch/outreach use the deterministic fallback):
./deploy.ps1 -AppName my-copilot-crm

# With Azure OpenAI (Foundry):
./deploy.ps1 -AppName my-copilot-crm -LlmProvider azure `
  -AzureOpenAiEndpoint https://my-aoai.openai.azure.com `
  -AzureOpenAiDeployment gpt-5-mini -AzureOpenAiApiKey $env:AOAI_KEY

# With an OpenAI.com key (often easiest on a student account):
./deploy.ps1 -AppName my-copilot-crm -LlmProvider openai -OpenAiApiKey $env:OPENAI_KEY
```

```bash
# Azure Cloud Shell / macOS / Linux — equivalent bash script
./deploy.sh -n my-copilot-crm                                   # no LLM
./deploy.sh -n my-copilot-crm -p openai --openai-key "$OPENAI_KEY"
./deploy.sh -n my-copilot-crm -p azure --aoai-endpoint https://my-aoai.openai.azure.com \
            --aoai-deployment gpt-5-mini --aoai-key "$AOAI_KEY"
```

The script: bundles model params + frontend → `npm ci` → `npm test` → creates the RG /
plan / web app if missing → zip‑deploys → applies App Settings → health‑checks `/api/health`.
`-AppName` becomes the public host `https://<AppName>.azurewebsites.net` and must be globally
unique. Re‑run the same command anytime to redeploy (idempotent).

## 3. Verify
```bash
curl https://my-copilot-crm.azurewebsites.net/api/health
curl https://my-copilot-crm.azurewebsites.net/api/meta   # llm.provider != mock, scoring.engine=js
```
Or just open `https://my-copilot-crm.azurewebsites.net/` for the dashboard. Tail logs with
`az webapp log tail -g copilot-crm-rg -n my-copilot-crm`.

---

## Hardened alternative: Bicep + Key Vault
For a more production‑style setup (key in **Key Vault** instead of an App Setting, managed
identity, repeatable IaC), `infra/main.bicep` provisions the plan + web app + Key Vault:
```bash
az group create -n copilot-crm-rg -l eastus2
az deployment group create -g copilot-crm-rg -f infra/main.bicep \
  -p appName=my-copilot-crm \
     azureOpenAiEndpoint=https://my-aoai.openai.azure.com \
     azureOpenAiDeployment=gpt-5-mini \
     azureOpenAiApiKey="$AOAI_KEY"   # stored in Key Vault, never committed
```
Then deploy the code with `./deploy.ps1 -AppName my-copilot-crm` (it updates the existing app).


## Turning the real LLM on/off
- Keys present → `LLM_PROVIDER=azure` (or `openai`) does real generation, parsing,
  pitch, and outreach.
- Want to demo without spend? Deploy with `-LlmProvider mock` (or set the
  `LLM_PROVIDER=mock` App Setting) — scoring/ranking still run; text uses the
  deterministic fallback.

## How config / secrets are handled
- **App config = App Settings** (env vars on the Web App), set by the deploy script:
  `SCORING_ENGINE=js`, `LLM_PROVIDER`, `PRODUCT_NAME`, and the LLM endpoint/deployment/key.
  `PORT` is injected by Azure; `src/config.js` reads everything from `process.env`, so the
  same code runs locally (mock) and on Azure (real) with no changes.
- **The key** is passed to the script and stored as an App Setting (simplest). For a
  hardened setup, use the Bicep path above — it puts the key in **Key Vault** and the app
  reads it via a managed‑identity reference, so it never appears in an App Setting.
- **`.env` is dev‑only** (git‑ignored) and is **never** included in the deploy package.

## Cost / scale notes
- `B1` is the smallest always‑on tier; `F1` (free) works for light demos but sleeps and has quotas.
- **Persistence:** leads are a JSON file (`data/leads.json`) on the app's local disk — fine for a
  single instance/demo, but **do not scale out** (multiple instances won't share state). Swap
  `leadStore.js` for Cosmos DB / Postgres before scaling. The store is isolated behind one module
  for exactly this swap.

## Container alternative
If you later need the **Python** scoring engine (or other native deps) in production, containerize
Node + Python and deploy to **Azure Container Apps** instead. The app already supports
`SCORING_ENGINE=auto|python`; only the host changes. Ask and I'll add a `Dockerfile`.
