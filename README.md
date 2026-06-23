# MFST 2026 — Copilot Value Realization Agent → AI‑Powered CRM

An AI‑powered CRM that helps sales reps **acquire and expand** a product (Copilot,
for now). Users bring or AI‑generate **leads**; every lead is **automatically
ranked** by trained models and enriched by an LLM with a nuanced sales pitch,
recommended actions, and ready‑to‑send outreach — surfaced on a Monday‑style
dashboard.

This started as a Microsoft 365 **Declarative Agent (DA)**. It has pivoted to a
**web service + LLM engine**: the DA's per‑conversation reasoning now runs
**per‑lead** inside a backend that powers the CRM.

## Repository layout
| Folder | Role |
|--------|------|
| **`backend/`** | **The middle layer / engine (start here).** Node/Express service: lead CRUD, AI generate, per‑lead model ranking, and LLM enrichment (pitch, actions, outreach). See [`backend/README.md`](backend/README.md). |
| `Models/` | Python ML layer. Trains & serves ROI / waste / expansion models (`train_models.py`, `predict.py`, `score_batch.py`, `export_params.py`). |
| `Value Realization Agent/` | The original M365 Declarative Agent (left intact; superseded by `backend/` as the entry point). |

## Quick start
```bash
# 1) ML params for the backend's JS scoring engine (one‑time)
cd Models && python export_params.py && cd ..

# 2) Backend (runs in mock mode with no LLM keys)
cd backend && npm install && npm start    # http://localhost:3000/api/meta
```

## How it works
1. A lead's Copilot metrics are scored by the **trained models** (Python `.pkl`s, or
   an exact pure‑JS replica using the exported coefficients) → ROI, wasted spend,
   expansion probability → a 0–100 **lead score**, **priority**, and **rank**.
2. An **LLM API** (Azure OpenAI by default) turns those numbers into a per‑lead
   **sales playbook** + **outreach email**. No keys → deterministic, numbers‑grounded
   fallback so demos always work.

See [`backend/README.md`](backend/README.md) for the full API and configuration.