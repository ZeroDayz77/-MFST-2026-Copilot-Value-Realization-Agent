# Deploying the Copilot CRM backend to Azure

**Path A — Azure App Service (Node 20) with the pure‑JS scoring engine.** No Python
runs in production: the trained‑model parameters are regenerated from the committed
`.pkl` files in CI and bundled into the deploy package. Results are identical to the
Python engine (verified: Northstar finance ROI = 287.09 either way).

```
GitHub (push to main)
   └─► GitHub Actions ── OIDC ──► Azure
         build + test            App Service (Node 20)  ── Key Vault ref ──► Azure OpenAI key
         export params           reads env App Settings  ── calls ──────────► Azure OpenAI
         zip backend/            SCORING_ENGINE=js
```

## What gets created
| Resource | Purpose |
|----------|---------|
| App Service Plan (Linux) | Compute for the web app |
| Web App (Node 20) | Runs the Express backend (`npm start`), HTTPS only, managed identity |
| Key Vault | Holds the Azure OpenAI API key; referenced from App Settings |

Azure OpenAI is **bring‑your‑own** (passed as parameters) — create it separately.

---

## 1. Prerequisites
- Azure CLI (`az`) and an Azure subscription (you need **Owner/Contributor** on the target resource group).
- An **Azure OpenAI** resource with a chat **deployment** (e.g. `gpt-4o-mini`); note its endpoint, deployment name, and key.
- The repo on GitHub. The workflow triggers on **`main`** — merge this branch to `main` (or edit the `branches:` filter in `.github/workflows/deploy-backend.yml`).

> **Azure for Students note:** student subscriptions often **can't create Azure OpenAI**
> (quota 0 / blocked by policy) and EDU tenants usually **block the OIDC app registration**.
> If so: use the **manual deploy script** below (no app registration) and point the app at an
> **OpenAI.com** key (`-LlmProvider openai`) instead of Azure OpenAI. The free **F1** App
> Service tier keeps cost near zero.

## 2. Provision infrastructure (one time)
```bash
RG=copilot-crm-rg
az group create -n $RG -l eastus2

az deployment group create -g $RG -f infra/main.bicep \
  -p appName=copilot-crm-demo \
     azureOpenAiEndpoint=https://YOUR-AOAI.openai.azure.com \
     azureOpenAiDeployment=gpt-4o-mini \
     azureOpenAiApiKey="$AZURE_OPENAI_API_KEY"   # pass on CLI; never commit it
```
> `appName` becomes the public host: `https://<appName>.azurewebsites.net`. It must be globally unique.
> Keep `appName` in sync with `AZURE_WEBAPP_NAME` in the workflow.

## 3. Wire up GitHub → Azure auth (OIDC, no passwords)
Create an Entra app + federated credential scoped to this repo's **production** environment, and give it access to the resource group:
```bash
APP_ID=$(az ad app create --display-name "copilot-crm-deploy" --query appId -o tsv)
az ad sp create --id $APP_ID
SUB=$(az account show --query id -o tsv)
az role assignment create --assignee $APP_ID --role Contributor \
  --scope /subscriptions/$SUB/resourceGroups/$RG

# Federated credential: must match the workflow's `environment: production`
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-prod",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:OWNER/REPO:environment:production",
  "audiences": ["api://AzureADTokenExchange"]
}'
```
Replace `OWNER/REPO` with your GitHub `owner/repository`.

## 4. Add GitHub secrets + environment
In the repo: **Settings → Environments → New environment → `production`** (add reviewers here for an approval gate if you want). Then add these secrets (repo or environment scope):

| Secret | Value |
|--------|-------|
| `AZURE_CLIENT_ID` | `$APP_ID` from step 3 |
| `AZURE_TENANT_ID` | `az account show --query tenantId -o tsv` |
| `AZURE_SUBSCRIPTION_ID` | `$SUB` from step 3 |

## 5. Deploy
Push to `main` (or run the workflow manually via **Actions → Deploy backend to Azure → Run workflow**). The pipeline:
1. Regenerates `model_params.json` from the `.pkl` models and bundles it into `backend/`.
2. `npm ci` → `npm test` (the 13 smoke tests).
3. OIDC login → `azure/webapps-deploy` → `curl /api/health`.

Verify:
```bash
curl https://copilot-crm-demo.azurewebsites.net/api/health
curl https://copilot-crm-demo.azurewebsites.net/api/meta   # llm.provider=azure, scoring.engine=js
```

---

## Manual deploy (no OIDC / no app registration) — best for Azure for Students
School/EDU tenants usually block the Entra app registration that OIDC needs. Use the
bundled one-command script instead — it provisions the resource group, plan (free **F1**
by default), and web app if missing, builds a clean package (no `.env`, tests, or local
data), zip-deploys, sets app settings, and health-checks.

```powershell
# Windows PowerShell — from the backend/ folder
az login

# No LLM yet (scoring/ranking work; text uses deterministic fallback):
./deploy.ps1 -AppName my-copilot-crm

# With Azure OpenAI:
./deploy.ps1 -AppName my-copilot-crm -LlmProvider azure `
  -AzureOpenAiEndpoint https://my-aoai.openai.azure.com `
  -AzureOpenAiDeployment gpt-4o-mini -AzureOpenAiApiKey $env:AOAI_KEY

# With an OpenAI.com key (often easiest on a student account):
./deploy.ps1 -AppName my-copilot-crm -LlmProvider openai -OpenAiApiKey $env:OPENAI_KEY
```

```bash
# Azure Cloud Shell / macOS / Linux — equivalent bash script
./deploy.sh -n my-copilot-crm                                   # no LLM
./deploy.sh -n my-copilot-crm -p openai --openai-key "$OPENAI_KEY"
./deploy.sh -n my-copilot-crm -p azure --aoai-endpoint https://my-aoai.openai.azure.com \
            --aoai-deployment gpt-4o-mini --aoai-key "$AOAI_KEY"
```

Re-run the same command anytime to redeploy (it's idempotent). Tail logs with
`az webapp log tail -g copilot-crm-rg -n my-copilot-crm`.

---

## How environments / config are handled
- **App config = App Settings** (env vars), set by `infra/main.bicep`: `SCORING_ENGINE=js`,
  `LLM_PROVIDER=azure`, `PRODUCT_NAME`, `AZURE_OPENAI_ENDPOINT`, `_DEPLOYMENT`, `_API_VERSION`.
  `PORT` is injected by Azure; the app already reads `process.env.PORT`.
- **Secrets = Key Vault.** `AZURE_OPENAI_API_KEY` is stored as a Key Vault secret and surfaced
  to the app as a `@Microsoft.KeyVault(SecretUri=...)` reference, resolved at runtime via the
  Web App's managed identity. The key never appears in GitHub or App Settings.
- **`.env` is dev‑only** (git‑ignored). `src/config.js` reads everything from `process.env`,
  so the same code runs locally (mock) and in Azure (real) with no changes.
- **Multiple environments:** duplicate the stack per env (e.g. `copilot-crm-staging`,
  `copilot-crm-prod`) or use **deployment slots**, and pair each with a GitHub Environment
  (`staging`, `production`) holding its own secrets. Add a matching federated credential
  `subject` per environment.

## Turning the real LLM on/off
- Keys present (set via Bicep/Key Vault) → `LLM_PROVIDER=azure` does real generation, parsing,
  pitch, and outreach.
- Want to demo without spend? Set App Setting `LLM_PROVIDER=mock` — scoring/ranking still run;
  text uses the deterministic fallback.

## Cost / scale notes
- `B1` is the smallest always‑on tier; `F1` (free) works for light demos but sleeps and has quotas.
- **Persistence:** leads are a JSON file (`data/leads.json`) on the app's local disk — fine for a
  single instance/demo, but **do not scale out** (multiple instances won't share state). Swap
  `leadStore.js` for Cosmos DB / Postgres before scaling. The store is isolated behind one module
  for exactly this swap.

## Container alternative (Path B)
If you later need the **Python** scoring engine (or other native deps) in production, containerize
Node + Python and deploy to **Azure Container Apps** instead. The app already supports
`SCORING_ENGINE=auto|python`; only the host changes. Ask and I'll add a `Dockerfile` + ACR workflow.
