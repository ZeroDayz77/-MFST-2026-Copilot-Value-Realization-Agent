# Copilot CRM Backend (middle layer)

The reasoning **engine + middle layer** for the AI‑powered CRM. It replaces the
Microsoft 365 **Declarative Agent (DA)** as the entry point: instead of a Copilot
conversation, a web service takes user input, **ranks every lead with the trained
models**, and uses an **LLM API** to produce per‑lead sales enablement (pitch,
talking points, risks, recommended actions, outreach email) for a Monday‑style
dashboard.

```
 Dashboard (future)  ──HTTP──►  backend/ (this service)
                                   │
                 ┌─────────────────┼───────────────────────┐
                 ▼                 ▼                         ▼
        scoringService      enrichmentService         leadGenerator
        (rank each lead)    (per‑lead AI playbook)    (AI‑generate leads)
                 │                 │                         │
        trained models        LLM API (Azure              LLM API / mock
   Models/score_batch.py      OpenAI / OpenAI / mock)
   + model_params.json (JS)
```

## What it does
- **Rank leads automatically** — each lead is scored by the trained ROI / waste /
  expansion models and blended into a 0–100 `lead_score` + `priority` + `rank`.
- **Per‑lead AI** — the DA's system prompt (`appPackage/instruction.txt`) is ported
  to run **per record**: a nuanced sales pitch, talking points, value drivers,
  risks, recommended actions, and a tailored outreach email.
- **Bring or generate leads** — create/edit leads manually, parse a free‑text
  prompt into a lead, or ask the AI to **generate** a batch of prospects.
- **Always works** — no LLM keys? It runs in **mock** mode with a deterministic,
  numbers‑grounded fallback. No Python? Scoring falls back to a pure‑JS engine.

## Quick start
```bash
cd backend
npm install
cp .env.example .env        # optional — runs in mock mode without it
npm start                   # http://localhost:3000  (dashboard + API)
# or: npm run dev           # watch mode
npm test                    # offline smoke tests (mock LLM + JS engine)
```

Then open **http://localhost:3000** for the dashboard (the backend serves
`../frontend/`). The API is under `/api` (e.g. `/api/meta`).

> Requires the trained artifacts. From `Models/`: `python export_params.py`
> (writes `artifacts/model_params.json` for the JS engine). The Python engine
> uses the existing `.pkl` models via `Models/score_batch.py`.

## Configuration (`.env`)
| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3000` | HTTP port |
| `SCORING_ENGINE` | `auto` | `auto` (python→js) · `python` · `js` |
| `PYTHON_BIN` | `python` | Interpreter for the Python engine |
| `LLM_PROVIDER` | `azure` | `azure` · `openai` · `mock` |
| `AZURE_OPENAI_ENDPOINT` / `_API_KEY` / `_DEPLOYMENT` / `_API_VERSION` | – | Azure OpenAI |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | – | OpenAI |
| `PRODUCT_NAME` | `Microsoft 365 Copilot` | The product being sold |
| `LEAD_SCORE_WEIGHTS` | `{expansion:.40,value:.25,waste:.20,size:.15}` | Ranking weights |
| `LEAD_SCORE_SIZE_REF_USD` | `100000` | Monthly spend that maps to a full deal‑size score |

If the requested LLM provider isn't fully configured, the service automatically
falls back to `mock` (logged at startup) so it always boots.

## API
Base path `/api`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness + lead count |
| GET | `/meta` | Stages, priorities, score weights, live scoring + LLM status |
| GET | `/leads` | List leads, ranked. Query: `stage`, `sort`, `order`, `limit` |
| POST | `/leads` | Create from `metrics` **or** a `prompt`. `?enrich=true` to add AI playbook |
| GET | `/leads/:id` | Get one lead |
| PATCH | `/leads/:id` | Edit; re‑scores when metrics change. `?enrich=true` |
| DELETE | `/leads/:id` | Delete |
| POST | `/leads/generate` | AI‑generate `{ count, prompt, hints }` leads. `?enrich=true` |
| POST | `/leads/intake` | **Combined prompt + file flow** (see below). `?enrich=true` |
| POST | `/leads/import` | Bulk import `{ leads: [...] }` |
| POST | `/leads/rank` | Recompute ranks across all leads |
| POST | `/leads/autopilot/run` | Run AI autopilot across all autopilot‑enabled leads |
| POST | `/leads/:id/analyze` | Force re‑score **+ LLM enrichment** |
| POST | `/leads/:id/outreach` | Generate/refresh an outreach **draft** `{ tone, channel, goal }` |
| POST | `/leads/:id/send` | Send (or approve+send) the outreach — honors the mail gate |
| POST | `/leads/:id/autopilot` | **AI next‑best‑action**: decide → draft/send/advance (per autonomy) |
| POST | `/leads/:id/automation` | Set `{ autopilot, autonomy }` (autonomy: manual\|approval\|auto) |

### AI email sending (agent loop)
`/:id/autopilot` runs a **planner/executor** loop: the LLM **decides** the next action
(`send_email`, `draft_email`, `advance_stage`, `wait_nurture`, `escalate_human`) and
deterministic code **executes** it under the lead's **autonomy**:
- **manual** — AI drafts, never sends.
- **approval** — an AI "send" is **queued** for a human (`POST /:id/send` to approve).
- **auto** — AI **sends** via the mail provider.

> **HARD SAFETY GATE:** real email is sent only when `MAIL_SEND_ENABLED=true` **and** a
> provider (`smtp`|`graph`) is configured. Otherwise everything runs in a **mock outbox**
> — sends are recorded (`mock: true`) but nothing is delivered. `GET /api/meta` →
> `mail.live` shows whether real sending is active. Providers: **SMTP** (e.g. SendGrid /
> O365 app password) or **Microsoft Graph** `Mail.Send` (needs admin‑consented Entra app;
> often blocked on student tenants → SMTP is the easy path). ACS is an easy future add.

### Required metrics
`licensed_users`, `active_users`, `app_mix_score`, `avg_hours_saved_per_user_month`,
`loaded_hourly_cost_usd`, `license_cost_month_usd`, `company_size`
(`adoption_rate` and `enablement_cost_month_usd` are derived/defaulted).

### Examples
```bash
# Create + score + enrich a lead
curl -X POST "http://localhost:3000/api/leads?enrich=true" -H "Content-Type: application/json" -d '{
  "company_name": "Northstar Labs", "industry": "Finance",
  "metrics": { "licensed_users": 2880, "active_users": 1740, "app_mix_score": 934,
    "avg_hours_saved_per_user_month": 4.75, "loaded_hourly_cost_usd": 69.21,
    "license_cost_month_usd": 89280, "company_size": 19628 } }'

# Ask the AI to generate 5 prospects
curl -X POST "http://localhost:3000/api/leads/generate" -H "Content-Type: application/json" \
  -d '{ "count": 5, "prompt": "mid-market finance firms likely to expand Copilot" }'

# Full AI analysis for one lead (pitch, actions, outreach)
curl -X POST "http://localhost:3000/api/leads/<id>/analyze"

# Tailored outreach email
curl -X POST "http://localhost:3000/api/leads/<id>/outreach" -H "Content-Type: application/json" \
  -d '{ "tone": "consultative", "goal": "book a 20-minute value review" }'
```

### Intake: prompt + uploaded leads file (the frontend flow)
`POST /api/leads/intake` is the one call behind "type a prompt, optionally attach a
leads file." It accepts any of:

```jsonc
{
  "prompt": "Import these and find 2 more enterprise energy accounts like Stark", // optional
  "file":   { "content": "<raw CSV / JSON / pasted text>", "type": "csv|json|text|auto" }, // optional
  "rows":   [ { "company": "Globex", "seats": 1200, "active_users": 820 } ],  // optional (pre-parsed)
  "count":  2,        // optional: how many NET-NEW leads to generate
  "enrich": false     // or ?enrich=true
}
```

What it does per request:
1. **Parses the file** — LLM extraction when a provider is configured; otherwise a
   built-in CSV/JSON parser. Messy headers are alias-mapped (`seats`→`licensed_users`,
   `spend`→`license_cost_month_usd`, …).
2. **Completes metrics** — any of the 7 required metrics missing from the file are
   **estimated** (e.g. `license_cost ≈ seats×31`, benchmark adoption), so partial
   exports still score. Estimated fields are reported in `intake.estimated_metrics_for`.
3. **Follows the prompt** — generates `count` net-new leads (seeded by the file leads
   as examples). With a file and no `count`, it imports only; prompt-only behaves
   like `/generate`.
4. **Scores + ranks** every lead, and enriches when `?enrich=true`.

```bash
curl -X POST "http://localhost:3000/api/leads/intake?enrich=true" -H "Content-Type: application/json" -d '{
  "prompt": "Import these and find 2 more energy accounts like Stark",
  "count": 2,
  "file": { "type": "csv", "content": "company,seats,active_users,spend,industry\nGlobex,1200,820,37200,Manufacturing\nStark Industries,5000,4100,155000,Energy" }
}'
```

Response: `{ imported, from_file, generated, intake: { llm_used, source, estimated_metrics_for }, leads: [ …ranked… ] }`.

## Lead shape (response)
```jsonc
{
  "id": "…", "stage": "New", "source": "manual",
  "company_name": "Northstar Labs", "industry": "Finance",
  "contact": { "name": "", "title": "", "email": "" },
  "metrics": { "licensed_users": 2880, "active_users": 1740, "adoption_rate": 0.604, … },
  "scoring": {
    "engine": "python",
    "finance_roi_percent_month": 287.09, "model_roi_percent_month": 298.01,
    "net_value_month_usd": 256315.81, "waste_license_cost_month_usd": 35783.49,
    "expansion_probability": 0.0164, "expansion_recommend": false,
    "lead_score": 46, "priority": "Cool", "rank": 1,
    "components": { "expansion_propensity": 0.0164, "proven_value": 0.957, "recoverable_waste": 0.401, "deal_size": 0.893 }
  },
  "enrichment": {
    "health": "Strong", "sales_pitch": "…", "talking_points": ["…"],
    "value_drivers": ["…"], "risks": ["…"], "recommended_actions": ["…"],
    "outreach": { "subject": "…", "body": "…" }, "model": "…"
  }
}
```

## Lead score
Transparent and tunable; `lead_score = 100 × (` weighted blend of `)`:
- **expansion_propensity** — model expansion probability (ready to expand)
- **proven_value** — finance ROI normalized (`roi/300`, healthy = easier upsell)
- **recoverable_waste** — wasted spend ÷ license spend (a concrete pitch hook)
- **deal_size** — monthly license spend ÷ `LEAD_SCORE_SIZE_REF_USD`

Thresholds → priority: ≥75 `Hot`, ≥50 `Warm`, ≥25 `Cool`, else `Cold`.

## How scoring stays faithful to training
- **Python engine** (`Models/score_batch.py`) loads the actual trained `.pkl`
  models — the same math as `Models/predict.py`.
- **JS engine** loads `Models/artifacts/model_params.json` (coefficients +
  intercepts exported straight from the fitted models by `Models/export_params.py`)
  and replicates the finance model + linear/logistic formulas. Both engines agree
  (e.g. Northstar finance ROI = 287.09%).

## Frontend
The static dashboard in `../frontend/` is served by this backend at `/`
(same‑origin → it just calls `/api/*`). Two pages:
- **`/` (index.html)** — ranked leads, KPIs, account cards, charts, and a per‑lead
  drawer showing the **LLM playbook** (pitch, talking points, risks, actions,
  outreach) with **Analyze** / **Draft email** actions.
- **`/intake.html`** — add leads via prompt + file upload (`/api/leads/intake`),
  generate from a prompt, or enter one manually.

It's a thin renderer: all insights come from `lead.scoring` (models) and
`lead.enrichment` (LLM). Vanilla ES modules + CSS, no build step.

## Notes
- Persistence is a JSON file (`data/leads.json`, git‑ignored) behind a small store
  interface — swap for a real DB later without touching routes.
- The DA (`../Value Realization Agent/`) is left intact; this service supersedes it
  as the product entry point.
- Out of scope (for now): auth, real database, multi‑instance scale‑out. CORS is
  enabled so a separately hosted frontend can also call the API.

## Deploying to Azure
See **[DEPLOY.md](DEPLOY.md)** for the full guide. In short: run the bundled
**one‑command script** (`deploy.ps1` / `deploy.sh`) which builds, tests, and deploys to
**Azure App Service** (Node 20) using the **pure‑JS scoring engine** (no Python at
runtime) and bundles the frontend. Config comes from **App Settings**; the LLM key is
passed to the script (or kept in **Key Vault** via the optional `infra/main.bicep` path).
No CI/CD pipeline — deployment is manual, which suits Azure for Students (no OIDC / app
registration needed).
