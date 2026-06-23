// Per-lead AI enrichment: turns the computed scores into a rep-ready playbook
// (pitch, talking points, risks, actions, outreach). Uses the LLM when
// available and a deterministic, numbers-grounded fallback otherwise so the API
// always returns useful content (mock mode, no keys, or LLM failure).

import config from '../config.js';
import { llm } from './llmClient.js';
import {
  enrichmentSystemPrompt,
  enrichmentUserPrompt,
  outreachSystemPrompt,
  outreachUserPrompt,
} from '../domain/prompts.js';

function money(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return 'n/a';
  const n = Number(v);
  return `${n < 0 ? '-$' : '$'}${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}

function pct(v, d = 0) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return 'n/a';
  return `${Number(v).toFixed(d)}%`;
}

function asArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (v === null || v === undefined || v === '') return [];
  return [String(v)];
}

// Coerce whatever the LLM returned into our strict enrichment shape.
function normalizeEnrichment(raw, model) {
  const outreach = raw.outreach || {};
  return {
    headline: String(raw.headline || '').trim(),
    health: String(raw.health || 'Unknown').trim(),
    summary: String(raw.summary || '').trim(),
    sales_pitch: String(raw.sales_pitch || raw.pitch || '').trim(),
    talking_points: asArray(raw.talking_points),
    value_drivers: asArray(raw.value_drivers),
    risks: asArray(raw.risks),
    recommended_actions: asArray(raw.recommended_actions || raw.actions),
    outreach: {
      subject: String(outreach.subject || '').trim(),
      body: String(outreach.body || '').trim(),
    },
    model,
    generated_at: new Date().toISOString(),
  };
}

function fallbackEnrichment(lead) {
  const s = lead.scoring || {};
  const m = lead.metrics || {};
  const adoption = (Number(m.adoption_rate) || 0) * 100;
  const financeRoi = Number(s.finance_roi_percent_month);
  const waste = Number(s.waste_license_cost_month_usd) || 0;
  const net = Number(s.net_value_month_usd) || 0;
  const hours = Number(m.avg_hours_saved_per_user_month) || 0;
  const inactive = Math.max((Number(m.licensed_users) || 0) - (Number(m.active_users) || 0), 0);

  let health = 'Unknown';
  if (Number.isFinite(financeRoi)) {
    health = financeRoi >= 100 ? 'Strong' : financeRoi >= 0 ? 'Moderate' : 'At Risk';
  }

  const value_drivers = [
    `Adoption ${pct(adoption, 1)} and ${hours.toFixed(1)} hrs/user/mo are the primary ROI levers.`,
    `Net value ${money(net)}/mo at current adoption (ROI ${pct(financeRoi, 0)}).`,
  ];

  const risks = [];
  if (adoption < 60) risks.push(`Low adoption (${pct(adoption, 1)}) is stranding ${inactive.toLocaleString('en-US')} seats.`);
  if (waste > 500) risks.push(`${money(waste)}/mo wasted on inactive licenses.`);
  if (hours < 4) risks.push('Hours saved are below benchmark; value per active user is thin.');
  if (Number.isFinite(financeRoi) && financeRoi < 0) risks.push('Negative ROI — measured value trails spend.');
  if (!risks.length) risks.push('No major risks; account is converting Copilot into net value.');

  const recommended_actions = [];
  if (adoption < 60) recommended_actions.push('Run manager-led usage sprints and rightsize seats to active users.');
  if (hours < 4) recommended_actions.push('Deploy role-based prompt packs for the highest-volume workflows.');
  if (Number.isFinite(financeRoi) && financeRoi < 25) recommended_actions.push('Focus on three repeatable scenarios with measurable time savings.');
  if (waste > 500) recommended_actions.push('Reclaim inactive licenses and reassign to high-intent users.');
  if (s.expansion_recommend) recommended_actions.push('Expand to adjacent teams using the current playbook.');
  if (!recommended_actions.length) recommended_actions.push('Maintain momentum and document wins for an expansion business case.');

  const expansionLine = s.expansion_recommend
    ? `the model flags this account as expansion-ready (${pct(s.expansion_confidence_pct, 1)} signal)`
    : `the priority is to lift adoption before expanding (${pct(s.expansion_confidence_pct, 1)} expansion signal)`;

  const pitch =
    `${lead.company_name} runs ${Number(m.licensed_users || 0).toLocaleString('en-US')} Copilot seats at ` +
    `${pct(adoption, 1)} adoption, generating ${money(net)}/mo in net value (ROI ${pct(financeRoi, 0)}). ` +
    `There is ${money(waste)}/mo in recoverable spend on inactive seats. With adoption and hours saved as the ` +
    `biggest levers, ${expansionLine}. A focused enablement play converts that into measurable, board-ready ROI.`;

  const talking_points = [
    `ROI ${pct(financeRoi, 0)} • Net ${money(net)}/mo • Adoption ${pct(adoption, 1)}`,
    `Recoverable spend: ${money(waste)}/mo on ${inactive.toLocaleString('en-US')} inactive seats`,
    `Top levers: adoption + hours saved (currently ${hours.toFixed(1)} hrs/user/mo)`,
    s.expansion_recommend ? 'Expansion-ready per model signal' : 'Stabilize adoption before expansion',
  ];

  const outreach = fallbackOutreach(lead, {});

  return normalizeEnrichment(
    {
      headline: `${lead.company_name}: ${health} ROI health, ${pct(adoption, 0)} adoption`,
      health,
      summary:
        `${lead.company_name} is at ${pct(adoption, 1)} Copilot adoption with ${money(net)}/mo net value ` +
        `(ROI ${pct(financeRoi, 0)}) and ${money(waste)}/mo recoverable. ${s.expansion_recommend ? 'Expansion-ready.' : 'Adoption-first opportunity.'}`,
      sales_pitch: pitch,
      talking_points,
      value_drivers,
      risks,
      recommended_actions,
      outreach,
    },
    'mock-fallback',
  );
}

function fallbackOutreach(lead, opts) {
  const s = lead.scoring || {};
  const m = lead.metrics || {};
  const first = (lead.contact?.name || '').split(' ')[0] || 'there';
  const waste = Number(s.waste_license_cost_month_usd) || 0;
  const net = Number(s.net_value_month_usd) || 0;
  const adoption = (Number(m.adoption_rate) || 0) * 100;
  const goal = opts.goal || 'a 20-minute value review';

  const subject = s.expansion_recommend
    ? `${lead.company_name}: ready to scale Copilot value`
    : `${lead.company_name}: unlock ${money(waste)}/mo from Copilot`;

  const body =
    `Hi ${first},\n\n` +
    `Looking at ${lead.company_name}'s ${lead.product} usage, you're at ${pct(adoption, 0)} adoption ` +
    `generating ${money(net)}/mo in net value — with about ${money(waste)}/mo still recoverable from inactive seats. ` +
    `A short, focused play on adoption and high-value workflows would turn that into measurable, board-ready ROI.\n\n` +
    `Open to ${goal} this week?\n\nBest,\nThe Copilot Value team`;

  return { subject, body };
}

export async function enrichLead(lead) {
  try {
    const raw = await llm.chatJSON({
      system: enrichmentSystemPrompt(lead.product || config.product),
      user: enrichmentUserPrompt(lead),
    });
    return normalizeEnrichment(raw, llm.status().model || llm.provider);
  } catch {
    return fallbackEnrichment(lead);
  }
}

export async function generateOutreach(lead, opts = {}) {
  let result;
  let model = 'mock-fallback';
  try {
    const raw = await llm.chatJSON({
      system: outreachSystemPrompt(lead.product || config.product),
      user: outreachUserPrompt(lead, opts),
      temperature: 0.6,
    });
    result = { subject: String(raw.subject || '').trim(), body: String(raw.body || '').trim() };
    model = llm.status().model || llm.provider;
    if (!result.body) throw new Error('empty outreach body');
  } catch {
    result = fallbackOutreach(lead, opts);
  }
  return {
    ...result,
    tone: opts.tone || 'consultative',
    channel: opts.channel || 'email',
    model,
    generated_at: new Date().toISOString(),
  };
}

export default { enrichLead, generateOutreach };
