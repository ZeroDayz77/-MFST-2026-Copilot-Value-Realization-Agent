// Scoring service: ranks leads with the trained ROI / waste / expansion models.
// Two faithful engines, both using the real trained parameters:
//   - python: spawns Models/score_batch.py (loads the .pkl models)
//   - js:     replicates the finance model + linear/logistic formulas using the
//             coefficients exported to Models/artifacts/model_params.json
// engine=auto tries python once, then falls back to js for the rest of the run.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import config from '../config.js';

let cachedParams;
let pythonUsable; // undefined=unknown, true/false after first attempt

function round(value, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

async function loadParams() {
  if (cachedParams !== undefined) return cachedParams;
  try {
    const raw = await fsp.readFile(config.scoring.modelParamsPath, 'utf8');
    cachedParams = JSON.parse(raw);
  } catch (err) {
    cachedParams = null;
    console.warn(`[scoring] model_params.json unavailable (${err.message}); JS engine disabled.`);
  }
  return cachedParams;
}

function linearPredict(model, features) {
  let sum = model.intercept;
  model.features.forEach((f, i) => {
    sum += model.coef[i] * (Number(features[f]) || 0);
  });
  return sum;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// Mirrors predict.py: derive adoption/enablement, run finance + the 3 models.
function jsScoreOne(metrics, params) {
  const licensed = Number(metrics.licensed_users) || 0;
  const active = Number(metrics.active_users) || 0;
  const adoption = Number.isFinite(Number(metrics.adoption_rate))
    ? Number(metrics.adoption_rate)
    : licensed
      ? active / licensed
      : 0;
  const enablement = Number(metrics.enablement_cost_month_usd) || 0;

  const feats = {
    licensed_users: licensed,
    active_users: active,
    adoption_rate: adoption,
    app_mix_score: Number(metrics.app_mix_score) || 0,
    avg_hours_saved_per_user_month: Number(metrics.avg_hours_saved_per_user_month) || 0,
    loaded_hourly_cost_usd: Number(metrics.loaded_hourly_cost_usd) || 0,
    license_cost_month_usd: Number(metrics.license_cost_month_usd) || 0,
    company_size: Number(metrics.company_size) || 0,
  };

  const gross =
    feats.avg_hours_saved_per_user_month * active * adoption * feats.loaded_hourly_cost_usd;
  const net = gross - feats.license_cost_month_usd - enablement;
  const roiFinance = feats.license_cost_month_usd
    ? (net / feats.license_cost_month_usd) * 100
    : null;

  const roiModel = linearPredict(params.roi_model, feats);
  const wasteModel = Math.max(linearPredict(params.waste_model, feats), 0);

  const roiForExpansion = Number.isFinite(Number(metrics.roi_percent_month))
    ? Number(metrics.roi_percent_month)
    : roiModel;
  const z = linearPredict(params.expansion_model, { ...feats, roi_percent_month: roiForExpansion });
  const prob = sigmoid(z);

  return {
    ok: true,
    engine: 'js',
    roi_percent_month: round(roiModel, 2),
    waste_license_cost_month_usd: round(wasteModel, 2),
    expansion: {
      probability: round(prob, 4),
      recommend: prob >= 0.5,
      confidence_pct: round(prob * 100, 1),
    },
    finance_model: {
      gross_value_month_usd: round(gross, 2),
      net_value_month_usd: round(net, 2),
      roi_percent_month: roiFinance === null ? null : round(roiFinance, 2),
    },
  };
}

async function jsScore(metricsArray) {
  const params = await loadParams();
  if (!params) {
    throw new Error(
      'JS scoring engine unavailable: model_params.json missing. Run `python Models/export_params.py`.',
    );
  }
  return metricsArray.map((m) => {
    try {
      return jsScoreOne(m, params);
    } catch (err) {
      return { ok: false, engine: 'js', error: err.message };
    }
  });
}

function pythonScore(metricsArray) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(config.scoring.pythonBin, [config.scoring.scoreBatchScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`failed to start python: ${err.message}`));
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('python scoring timed out'));
    }, config.scoring.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`python process error: ${err.message}`));
    });
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error(`could not parse python output (code ${code}): ${stderr || stdout}`));
        return;
      }
      if (parsed && parsed.error) {
        reject(new Error(parsed.error));
        return;
      }
      if (!Array.isArray(parsed)) {
        reject(new Error('python output was not an array'));
        return;
      }
      resolve(parsed.map((r) => (r && r.ok ? { ...r, engine: 'python' } : r)));
    });

    child.stdin.write(JSON.stringify(metricsArray));
    child.stdin.end();
  });
}

// Score an array of canonical metric objects. Always resolves to an aligned
// array of result objects (each tagged with the engine that produced it).
export async function scoreLeads(metricsArray) {
  if (!Array.isArray(metricsArray) || metricsArray.length === 0) return [];
  const engine = config.scoring.engine;

  if (engine === 'js') return jsScore(metricsArray);

  if (engine === 'python') return pythonScore(metricsArray);

  // auto
  if (pythonUsable === false) return jsScore(metricsArray);
  try {
    const result = await pythonScore(metricsArray);
    pythonUsable = true;
    return result;
  } catch (err) {
    pythonUsable = false;
    console.warn(`[scoring] python engine failed (${err.message}); using JS engine.`);
    return jsScore(metricsArray);
  }
}

export async function scoreOne(metrics) {
  const [result] = await scoreLeads([metrics]);
  return result;
}

export async function scoringStatus() {
  const params = await loadParams();
  return {
    engine: config.scoring.engine,
    python_usable: pythonUsable ?? null,
    js_params_loaded: Boolean(params),
    model_params_path: config.scoring.modelParamsPath,
    score_batch_script: config.scoring.scoreBatchScript,
  };
}

export default { scoreLeads, scoreOne, scoringStatus };
