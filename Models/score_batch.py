# score_batch.py
#
# Batch scoring layer for the CRM backend. Reuses the trained models loaded by
# predict.py and scores an ARRAY of leads in a single Python process (artifacts
# are loaded once, not per lead). This is what the Node scoring service spawns
# when SCORING_ENGINE is python/auto.
#
# Input  (stdin or --json): a JSON array of metric objects, or {"leads": [...]}.
# Output (stdout): a JSON array aligned to the input; each item is either
#   { "ok": true, roi_percent_month, waste_license_cost_month_usd, expansion{...},
#     finance_model{...}, inputs_used{...} }
# or
#   { "ok": false, "error": "<message>" }
#
# Usage:
#   echo '[{"licensed_users":2880, ...}]' | python score_batch.py
#   python score_batch.py --json '[{...}, {...}]'

import sys
import json
import argparse

import pandas as pd

from predict import (
    load_artifacts,
    normalize_inputs,
    finance_value_model,
)


def _predict_one(raw_inputs, feature_config, models):
    inputs = normalize_inputs(raw_inputs)
    feature_row = dict(inputs)

    roi_features = feature_config["roi_model"]
    roi_df = pd.DataFrame([{f: feature_row[f] for f in roi_features}])[roi_features]
    roi_pred = float(models["roi_model"].predict(roi_df)[0])

    waste_features = feature_config["waste_model"]
    waste_df = pd.DataFrame([{f: feature_row[f] for f in waste_features}])[waste_features]
    waste_pred = max(float(models["waste_model"].predict(waste_df)[0]), 0.0)

    roi_for_expansion = inputs.get("roi_percent_month_actual", roi_pred)
    feature_row["roi_percent_month"] = roi_for_expansion

    expansion_features = feature_config["expansion_model"]
    exp_df = pd.DataFrame([{f: feature_row[f] for f in expansion_features}])[expansion_features]
    exp_prob = float(models["expansion_model"].predict_proba(exp_df)[0][1])

    analytic = finance_value_model(inputs)

    return {
        "ok": True,
        "roi_percent_month": round(roi_pred, 2),
        "waste_license_cost_month_usd": round(waste_pred, 2),
        "expansion": {
            "probability": round(exp_prob, 4),
            "recommend": bool(exp_prob >= 0.5),
            "confidence_pct": round(exp_prob * 100.0, 1),
        },
        "finance_model": analytic,
        "inputs_used": {
            "licensed_users": inputs["licensed_users"],
            "active_users": inputs["active_users"],
            "adoption_rate": round(inputs["adoption_rate"], 4),
            "app_mix_score": inputs["app_mix_score"],
            "avg_hours_saved_per_user_month": inputs["avg_hours_saved_per_user_month"],
            "loaded_hourly_cost_usd": inputs["loaded_hourly_cost_usd"],
            "license_cost_month_usd": inputs["license_cost_month_usd"],
            "company_size": inputs["company_size"],
            "enablement_cost_month_usd": inputs["enablement_cost_month_usd"],
            "roi_percent_month_for_expansion": round(roi_for_expansion, 2),
            "roi_source": "actual" if "roi_percent_month_actual" in inputs else "predicted",
        },
    }


def score_batch(rows):
    feature_config, models = load_artifacts()
    results = []
    for raw in rows:
        try:
            results.append(_predict_one(raw, feature_config, models))
        except Exception as exc:  # noqa: BLE001 - per-row error, keep batch going
            results.append({"ok": False, "error": str(exc)})
    return results


def read_rows():
    parser = argparse.ArgumentParser(description="Batch Copilot value scorer.")
    parser.add_argument("--json", dest="json_str", help="Leads as a JSON array string.")
    args = parser.parse_args()

    payload = None
    if args.json_str:
        payload = json.loads(args.json_str)
    elif not sys.stdin.isatty():
        data = sys.stdin.read().strip()
        if data:
            payload = json.loads(data)

    if payload is None:
        raise ValueError("No input provided. Pass a JSON array via stdin or --json.")

    if isinstance(payload, dict) and "leads" in payload:
        payload = payload["leads"]
    if not isinstance(payload, list):
        raise ValueError("Input must be a JSON array of lead objects.")
    return payload


def main():
    try:
        rows = read_rows()
        print(json.dumps(score_batch(rows)))
        return 0
    except Exception as exc:  # noqa: BLE001 - surface a clean JSON error
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
