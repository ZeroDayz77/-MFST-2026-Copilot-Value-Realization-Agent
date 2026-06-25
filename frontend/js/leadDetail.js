// Lead detail drawer. A THIN renderer of backend data: model scores from
// lead.scoring and the sales playbook from lead.enrichment (LLM). It never
// fabricates insights — if enrichment is missing it offers a button that asks
// the backend (LLM) to generate it via /analyze.

import { api } from './api.js';
import { store } from './store.js';
import { toast, busy } from './toast.js';
import {
  fmtUsd, fmtInt, fmtPct, n, esc, escMultiline, healthColor, adoptionPct, orDash,
} from './format.js';

let overlay;
let onChangeCb = () => {};

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'company-menu-overlay hidden';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="company-menu" role="dialog" aria-modal="true">
      <div class="company-menu-header">
        <div>
          <div id="drawerTitle" class="menu-title">Lead</div>
          <div id="drawerSub" class="card-sub" style="margin:4px 0 0 0;"></div>
        </div>
        <button id="drawerClose" class="menu-close" type="button">Close</button>
      </div>
      <div id="drawerBody"></div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#drawerClose').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
  });
  return overlay;
}

function close() {
  if (!overlay) return;
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

function listBlock(title, items, cls = '') {
  if (!Array.isArray(items) || !items.length) return '';
  const lis = items.map((x) => `<li>${esc(x)}</li>`).join('');
  return `<div class="enrich-block"><h4>${esc(title)}</h4><ul class="enrich-list ${cls}">${lis}</ul></div>`;
}

function scoresHtml(lead) {
  const s = lead.scoring || {};
  const m = lead.metrics || {};
  const rows = [
    ['Lead score', Number.isFinite(Number(s.lead_score)) ? Math.round(s.lead_score) : '—'],
    ['Priority', orDash(s.priority)],
    ['Rank', orDash(s.rank)],
    ['ROI (finance)', Number.isFinite(Number(s.finance_roi_percent_month)) ? fmtPct(s.finance_roi_percent_month, 1) : '—'],
    ['Net value / mo', Number.isFinite(Number(s.net_value_month_usd)) ? fmtUsd(s.net_value_month_usd) : '—'],
    ['Waste / mo', Number.isFinite(Number(s.waste_license_cost_month_usd)) ? fmtUsd(s.waste_license_cost_month_usd) : '—'],
    ['Expansion', s.expansion_recommend == null ? '—' : `${s.expansion_recommend ? 'Recommended' : 'Hold'} (${fmtPct(s.expansion_confidence_pct, 1)})`],
    ['Adoption', fmtPct(adoptionPct(m), 1)],
  ];
  return `
    <div class="menu-card opportunity">
      <h4>Model Scores</h4>
      ${rows.map(([k, v]) => `<div class="menu-row"><span class="menu-key">${esc(k)}</span><span class="menu-value">${esc(v)}</span></div>`).join('')}
    </div>`;
}

// Outreach email — rendered whenever an email exists, INDEPENDENT of the rest of
// the enrichment (fixes the "draft email shows nothing" bug). Marked draft/not-sent.
function outreachHtml(lead) {
  const o = lead.enrichment?.outreach;
  if (!o || (!o.subject && !o.body)) return '';
  return `
    <div class="menu-card" id="outreachCard" style="margin-top:12px;">
      <h4>Outreach email <span class="draft-badge">Draft — not sent</span></h4>
      <div class="outreach-box">
        <div class="outreach-subject">${esc(o.subject || '(no subject)')}</div>
        <div class="outreach-body">${escMultiline(o.body || '')}</div>
      </div>
      <div class="outreach-foot">
        <button class="btn btn-sm btn-ghost" data-act="copy-outreach">Copy</button>
        <button class="btn btn-sm" data-act="outreach">Redraft</button>
        ${o.model ? `<span class="ai-source">Drafted by ${esc(o.model)}</span>` : ''}
      </div>
    </div>`;
}

// Data provenance — honest, unverified, with real verification systems.
function sourcesHtmlBlock(lead) {
  const e = lead.enrichment;
  if (!e) return '';
  const sources = Array.isArray(e.sources) ? e.sources : [];
  if (!e.data_confidence && !sources.length) return '';
  const rows = sources.map((src) => `
    <div class="source-row">
      <div class="source-claim">${esc(src.claim || '')}</div>
      <div class="source-meta"><span class="source-basis">${esc(src.basis || '')}</span>
        <span class="source-verify">Verify: ${esc(src.verification || '')}</span></div>
    </div>`).join('');
  return `
    <div class="menu-card sources-card" style="margin-top:12px;">
      <h4>Data sources &amp; verification</h4>
      <div class="confidence-chip">⚠ ${esc(e.data_confidence || 'Unverified')}</div>
      ${rows || '<div class="source-row"><div class="source-meta">No source breakdown provided.</div></div>'}
      <div class="source-note">Figures come from provided inputs and are not yet verified against Microsoft systems.</div>
    </div>`;
}

const ACTIVITY_ICON = {
  created: '✚',
  scored: '▦',
  analyzed: '✨',
  outreach_drafted: '✉',
  stage_changed: '➜',
  autopilot_run: '🤖',
  automation_changed: '⚙',
  note: '🗒',
};

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function timelineHtml(lead) {
  const acts = Array.isArray(lead.activities) ? [...lead.activities].reverse() : [];
  if (!acts.length) return '<div class="source-note">No activity yet.</div>';
  return `<div class="timeline">${acts.slice(0, 20).map((a) => `
    <div class="tl-item">
      <span class="tl-icon" title="${esc(a.type)}">${ACTIVITY_ICON[a.type] || '•'}</span>
      <div class="tl-body">
        <div class="tl-summary">${esc(a.summary)}</div>
        <div class="tl-meta">${esc(a.actor)} · ${esc(timeAgo(a.at))}</div>
      </div>
    </div>`).join('')}</div>`;
}

function enrichmentHtml(lead) {
  const e = lead.enrichment;
  if (!e || (!e.sales_pitch && !e.summary)) {
    return `
      <div class="empty-enrich">
        <div>No AI insights yet for this lead.</div>
        <button class="btn btn-accent btn-sm" data-act="analyze" style="margin-top:10px;">✨ Generate AI insights</button>
      </div>`;
  }
  return `
    ${e.health ? `<div class="enrich-block"><span class="health-chip" style="color:${healthColor(e.health)}">● ${esc(e.health)} health</span></div>` : ''}
    ${e.summary ? `<div class="enrich-block"><h4>Summary</h4><p>${esc(e.summary)}</p></div>` : ''}
    ${e.sales_pitch ? `<div class="enrich-block"><h4>Sales pitch</h4><p>${escMultiline(e.sales_pitch)}</p></div>` : ''}
    ${listBlock('Talking points', e.talking_points)}
    ${listBlock('Value drivers', e.value_drivers)}
    ${listBlock('Risks', e.risks, 'risk-list')}
    ${listBlock('Recommended actions', e.recommended_actions)}
    ${e.model ? `<div class="ai-source">Generated by: ${esc(e.model)}</div>` : ''}`;
}

function stageSelect(lead, stages) {
  const opts = (stages || []).map(
    (s) => `<option value="${esc(s)}" ${s === lead.stage ? 'selected' : ''}>${esc(s)}</option>`,
  ).join('');
  return `<select id="drawerStage" class="btn btn-sm" style="padding-right:8px;">${opts}</select>`;
}

function render(lead) {
  const body = overlay.querySelector('#drawerBody');
  const s = lead.scoring || {};
  const contact = lead.contact || {};
  const hasEnrich = lead.enrichment && (lead.enrichment.sales_pitch || lead.enrichment.summary);
  const stages = store.meta?.pipeline_stages || ['New', 'Qualified', 'Contacted', 'Engaged', 'Proposal', 'Won', 'Lost'];
  const autopilotOn = Boolean(lead.automation?.autopilot);
  const nextAction = lead.lifecycle?.next_action;

  overlay.querySelector('#drawerTitle').textContent = lead.company_name || 'Lead';
  overlay.querySelector('#drawerSub').textContent =
    `${orDash(lead.industry)} · ${esc(lead.stage || 'New')} · Priority ${orDash(s.priority)} · Score ${Number.isFinite(Number(s.lead_score)) ? Math.round(s.lead_score) : '—'}`;

  body.innerHTML = `
    <div class="drawer-actions">
      <button class="btn btn-accent btn-sm" data-act="autopilot">🤖 Run AI next action</button>
      <button class="btn btn-sm" data-act="analyze">${hasEnrich ? '🔄 Re-analyze' : '✨ Generate insights'}</button>
      <button class="btn btn-sm" data-act="outreach">✉ Draft email</button>
      ${stageSelect(lead, stages)}
      <label class="autopilot-toggle" title="Let the AI run next-actions for this lead">
        <input type="checkbox" id="apToggle" ${autopilotOn ? 'checked' : ''}/> Autopilot
      </label>
      <button class="btn btn-danger btn-sm" data-act="delete">Delete</button>
    </div>

    ${nextAction ? `<div class="next-action"><span class="na-label">Next action</span>
      <span class="na-text">${esc(nextAction)}</span>
      ${lead.lifecycle?.next_action_reason ? `<span class="na-reason">${esc(lead.lifecycle.next_action_reason)}</span>` : ''}</div>` : ''}

    <div class="menu-grid">
      <div class="menu-card contact">
        <h4>Contact</h4>
        <div class="menu-row"><span class="menu-key">Name</span><span class="menu-value">${esc(orDash(contact.name))}</span></div>
        <div class="menu-row"><span class="menu-key">Title</span><span class="menu-value">${esc(orDash(contact.title))}</span></div>
        <div class="menu-row"><span class="menu-key">Email</span><span class="menu-value">${esc(orDash(contact.email))}</span></div>
        <div class="menu-row"><span class="menu-key">Stage</span><span class="menu-value">${esc(lead.stage || 'New')}</span></div>
        <div class="menu-row"><span class="menu-key">Source</span><span class="menu-value">${esc(lead.source || '—')}</span></div>
      </div>
      ${scoresHtml(lead)}
    </div>

    <div class="menu-card pitch" style="margin-top:12px;">
      <h4>AI Sales Playbook</h4>
      <div id="drawerEnrich">${enrichmentHtml(lead)}</div>
    </div>

    ${outreachHtml(lead)}
    ${sourcesHtmlBlock(lead)}

    <div class="menu-card" style="margin-top:12px;">
      <h4>Lifecycle timeline</h4>
      ${timelineHtml(lead)}
    </div>`;

  body.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', (ev) => handleAction(btn.dataset.act, lead.id, ev.currentTarget));
  });
  const stageSel = body.querySelector('#drawerStage');
  if (stageSel) stageSel.addEventListener('change', () => handleStage(lead.id, stageSel.value));
  const apToggle = body.querySelector('#apToggle');
  if (apToggle) apToggle.addEventListener('change', () => handleAutomation(lead.id, apToggle.checked));
}

async function handleAction(act, id, btn) {
  if (act === 'analyze') {
    const restore = busy(btn, 'Asking AI…');
    try {
      const { lead } = await api.analyze(id);
      store.upsert(lead);
      render(store.getLead(id));
      onChangeCb();
      toast('AI insights generated', 'success');
    } catch (e) {
      toast(`Analyze failed: ${e.message}`, 'error');
      restore();
    }
  } else if (act === 'outreach') {
    const restore = busy(btn, 'Drafting…');
    try {
      await api.outreach(id, { goal: 'book a 20-minute value review' });
      const { lead } = await api.getLead(id);
      store.upsert(lead);
      render(store.getLead(id));
      onChangeCb();
      toast('Outreach email drafted (draft — not sent)', 'success');
      scrollToOutreach();
    } catch (e) {
      toast(`Outreach failed: ${e.message}`, 'error');
      restore();
    }
  } else if (act === 'autopilot') {
    const restore = busy(btn, 'AI working…');
    try {
      const { lead } = await api.autopilot(id);
      store.upsert(lead);
      render(store.getLead(id));
      onChangeCb();
      const last = [...(lead.activities || [])].reverse().find((a) => a.type === 'autopilot_run');
      toast(last ? last.summary : 'Autopilot ran', 'success');
    } catch (e) {
      toast(`Autopilot failed: ${e.message}`, 'error');
      restore();
    }
  } else if (act === 'copy-outreach') {
    const o = store.getLead(id)?.enrichment?.outreach;
    if (o) {
      const text = `Subject: ${o.subject || ''}\n\n${o.body || ''}`;
      navigator.clipboard?.writeText(text).then(
        () => toast('Email copied to clipboard', 'success'),
        () => toast('Copy failed', 'error'),
      );
    }
  } else if (act === 'delete') {
    if (!confirm(`Delete ${store.getLead(id)?.company_name || 'this lead'}?`)) return;
    try {
      await api.deleteLead(id);
      store.remove(id);
      close();
      onChangeCb();
      toast('Lead deleted', 'success');
    } catch (e) {
      toast(`Delete failed: ${e.message}`, 'error');
    }
  }
}

function scrollToOutreach() {
  const card = overlay?.querySelector('#outreachCard');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function handleStage(id, stage) {
  try {
    const { lead } = await api.patchLead(id, { stage });
    store.upsert(lead);
    render(store.getLead(id));
    onChangeCb();
    toast(`Stage → ${stage}`, 'success');
  } catch (e) {
    toast(`Stage update failed: ${e.message}`, 'error');
  }
}

async function handleAutomation(id, autopilot) {
  try {
    const { lead } = await api.setAutomation(id, autopilot);
    store.upsert(lead);
    onChangeCb();
    toast(`Autopilot ${autopilot ? 'enabled' : 'disabled'}`, 'success');
  } catch (e) {
    toast(`Automation update failed: ${e.message}`, 'error');
  }
}

export function openLeadDrawer(id, { onChange } = {}) {
  const lead = store.getLead(id);
  if (!lead) return;
  onChangeCb = onChange || (() => {});
  ensureOverlay();
  render(lead);
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
}

export default { openLeadDrawer };
