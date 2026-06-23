// End-to-end smoke test: JS scoring engine + mock LLM, isolated temp data file.
// Run with `npm test`. No network or Python required.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

process.env.LLM_PROVIDER = 'mock';
process.env.SCORING_ENGINE = 'js';
process.env.DATA_FILE = path.join(os.tmpdir(), `crm-test-${randomUUID()}.json`);

let server;
let base;

const NORTHSTAR = {
  company_name: 'Northstar Labs',
  industry: 'Finance',
  metrics: {
    licensed_users: 2880,
    active_users: 1740,
    app_mix_score: 934,
    avg_hours_saved_per_user_month: 4.75,
    loaded_hourly_cost_usd: 69.21,
    license_cost_month_usd: 89280,
    company_size: 19628,
  },
};

async function api(method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  const { buildApp } = await import('../src/server.js');
  const app = await buildApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try {
    fs.unlinkSync(process.env.DATA_FILE);
  } catch {
    /* ignore */
  }
});

test('health and meta report mock + js', async () => {
  const health = await api('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');

  const meta = await api('GET', '/api/meta');
  assert.equal(meta.body.llm.provider, 'mock');
  assert.equal(meta.body.scoring.js_params_loaded, true);
  assert.ok(meta.body.lead_score.weights.expansion > 0);
});

test('create scores a lead with finance ROI ~287% and assigns rank', async () => {
  const res = await api('POST', '/api/leads', NORTHSTAR);
  assert.equal(res.status, 201);
  const { scoring } = res.body.lead;
  assert.ok(scoring, 'scoring attached');
  assert.ok(scoring.finance_roi_percent_month > 280 && scoring.finance_roi_percent_month < 295,
    `finance ROI was ${scoring.finance_roi_percent_month}`);
  assert.ok(scoring.waste_license_cost_month_usd > 0);
  assert.equal(typeof scoring.lead_score, 'number');
  assert.equal(scoring.rank, 1);
});

test('rejects a lead missing required metrics (no prompt)', async () => {
  const res = await api('POST', '/api/leads', { company_name: 'Incomplete', metrics: { licensed_users: 100 } });
  assert.equal(res.status, 422);
  assert.ok(res.body.missing.includes('active_users'));
});

test('AI-generate produces ranked leads (mock fallback)', async () => {
  const res = await api('POST', '/api/leads/generate', { count: 3, prompt: 'finance prospects' });
  assert.equal(res.status, 201);
  assert.equal(res.body.leads.length, 3);
  for (const lead of res.body.leads) {
    assert.ok(Number.isFinite(lead.scoring.lead_score));
    assert.ok(Number.isFinite(lead.scoring.rank));
  }
});

test('list is sorted by rank ascending', async () => {
  const res = await api('GET', '/api/leads');
  assert.ok(res.body.count >= 4);
  const ranks = res.body.leads.map((l) => l.scoring.rank);
  const sorted = [...ranks].sort((a, b) => a - b);
  assert.deepEqual(ranks, sorted);
});

test('analyze attaches enrichment with pitch + outreach', async () => {
  const list = await api('GET', '/api/leads');
  const id = list.body.leads[0].id;
  const res = await api('POST', `/api/leads/${id}/analyze`);
  assert.equal(res.status, 200);
  const e = res.body.lead.enrichment;
  assert.ok(e.sales_pitch.length > 0);
  assert.ok(e.recommended_actions.length > 0);
  assert.ok(e.outreach.body.length > 0);
});

test('outreach endpoint returns a subject and body', async () => {
  const list = await api('GET', '/api/leads');
  const id = list.body.leads[0].id;
  const res = await api('POST', `/api/leads/${id}/outreach`, { tone: 'direct', goal: 'book a demo' });
  assert.equal(res.status, 200);
  assert.ok(res.body.outreach.subject.length > 0);
  assert.ok(res.body.outreach.body.length > 0);
});

test('patching metrics re-scores the lead', async () => {
  const created = await api('POST', '/api/leads', NORTHSTAR);
  const id = created.body.lead.id;
  const before = created.body.lead.scoring.finance_roi_percent_month;
  const patched = await api('PATCH', `/api/leads/${id}`, { metrics: { active_users: 2880 } });
  assert.equal(patched.status, 200);
  assert.notEqual(patched.body.lead.scoring.finance_roi_percent_month, before);
});

test('delete removes the lead', async () => {
  const created = await api('POST', '/api/leads', NORTHSTAR);
  const id = created.body.lead.id;
  const del = await api('DELETE', `/api/leads/${id}`);
  assert.equal(del.status, 204);
  const get = await api('GET', `/api/leads/${id}`);
  assert.equal(get.status, 404);
});

test('intake parses a partial CSV file and estimates missing metrics', async () => {
  const csv = [
    'company,seats,active_users,spend,industry',
    'Globex,1200,800,37200,Manufacturing',
    'Initech,300,90,9300,Technology',
  ].join('\n');
  const res = await api('POST', '/api/leads/intake', { file: { content: csv, type: 'csv' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.from_file, 2);
  assert.equal(res.body.generated, 0);
  // app_mix_score, hours, hourly cost, company_size were not in the file:
  assert.equal(res.body.intake.estimated_metrics_for.length, 2);
  const globex = res.body.leads.find((l) => l.company_name === 'Globex');
  assert.ok(globex, 'Globex imported');
  assert.equal(globex.metrics.licensed_users, 1200);
  assert.equal(globex.metrics.active_users, 800);
  assert.equal(globex.metrics.license_cost_month_usd, 37200);
  assert.ok(globex.metrics.app_mix_score >= 100, 'app_mix estimated');
  assert.ok(Number.isFinite(globex.scoring.lead_score));
  assert.ok(Number.isFinite(globex.scoring.rank));
});

test('intake with prompt only generates leads (mock fallback)', async () => {
  const res = await api('POST', '/api/leads/intake', { prompt: 'enterprise finance prospects', count: 4 });
  assert.equal(res.status, 201);
  assert.equal(res.body.from_file, 0);
  assert.equal(res.body.generated, 4);
  assert.equal(res.body.leads.length, 4);
});

test('intake with file + count does both', async () => {
  const csv = 'company,seats,active_users\nUmbrella,900,450';
  const res = await api('POST', '/api/leads/intake', { file: { content: csv }, prompt: 'and 2 similar', count: 2 });
  assert.equal(res.status, 201);
  assert.equal(res.body.from_file, 1);
  assert.equal(res.body.generated, 2);
  assert.equal(res.body.imported, 3);
});

test('intake with no input is rejected', async () => {
  const res = await api('POST', '/api/leads/intake', {});
  assert.equal(res.status, 400);
});
