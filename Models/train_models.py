# train_models.py

import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.metrics import (
    r2_score,
    mean_absolute_error,
    mean_squared_error,
    accuracy_score
)

# ---------------------------------------------------
# PATHS
# ---------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "Training Data" / "copilot_value_realization_mock_data.csv"
OUTPUT_DIR = BASE_DIR / "artifacts"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------
# LOAD DATA
# ---------------------------------------------------

df = pd.read_csv(DATA_PATH)

print(f"Loaded {len(df)} rows")

# ---------------------------------------------------
# MODEL 1
# ROI PREDICTION
# ---------------------------------------------------

roi_features = [
    "licensed_users",
    "active_users",
    "adoption_rate",
    "app_mix_score",
    "avg_hours_saved_per_user_month",
    "loaded_hourly_cost_usd",
    "license_cost_month_usd",
    "company_size"
]

roi_target = "roi_percent_month"

X_roi = df[roi_features]
y_roi = df[roi_target]

X_train, X_test, y_train, y_test = train_test_split(
    X_roi,
    y_roi,
    test_size=0.2,
    random_state=42
)

roi_model = LinearRegression()
roi_model.fit(X_train, y_train)

roi_predictions = roi_model.predict(X_test)

print("\nROI MODEL")
print(f"R2: {r2_score(y_test, roi_predictions):.4f}")
print(f"MAE: {mean_absolute_error(y_test, roi_predictions):.2f}")

joblib.dump(
    roi_model,
    OUTPUT_DIR / "roi_model.pkl"
)

# ---------------------------------------------------
# MODEL 2
# WASTE PREDICTION
# ---------------------------------------------------

waste_features = [
    "licensed_users",
    "active_users",
    "adoption_rate",
    "license_cost_month_usd",
    "app_mix_score"
]

waste_target = "waste_license_cost_month_usd"

X_waste = df[waste_features]
y_waste = df[waste_target]

X_train, X_test, y_train, y_test = train_test_split(
    X_waste,
    y_waste,
    test_size=0.2,
    random_state=42
)

waste_model = LinearRegression()
waste_model.fit(X_train, y_train)

waste_predictions = waste_model.predict(X_test)

print("\nWASTE MODEL")
print(f"R2: {r2_score(y_test, waste_predictions):.4f}")
print(f"MAE: {mean_absolute_error(y_test, waste_predictions):.2f}")

joblib.dump(
    waste_model,
    OUTPUT_DIR / "waste_model.pkl"
)

# ---------------------------------------------------
# MODEL 3
# EXPANSION RECOMMENDATION
# ---------------------------------------------------

df["expansion_binary"] = (
    df["expansion_recommendation_flag"]
      .map({"Yes": 1, "No": 0})
)

expansion_features = [
    "active_users",
    "adoption_rate",
    "app_mix_score",
    "avg_hours_saved_per_user_month",
    "loaded_hourly_cost_usd",
    "roi_percent_month"
]

expansion_target = "expansion_binary"

X_exp = df[expansion_features]
y_exp = df[expansion_target]

X_train, X_test, y_train, y_test = train_test_split(
    X_exp,
    y_exp,
    test_size=0.2,
    random_state=42
)

expansion_model = LogisticRegression(
    max_iter=5000
)

expansion_model.fit(
    X_train,
    y_train
)

predictions = expansion_model.predict(
    X_test
)

print("\nEXPANSION MODEL")
print(
    f"Accuracy: {accuracy_score(y_test, predictions):.4f}"
)

joblib.dump(
    expansion_model,
    OUTPUT_DIR / "expansion_model.pkl"
)

# ---------------------------------------------------
# SAVE FEATURE CONFIG
# ---------------------------------------------------

feature_config = {
    "roi_model": roi_features,
    "waste_model": waste_features,
    "expansion_model": expansion_features
}

with open(OUTPUT_DIR / "feature_columns.json", "w") as f:
    json.dump(
        feature_config,
        f,
        indent=4
    )

# ---------------------------------------------------
# EXPORT CHARTS
# ---------------------------------------------------

plt.figure(figsize=(8, 6))
plt.scatter(
    df["adoption_rate"],
    df["roi_percent_month"],
    alpha=0.25
)

z = np.polyfit(
    df["adoption_rate"],
    df["roi_percent_month"],
    1
)

p = np.poly1d(z)

x_line = np.linspace(
    df["adoption_rate"].min(),
    df["adoption_rate"].max(),
    100
)

plt.plot(
    x_line,
    p(x_line),
    color="red",
    linewidth=3
)

plt.title("Adoption Rate vs ROI")
plt.xlabel("Adoption Rate")
plt.ylabel("ROI %")

plt.savefig(
    OUTPUT_DIR / "roi_regression_chart.png",
    bbox_inches="tight"
)

plt.close()

# ---------------------------------------------------
# COEFFICIENT REPORT
# ---------------------------------------------------

print("\nROI COEFFICIENTS")

for feature, coef in zip(
    roi_features,
    roi_model.coef_
):
    print(
        f"{feature}: {coef:.4f}"
    )

print(
    f"Intercept: {roi_model.intercept_:.4f}"
)

print("\nFiles Generated:")
print(OUTPUT_DIR / "roi_model.pkl")
print(OUTPUT_DIR / "waste_model.pkl")
print(OUTPUT_DIR / "expansion_model.pkl")
print(OUTPUT_DIR / "feature_columns.json")
print(OUTPUT_DIR / "roi_regression_chart.png")
