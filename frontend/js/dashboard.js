// Dashboard controller. Loads meta + leads from the backend and renders KPIs,
// the ranked lead table, company cards, and charts. Every value shown comes from
// the backend (model scores) — no client-side insight fabrication.

import { api } from './api.js';
import { store } from './store.js';
import { renderCharts, palette } from './charts.js';
import { openLeadDrawer } from './leadDetail.js';
import { toast, busy } from './toast.js';
import {
  fmtUsd, fmtInt, fmtPct, n, esc, roiClass, priorityClass, adoptionPct,
} from './format.js';

let sortState = { key: 'rank', dir: 'asc' };

const $ = (id) => document.getElementById(id);

function setText(id, text) {
  const node = $(id);
  if (node) node.textContent = text;
}

// ── KPIs ──────────────────────────────────────────────────────────────────
function renderKpis(totals) {
  setText('kpiPortfolioRoi', fmtPct(totals.roiPct, 0));
  setText('kpiGrossValue', fmtUsd(totals.gross));
  setText('kpiNetValue', fmtUsd(totals.net));
  setText('kpiActiveUsers', fmtInt(totals.active));
  setText('kpiActiveUsersMeta', `${fmtPct(totals.adoptionPct, 1)} overall adoption`);
  setText('kpiWastedSpend', fmtUsd(totals.waste));
}

// ── Lead table ──────────────────────────────────────────────────────────────
function sortValue(lead, key) {
  const s = lead.scoring || {};
  const m = lead.metrics || {};
  switch (key) {
    case 'company': return (lead.company_name || '').toLowerCase();
    case 'priority': return ({ Hot: 4, Warm: 3, Cool: 2, Cold: 1 })[s.priority] || 0;
    case 'leadScore': return n(s.lead_score);
    case 'roi': return n(s.finance_roi_percent_month);
    case 'netValue': return n(s.net_value_month_usd);
    case 'adoption': return adoptionPct(m);
    case 'stage': return (lead.stage || '').toLowerCase();
    case 'rank':
    default: return n(s.rank) || Number.POSITIVE_INFINITY;
  }
}

function sortedLeads() {
  const leads = [...store.leads];
  const { key, dir } = sortState;
  const mul = dir === 'desc' ? -1 : 1;
  return leads.sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  });
}

function renderLeadTable() {
  const tbody = $('leadTableBody');
  if (!tbody) return;
  const leads = sortedLeads();

  if (!leads.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="loading-row">No leads yet. Use “Add Leads” to import a file or generate with a prompt.</td></tr>';
    return;
  }

  tbody.innerHTML = leads.map((lead) => {
    const s = lead.scoring || {};
    const m = lead.metrics || {};
    const roi = Number.isFinite(Number(s.finance_roi_percent_month)) ? fmtPct(s.finance_roi_percent_month, 1) : '—';
    const net = Number.isFinite(Number(s.net_value_month_usd)) ? fmtUsd(s.net_value_month_usd) : '—';
    const score = Number.isFinite(Number(s.lead_score)) ? Math.round(s.lead_score) : '—';
    return `
      <tr class="lead-row" data-id="${esc(lead.id)}">
        <td class="mono">${s.rank ?? '—'}</td>
        <td><strong>${esc(lead.company_name || 'Untitled')}</strong></td>
        <td><span class="priority-chip ${priorityClass(s.priority)}">${esc(s.priority || 'Unknown')}</span></td>
        <td class="mono">${score}</td>
        <td class="mono">${roi}</td>
        <td class="mono">${net}</td>
        <td class="mono">${fmtPct(adoptionPct(m), 1)}</td>
        <td>${esc(lead.stage || 'New')}</td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('tr.lead-row').forEach((row) => {
    row.addEventListener('click', () => openLeadDrawer(row.dataset.id, { onChange: refresh }));
  });
  updateSortHeaders();
}

function updateSortHeaders() {
  document.querySelectorAll('th.sortable').forEach((th) => {
    const ind = th.querySelector('.sort-indicator');
    if (!ind) return;
    if (th.dataset.sort === sortState.key) ind.textContent = sortState.dir === 'asc' ? '↑' : '↓';
    else ind.textContent = '↕';
  });
}

function initSorting() {
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortState.key === key) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      else sortState = { key, dir: key === 'company' || key === 'stage' ? 'asc' : 'desc' };
      renderLeadTable();
    });
  });
}

// ── Company cards (aggregate by company, open top lead) ──────────────────────
function aggregateCompanies() {
  const map = new Map();
  for (const lead of store.leads) {
    const name = lead.company_name || 'Untitled Account';
    if (!map.has(name)) {
      map.set(name, { name, licensed: 0, active: 0, gross: 0, net: 0, spend: 0, waste: 0, topLead: lead });
    }
    const row = map.get(name);
    const m = lead.metrics || {};
    const s = lead.scoring || {};
    row.licensed += n(m.licensed_users);
    row.active += n(m.active_users);
    row.gross += n(s.gross_value_month_usd);
    row.net += n(s.net_value_month_usd);
    row.spend += n(m.license_cost_month_usd);
    row.waste += n(s.waste_license_cost_month_usd);
    if (n(s.lead_score) > n(row.topLead.scoring?.lead_score)) row.topLead = lead;
  }
  return [...map.values()].map((r) => ({
    ...r,
    adoptionRate: r.licensed > 0 ? r.active / r.licensed : 0,
    roiPercent: r.spend > 0 ? (r.net / r.spend) * 100 : 0,
  })).sort((a, b) => b.net - a.net);
}

function renderCompanyCards(companies) {
  const grid = $('companyGrid');
  if (!grid) return;
  if (!companies.length) {
    grid.innerHTML = '<div class="company-card"><div class="company-name">No leads yet</div><div class="metric-row"><span class="metric-key">Next step</span><span class="metric-val">Add Leads →</span></div></div>';
    return;
  }
  grid.innerHTML = companies.map((c, i) => {
    const color = palette[i % palette.length];
    const roi = roiClass(c.roiPercent);
    const idle = Math.max(c.licensed - c.active, 0);
    const initial = (c.name.trim().charAt(0) || 'A').toUpperCase();
    return `
      <div class="company-card" data-id="${esc(c.topLead.id)}">
        <div class="glow" style="background:${color}"></div>
        <div class="company-name">
          <div class="company-avatar" style="background:${color}2e;color:${color}">${esc(initial)}</div>
          ${esc(c.name)}
          <span class="roi-pill" style="background:${roi.bg};color:${roi.fg};margin-left:auto">${fmtPct(c.roiPercent, 0)} ROI</span>
        </div>
        <div class="metric-row"><span class="metric-key">Licensed Users</span><span class="metric-val">${fmtInt(c.licensed)}</span></div>
        <div class="metric-row"><span class="metric-key">Active Users</span><span class="metric-val">${fmtInt(c.active)}</span></div>
        <div class="metric-row"><span class="metric-key">Net Value</span><span class="metric-val" style="color:var(--accent4)">${fmtUsd(c.net)}</span></div>
        <div class="metric-row"><span class="metric-key">Monthly Spend</span><span class="metric-val">${fmtUsd(c.spend)}</span></div>
        <div class="metric-row"><span class="metric-key">Waste Cost</span><span class="metric-val" style="color:var(--danger)">${fmtUsd(c.waste)}</span></div>
        <div class="adoption-bar-wrap">
          <div class="adoption-label"><span>Adoption Rate</span><span>${fmtPct(c.adoptionRate * 100, 1)}</span></div>
          <div class="adoption-track"><div class="adoption-fill" style="width:${Math.min(c.adoptionRate * 100, 100)}%;background:linear-gradient(90deg,${color},var(--accent2))"></div></div>
        </div>
        <div class="kpi-meta" style="margin-top:8px">${fmtInt(idle)} idle seats</div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.company-card[data-id]').forEach((card) => {
    card.addEventListener('click', () => openLeadDrawer(card.dataset.id, { onChange: refresh }));
  });
}

// ── Meta badge ───────────────────────────────────────────────────────────────
function renderMeta(totals, companyCount) {
  const meta = store.meta || {};
  const llm = meta.llm || {};
  const provider = llm.provider === 'mock' ? 'mock (no LLM key)' : `${llm.provider} · ${llm.model || ''}`;
  setText('portfolioHeaderMeta',
    `${store.leads.length} leads · ${companyCount} companies · AI: ${provider} · scoring: ${meta.scoring?.engine || '—'}`);
}

// ── Orchestration ────────────────────────────────────────────────────────────
function renderAll() {
  const totals = store.totals();
  const companies = aggregateCompanies();
  renderKpis(totals);
  renderLeadTable();
  renderCompanyCards(companies);
  renderCharts(companies);
  renderMeta(totals, companies.length);
}

async function refresh() {
  await store.load();
  renderAll();
}

function loadError(message) {
  setText('portfolioHeaderMeta', `Connection error: ${message}`);
  const grid = $('companyGrid');
  if (grid) {
    grid.innerHTML = `<div class="company-card"><div class="company-name">Backend unreachable</div>
      <div class="metric-row"><span class="metric-key">Details</span><span class="metric-val">${esc(message)}</span></div>
      <div class="metric-row"><span class="metric-key">API</span><span class="metric-val">${esc(api.base)}</span></div></div>`;
  }
  const tbody = $('leadTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="loading-row">Could not load leads: ${esc(message)}</td></tr>`;
}

function initToolbar() {
  const rankBtn = $('rerankBtn');
  if (rankBtn) {
    rankBtn.addEventListener('click', async () => {
      const restore = busy(rankBtn, 'Ranking…');
      try {
        await api.rank();
        await refresh();
        toast('Leads re-ranked', 'success');
      } catch (e) {
        toast(`Re-rank failed: ${e.message}`, 'error');
      } finally {
        restore();
      }
    });
  }
  const refreshBtn = $('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const restore = busy(refreshBtn, 'Refreshing…');
      try { await refresh(); toast('Refreshed', 'success'); }
      catch (e) { toast(e.message, 'error'); }
      finally { restore(); }
    });
  }
}

async function bootstrap() {
  initSorting();
  initToolbar();
  try {
    await store.load();
    renderAll();
  } catch (err) {
    console.error('Dashboard load failed:', err);
    loadError(err.message || 'Unable to load API data');
  }
}

bootstrap();
