// Client-side CSV export for leads. CSV opens natively in Excel, so this covers
// "export to Excel or CSV" with no dependencies and no backend round-trip.

import { n, adoptionPct } from './format.js';

// Stable, flattened column set. [header, accessor(lead)].
const COLUMNS = [
  ['Rank', (l) => l.scoring?.rank ?? ''],
  ['Company', (l) => l.company_name || ''],
  ['Industry', (l) => l.industry || ''],
  ['Segment', (l) => l.company_segment || ''],
  ['Department', (l) => l.department || ''],
  ['Stage', (l) => l.stage || ''],
  ['Priority', (l) => l.scoring?.priority || ''],
  ['Lead Score', (l) => fmtNum(l.scoring?.lead_score)],
  ['Contact Name', (l) => l.contact?.name || ''],
  ['Contact Title', (l) => l.contact?.title || ''],
  ['Contact Email', (l) => l.contact?.email || ''],
  ['Licensed Users', (l) => fmtNum(l.metrics?.licensed_users)],
  ['Active Users', (l) => fmtNum(l.metrics?.active_users)],
  ['Adoption %', (l) => round(adoptionPct(l.metrics || {}), 1)],
  ['App Mix Score', (l) => fmtNum(l.metrics?.app_mix_score)],
  ['Hours Saved / User / Mo', (l) => fmtNum(l.metrics?.avg_hours_saved_per_user_month)],
  ['Loaded Hourly Cost USD', (l) => fmtNum(l.metrics?.loaded_hourly_cost_usd)],
  ['License Cost / Mo USD', (l) => fmtNum(l.metrics?.license_cost_month_usd)],
  ['Company Size', (l) => fmtNum(l.metrics?.company_size)],
  ['Finance ROI %', (l) => round(l.scoring?.finance_roi_percent_month, 1)],
  ['Model ROI %', (l) => round(l.scoring?.model_roi_percent_month, 1)],
  ['Gross Value / Mo USD', (l) => round(l.scoring?.gross_value_month_usd, 0)],
  ['Net Value / Mo USD', (l) => round(l.scoring?.net_value_month_usd, 0)],
  ['Waste / Mo USD', (l) => round(l.scoring?.waste_license_cost_month_usd, 0)],
  ['Expansion Probability', (l) => round(l.scoring?.expansion_probability, 4)],
  ['Expansion Recommend', (l) => boolStr(l.scoring?.expansion_recommend)],
  ['Autopilot', (l) => boolStr(l.automation?.autopilot)],
  ['AI Autonomy', (l) => l.automation?.autonomy || ''],
  ['Outreach Status', (l) => l.enrichment?.outreach?.status || ''],
  ['Source', (l) => l.source || ''],
  ['Created At', (l) => l.created_at || ''],
];

function fmtNum(v) {
  return Number.isFinite(Number(v)) ? Number(v) : '';
}
function round(v, d) {
  return Number.isFinite(Number(v)) ? Number(Number(v).toFixed(d)) : '';
}
function boolStr(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  return '';
}

// RFC-4180 style escaping: wrap in quotes when the value has a comma, quote, or
// newline; double up embedded quotes.
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function leadsToCsv(leads) {
  const header = COLUMNS.map((c) => csvCell(c[0])).join(',');
  const rows = (leads || []).map((lead) =>
    COLUMNS.map((c) => csvCell(c[1](lead))).join(','),
  );
  return [header, ...rows].join('\r\n');
}

export function downloadCsv(leads, filename) {
  const csv = leadsToCsv(leads);
  // UTF-8 BOM so Excel renders accented characters correctly.
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = filename || `value-iq-leads-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default { leadsToCsv, downloadCsv };
