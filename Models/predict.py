# predict.py
#
# Serving layer for the Copilot Value Realization Agent.
#
# Loads the three trained models (roi_model.pkl, waste_model.pkl,
# expansion_model.pkl) plus feature_columns.json, accepts a single set of
# company/department inputs as JSON, and returns ROI %, wasted-license cost,
# and an expansion-recommendation probability.
#
# Usage:
#   echo '{"licensed_users": 2880, ...}' | python predict.py
#   python predict.py --json '{"licensed_users": 2880, ...}'
#
# The expansion model consumes roi_percent_month. When the caller does not
# supply an actual ROI, the ROI model's own prediction is chained in, matching
# the customer_data -> ROI -> Waste -> Expansion pipeline in the project brief.

import os
import sys
import json
import argparse
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent
ARTIFACTS_DIR = Path(os.environ.get("ARTIFACTS_DIR", BASE_DIR / "artifacts"))

# Raw inputs the caller must provide. adoption_rate and roi_percent_month are
# derived when missing, so they are intentionally not required here.
REQUIRED_INPUTS = [
    "licensed_users",
    "active_users",
    "app_mix_score",
    "avg_hours_saved_per_user_month",
    "loaded_hourly_cost_usd",
    "license_cost_month_usd",
    "company_size"
]

MODEL_FILES = {
    "roi_model": "roi_model.pkl",
    "waste_model": "waste_model.pkl",
    "expansion_model": "expansion_model.pkl"
}


def load_artifacts():
    config_path = ARTIFACTS_DIR / "feature_columns.json"
    if not config_path.exists():
        raise FileNotFoundError(
            f"feature_columns.json not found in {ARTIFACTS_DIR}. "
            "Run train_models.py first."
        )

    with open(config_path) as f:
        feature_config = json.load(f)

    models = {}
    for key, filename in MODEL_FILES.items():
        model_path = ARTIFACTS_DIR / filename
        if not model_path.exists():
            raise FileNotFoundError(
                f"{filename} not found in {ARTIFACTS_DIR}. "
                "Run train_models.py first."
            )
        models[key] = joblib.load(model_path)

    return feature_config, models


def coerce_numeric(value):
    if isinstance(value, str):
        value = value.replace(",", "").replace("$", "").replace("%", "").strip()
    return float(value)


def normalize_inputs(raw_inputs):
    inputs = {}
    missing = []

    for key in REQUIRED_INPUTS:
        if key not in raw_inputs or raw_inputs[key] in (None, ""):
            missing.append(key)
            continue
        try:
            inputs[key] = coerce_numeric(raw_inputs[key])
        except (TypeError, ValueError):
            missing.append(key)

    if missing:
        raise ValueError(
            "Missing or invalid required inputs: " + ", ".join(missing)
        )

    if raw_inputs.get("adoption_rate") not in (None, ""):
        inputs["adoption_rate"] = coerce_numeric(raw_inputs["adoption_rate"])
    else:
        inputs["adoption_rate"] = (
            inputs["active_users"] / inputs["licensed_users"]
            if inputs["licensed_users"] else 0.0
        )

    # Optional analytic-model input; defaults to 0 when not supplied.
    inputs["enablement_cost_month_usd"] = (
        coerce_numeric(raw_inputs["enablement_cost_month_usd"])
        if raw_inputs.get("enablement_cost_month_usd") not in (None, "")
        else 0.0
    )

    # Optional actual ROI override for the expansion model.
    if raw_inputs.get("roi_percent_month") not in (None, ""):
        inputs["roi_percent_month_actual"] = coerce_numeric(
            raw_inputs["roi_percent_month"]
        )

    return inputs


def finance_value_model(inputs):
    """First-principles ROI, replicating the synthetic data generator."""
    gross_value = (
        inputs["avg_hours_saved_per_user_month"]
        * inputs["active_users"]
        * inputs["adoption_rate"]
        * inputs["loaded_hourly_cost_usd"]
    )
    license_cost = inputs["license_cost_month_usd"]
    net_value = gross_value - license_cost - inputs["enablement_cost_month_usd"]
    roi_percent = (net_value / license_cost * 100.0) if license_cost else None

    return {
        "gross_value_month_usd": round(gross_value, 2),
        "net_value_month_usd": round(net_value, 2),
        "roi_percent_month": round(roi_percent, 2) if roi_percent is not None else None
    }


def predict(raw_inputs):
    feature_config, models = load_artifacts()
    inputs = normalize_inputs(raw_inputs)

    feature_row = dict(inputs)

    # Model 1: ROI %
    roi_features = feature_config["roi_model"]
    roi_df = pd.DataFrame([{f: feature_row[f] for f in roi_features}])[roi_features]
    roi_pred = float(models["roi_model"].predict(roi_df)[0])

    # Model 2: wasted license cost
    waste_features = feature_config["waste_model"]
    waste_df = pd.DataFrame([{f: feature_row[f] for f in waste_features}])[waste_features]
    waste_pred = float(models["waste_model"].predict(waste_df)[0])
    waste_pred = max(waste_pred, 0.0)

    # Model 3: expansion recommendation. Chain in predicted ROI unless the
    # caller supplied an actual ROI to score against.
    roi_for_expansion = inputs.get("roi_percent_month_actual", roi_pred)
    feature_row["roi_percent_month"] = roi_for_expansion

    expansion_features = feature_config["expansion_model"]
    exp_df = pd.DataFrame([{f: feature_row[f] for f in expansion_features}])[expansion_features]
    exp_prob = float(models["expansion_model"].predict_proba(exp_df)[0][1])

    analytic = finance_value_model(inputs)

    return {
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
            "roi_source": "actual" if "roi_percent_month_actual" in inputs else "predicted"
        },
        "roi": {
            "roi_percent_month": round(roi_pred, 2)
        },
        "waste": {
            "waste_license_cost_month_usd": round(waste_pred, 2)
        },
        "expansion": {
            "probability": round(exp_prob, 4),
            "recommend": bool(exp_prob >= 0.5),
            "confidence_pct": round(exp_prob * 100.0, 1)
        },
        "finance_model": analytic,
        "model_metadata": {
            "roi_model": "LinearRegression (R^2 ~ 0.85)",
            "waste_model": "LinearRegression (R^2 ~ 0.999)",
            "expansion_model": "LogisticRegression (accuracy ~ 0.95)",
            "note": "Trained on synthetic data; treat outputs as directional."
        }
    }


def read_raw_inputs():
    parser = argparse.ArgumentParser(description="Copilot value prediction serving layer.")
    parser.add_argument("--json", dest="json_str", help="Inputs as a JSON string.")
    args = parser.parse_args()

    if args.json_str:
        return json.loads(args.json_str)

    if not sys.stdin.isatty():
        stdin_data = sys.stdin.read().strip()
        if stdin_data:
            return json.loads(stdin_data)

    raise ValueError(
        "No input provided. Pass inputs via stdin or --json '<json>'."
    )


def main():
    try:
        raw_inputs = read_raw_inputs()
        result = predict(raw_inputs)
        print(json.dumps(result, indent=2))
        return 0
    except Exception as exc:  # noqa: BLE001 - surface a clean JSON error to callers
        print(json.dumps({"error": str(exc)}, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
