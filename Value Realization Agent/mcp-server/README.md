# MCP Local Server

Local MCP server for testing the Copilot Value Analysis plugin.

## Setup

1. From the `mcp-server` folder, install dependencies:

```bash
npm install
```

1. Start the server:

```bash
npm start
```

The server listens on `http://localhost:3001/mcp` and supports two MCP methods:

- `tools/list` — returns the tools described in `appPackage/mcp-tools.json`
- `tools/call` — supports `analyze_copilot_value` (heuristic extraction) and `predict_copilot_value` (runs the trained models)

## predict_copilot_value tool

`predict_copilot_value` shells out to `Models/predict.py`, which loads the trained
`roi_model.pkl`, `waste_model.pkl`, and `expansion_model.pkl` artifacts and returns exact
ROI %, wasted-license cost, an expansion probability, and a first-principles finance breakdown.

Prerequisites:

- Python on `PATH` with the `Models/requirements.txt` packages installed
  (`pip install -r ../../Models/requirements.txt`).
- Trained artifacts present in `Models/artifacts/` (run `python ../../Models/train_models.py`).

Optional environment variables:

- `PYTHON_BIN` — Python executable to use (default `python`).
- `PREDICT_SCRIPT` — path to `predict.py` (default `../../Models/predict.py`).

## Test example (curl)

```bash
# List tools
curl -s -X POST http://localhost:3001/mcp -H "Content-Type: application/json" -d '{"method":"tools/list"}' | jq

# Call analyze tool
curl -s -X POST http://localhost:3001/mcp -H "Content-Type: application/json" -d '{"method":"tools/call","params":{"name":"analyze_copilot_value","arguments":{"source_text":"seats: 200\nactive users: 80\nspend: $12,000","company_name":"Contoso"}}}' | jq

# Call predict tool
curl -s -X POST http://localhost:3001/mcp -H "Content-Type: application/json" -d '{"method":"tools/call","params":{"name":"predict_copilot_value","arguments":{"licensed_users":2880,"active_users":1740,"app_mix_score":934,"avg_hours_saved_per_user_month":4.75,"loaded_hourly_cost_usd":69.21,"license_cost_month_usd":89280,"company_size":19628}}}' | jq
```
