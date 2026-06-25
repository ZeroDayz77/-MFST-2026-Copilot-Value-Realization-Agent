// Lead domain model: canonical shape, metric normalization, and the transparent
// lead-score that turns the trained-model outputs into a sortable sales priority.

import { randomUUID } from 'node:crypto';

export const PIPELINE_STAGES = [
  'New',
  'Qualified',
  'Contacted',
  'Engaged',
  'Proposal',
  'Won',
  'Lost',
];

// Terminal stages autopilot must never auto-assign (a human closes deals).
export const TERMINAL_STAGES = ['Won', 'Lost'];

export const ACTIVITY_TYPES = [
  'created',
  'scored',
  'analyzed',
  'outreach_drafted',
  'stage_changed',
  'autopilot_run',
  'automation_changed',
  'note',
];

export const PRIORITIES = ['Hot', 'Warm', 'Cool', 'Cold'];

export const REQUIRED_METRICS = [
  'licensed_users',
  'active_users',
  'app_mix_score',
  'avg_hours_saved_per_user_month',
  'loaded_hourly_cost_usd',
  'license_cost_month_usd',
  'company_size',
];

// Friendly aliases accepted from users / the LLM and mapped to canonical keys.
const METRIC_ALIASES = {
  seats: 'licensed_users',
  licensed_seats: 'licensed_users',
  licenses: 'licensed_users',
  licensed: 'licensed_users',
  active: 'active_users',
  monthly_active_users: 'active_users',
  active_seats: 'active_users',
  mau: 'active_users',
  adoption: 'adoption_rate',
  app_mix: 'app_mix_score',
  hours_saved: 'avg_hours_saved_per_user_month',
  avg_hours_saved: 'avg_hours_saved_per_user_month',
  hours: 'avg_hours_saved_per_user_month',
  hourly_cost: 'loaded_hourly_cost_usd',
  loaded_hourly_cost: 'loaded_hourly_cost_usd',
  license_cost: 'license_cost_month_usd',
  monthly_license_cost: 'license_cost_month_usd',
  spend: 'license_cost_month_usd',
  monthly_spend: 'license_cost_month_usd',
  total_spend: 'license_cost_month_usd',
  cost: 'license_cost_month_usd',
  headcount: 'company_size',
  employees: 'company_size',
  size: 'company_size',
  enablement_cost: 'enablement_cost_month_usd',
};

export function toNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;
  const cleaned = String(value).replace(/[$,%\s]/g, '');
  return Number(cleaned);
}

// Normalize an arbitrary metrics-ish object into canonical numeric metrics.
// Returns { metrics, missing } where `missing` lists required keys not supplied.
export function normalizeMetrics(raw = {}) {
  const canonical = {};
  for (const [key, value] of Object.entries(raw)) {
    const mapped = METRIC_ALIASES[key] || key;
    if (canonical[mapped] === undefined) canonical[mapped] = value;
  }

  const metrics = {};
  const missing = [];
  for (const key of REQUIRED_METRICS) {
    const n = toNumber(canonical[key]);
    if (Number.isFinite(n)) {
      metrics[key] = n;
    } else {
      missing.push(key);
    }
  }

  const adoption = toNumber(canonical.adoption_rate);
  if (Number.isFinite(adoption)) {
    metrics.adoption_rate = adoption;
  } else if (metrics.licensed_users) {
    metrics.adoption_rate = metrics.active_users / metrics.licensed_users;
  } else {
    metrics.adoption_rate = 0;
  }

  const enablement = toNumber(canonical.enablement_cost_month_usd);
  metrics.enablement_cost_month_usd = Number.isFinite(enablement) ? enablement : 0;

  const actualRoi = toNumber(canonical.roi_percent_month);
  if (Number.isFinite(actualRoi)) metrics.roi_percent_month = actualRoi;

  return { metrics, missing };
}

export function hasRequiredMetrics(raw = {}) {
  return normalizeMetrics(raw).missing.length === 0;
}

// Like normalizeMetrics, but ESTIMATES any missing required metric from whatever
// is present (used for intake of partial/messy lead files). Returns
// { metrics, estimated } where `estimated` lists the fields that were inferred.
// Heuristics mirror the synthetic data shape (~$31/seat, ~50% benchmark adoption).
export function completeMetrics(raw = {}) {
  const { metrics, missing } = normalizeMetrics(raw);
  if (!missing.length) return { metrics, estimated: [] };

  const has = (k) => Number.isFinite(metrics[k]);
  const adoptionHint = Number(metrics.adoption_rate) > 0 ? Number(metrics.adoption_rate) : null;

  if (!has('licensed_users')) {
    if (has('active_users') && adoptionHint) {
      metrics.licensed_users = Math.round(metrics.active_users / adoptionHint);
    } else if (has('company_size')) {
      metrics.licensed_users = Math.max(1, Math.round(metrics.company_size * 0.12));
    } else if (has('license_cost_month_usd')) {
      metrics.licensed_users = Math.max(1, Math.round(metrics.license_cost_month_usd / 31));
    } else if (has('active_users')) {
      metrics.licensed_users = Math.max(metrics.active_users, Math.round(metrics.active_users / 0.5));
    } else {
      metrics.licensed_users = 100;
    }
  }
  if (!has('active_users')) {
    metrics.active_users = adoptionHint
      ? Math.round(metrics.licensed_users * adoptionHint)
      : Math.round(metrics.licensed_users * 0.5);
  }
  metrics.active_users = Math.max(0, Math.min(metrics.active_users, metrics.licensed_users));

  if (!has('company_size')) {
    metrics.company_size = Math.max(metrics.licensed_users, Math.round(metrics.licensed_users * 6));
  }
  if (!has('license_cost_month_usd')) {
    metrics.license_cost_month_usd = Math.round(metrics.licensed_users * 31);
  }
  if (!has('loaded_hourly_cost_usd')) metrics.loaded_hourly_cost_usd = 65;
  if (!has('avg_hours_saved_per_user_month')) metrics.avg_hours_saved_per_user_month = 4.0;
  if (!has('app_mix_score')) {
    metrics.app_mix_score = Math.max(100, Math.round(metrics.active_users * 0.5));
  }

  metrics.adoption_rate = metrics.licensed_users
    ? metrics.active_users / metrics.licensed_users
    : 0;
  if (!Number.isFinite(metrics.enablement_cost_month_usd)) {
    metrics.enablement_cost_month_usd = 0;
  }

  return { metrics, estimated: missing };
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function priorityFromScore(score) {
  if (score >= 75) return 'Hot';
  if (score >= 50) return 'Warm';
  if (score >= 25) return 'Cool';
  return 'Cold';
}

// Blend the model outputs into a 0-100 acquisition/expansion priority score.
// Transparent and tunable via config weights; components are returned for the UI.
export function computeLeadScore(scoreResult, metrics, weights, sizeRefUsd) {
  const financeRoi = scoreResult?.finance_model?.roi_percent_month;
  const license = metrics.license_cost_month_usd || 0;
  const waste = scoreResult?.waste_license_cost_month_usd || 0;
  const expansion = clamp(Number(scoreResult?.expansion?.probability) || 0, 0, 1);

  const normRoi = clamp((Number(financeRoi) || 0) / 300, 0, 1);
  const wasteOpportunity = license > 0 ? clamp(waste / license, 0, 1) : 0;
  const dealSize = clamp(license / (sizeRefUsd || 100000), 0, 1);

  const components = {
    expansion_propensity: Number(expansion.toFixed(4)),
    proven_value: Number(normRoi.toFixed(4)),
    recoverable_waste: Number(wasteOpportunity.toFixed(4)),
    deal_size: Number(dealSize.toFixed(4)),
  };

  const score01 =
    (weights.expansion || 0) * expansion +
    (weights.value || 0) * normRoi +
    (weights.waste || 0) * wasteOpportunity +
    (weights.size || 0) * dealSize;

  const lead_score = Math.round(clamp(score01, 0, 1) * 100);
  return { lead_score, priority: priorityFromScore(lead_score), components };
}

// Assemble the persisted `scoring` block from a raw engine result.
export function buildScoring(scoreResult, metrics, { weights, sizeRefUsd }) {
  const { lead_score, priority, components } = computeLeadScore(
    scoreResult,
    metrics,
    weights,
    sizeRefUsd,
  );
  const finance = scoreResult.finance_model || {};
  const expansion = scoreResult.expansion || {};
  return {
    engine: scoreResult.engine || 'unknown',
    model_roi_percent_month: scoreResult.roi_percent_month ?? null,
    finance_roi_percent_month: finance.roi_percent_month ?? null,
    gross_value_month_usd: finance.gross_value_month_usd ?? null,
    net_value_month_usd: finance.net_value_month_usd ?? null,
    waste_license_cost_month_usd: scoreResult.waste_license_cost_month_usd ?? null,
    expansion_probability: expansion.probability ?? null,
    expansion_recommend: expansion.recommend ?? null,
    expansion_confidence_pct: expansion.confidence_pct ?? null,
    lead_score,
    priority,
    rank: null,
    components,
    scored_at: new Date().toISOString(),
  };
}

function cleanStage(stage) {
  if (!stage) return 'New';
  const match = PIPELINE_STAGES.find((s) => s.toLowerCase() === String(stage).toLowerCase());
  return match || 'New';
}

function cleanContact(contact = {}) {
  return {
    name: contact.name || '',
    title: contact.title || '',
    email: contact.email || '',
    phone: contact.phone || '',
  };
}

// Build a fresh, fully-shaped lead from a partial payload. Metrics are normalized
// but scoring/enrichment are attached later by their services.
export function newLead(partial = {}, { product } = {}) {
  const now = new Date().toISOString();
  const { metrics } = normalizeMetrics(partial.metrics || partial);
  const stage = cleanStage(partial.stage);
  return {
    id: partial.id || randomUUID(),
    created_at: now,
    updated_at: now,
    source: partial.source || 'manual',
    stage,
    product: partial.product || product || 'Microsoft 365 Copilot',
    company_name: partial.company_name || partial.company || 'Untitled Account',
    industry: partial.industry || '',
    company_segment: partial.company_segment || partial.segment || '',
    company_size: metrics.company_size ?? toNumberOrNull(partial.company_size),
    department: partial.department || '',
    contact: cleanContact(partial.contact),
    metrics,
    scoring: null,
    enrichment: null,
    // Lifecycle + automation
    lifecycle: {
      stage,
      entered_stage_at: now,
      next_action: null,
      next_action_reason: null,
    },
    automation: {
      autopilot: Boolean(partial.automation?.autopilot),
      last_run_at: null,
    },
    activities: [],
    notes: partial.notes || '',
    tags: Array.isArray(partial.tags) ? partial.tags : [],
  };
}

// Append a timeline activity (newest entries are read first by the UI). Capped to
// avoid unbounded growth in the JSON store.
export function addActivity(lead, { type, summary, actor = 'system', stage_from, stage_to } = {}) {
  if (!Array.isArray(lead.activities)) lead.activities = [];
  lead.activities.push({
    id: randomUUID(),
    at: new Date().toISOString(),
    actor,
    type,
    summary: String(summary || ''),
    ...(stage_from ? { stage_from } : {}),
    ...(stage_to ? { stage_to } : {}),
  });
  if (lead.activities.length > 100) {
    lead.activities = lead.activities.slice(-100);
  }
  return lead;
}

// Change a lead's stage, recording the transition on the timeline + lifecycle.
// Returns true if the stage actually changed.
export function setStage(lead, stage, actor = 'user') {
  const next = cleanStage(stage);
  const prev = lead.stage;
  if (next === prev) return false;
  lead.stage = next;
  lead.lifecycle = lead.lifecycle || {};
  lead.lifecycle.stage = next;
  lead.lifecycle.entered_stage_at = new Date().toISOString();
  addActivity(lead, {
    type: 'stage_changed',
    actor,
    summary: `Stage moved ${prev} → ${next}`,
    stage_from: prev,
    stage_to: next,
  });
  lead.updated_at = new Date().toISOString();
  return true;
}

function toNumberOrNull(value) {
  const n = toNumber(value);
  return Number.isFinite(n) ? n : null;
}

// Apply a partial update to an existing lead. Re-normalizes metrics if provided.
export function applyLeadPatch(lead, patch = {}) {
  const updated = { ...lead };
  // Stage is handled separately (via setStage) so transitions get logged.
  const editableScalars = [
    'product',
    'company_name',
    'industry',
    'company_segment',
    'department',
    'notes',
  ];
  for (const key of editableScalars) {
    if (patch[key] !== undefined) updated[key] = patch[key];
  }
  if (patch.contact) updated.contact = cleanContact({ ...lead.contact, ...patch.contact });
  if (Array.isArray(patch.tags)) updated.tags = patch.tags;

  if (patch.metrics || patch.company_size !== undefined) {
    const merged = { ...lead.metrics, ...(patch.metrics || {}) };
    if (patch.company_size !== undefined) merged.company_size = patch.company_size;
    updated.metrics = normalizeMetrics(merged).metrics;
    updated.company_size = updated.metrics.company_size ?? lead.company_size;
  }

  updated.updated_at = new Date().toISOString();
  return updated;
}
