// AI planner: decides the single best next action for a lead. The LLM proposes a
// structured decision from a fixed allowed set; this module validates it and falls
// back to deterministic rules when the LLM is unavailable or returns something off.
// Pure decision-making — NO side effects (the executor in leadService acts on it).

import config from '../config.js';
import { llm } from './llmClient.js';
import { AI_ACTIONS } from '../domain/lead.js';
import { decisionSystemPrompt, decisionUserPrompt } from '../domain/prompts.js';

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

// Deterministic policy mirroring the prompt guidance — also the fallback.
function ruleDecision(lead) {
  const s = lead.scoring || {};
  const stage = lead.stage;
  const hasEmail = Boolean(lead.contact?.email);
  const hasEnrichment = Boolean(lead.enrichment && (lead.enrichment.sales_pitch || lead.enrichment.summary));
  const hasDraft = Boolean(lead.enrichment?.outreach?.body);
  const roi = Number(s.finance_roi_percent_month);
  const earlyStage = ['New', 'Qualified', 'Contacted'].includes(stage);
  const healthy = (Number.isFinite(roi) && roi >= 0) || s.expansion_recommend || (Number(s.waste_license_cost_month_usd) > 0);

  if (['Won', 'Lost'].includes(stage)) {
    return { action: 'wait_nurture', reason: `Lead is ${stage}; no automated action.`, confidence: 0.9, source: 'rules' };
  }
  if (!hasEnrichment) {
    return { action: 'draft_email', reason: 'Needs AI analysis before outreach.', confidence: 0.6, source: 'rules' };
  }
  if (Number.isFinite(roi) && roi < 0) {
    return { action: 'escalate_human', reason: 'Negative ROI — a human should weigh in before outreach.', confidence: 0.7, source: 'rules' };
  }
  if (hasEmail && earlyStage && healthy) {
    return {
      action: 'send_email',
      reason: hasDraft ? 'Healthy signal and a draft is ready to go out.' : 'Healthy signal; draft and send first contact.',
      confidence: 0.75,
      source: 'rules',
    };
  }
  if (!hasEmail) {
    return { action: 'escalate_human', reason: 'No contact email on file; a rep must source one.', confidence: 0.65, source: 'rules' };
  }
  return { action: 'wait_nurture', reason: 'No clear next step; revisit after more signal.', confidence: 0.5, source: 'rules' };
}

// Returns { action, reason, confidence, source: 'ai'|'rules' }.
export async function decideNextAction(lead) {
  if (!llm.available) return ruleDecision(lead);
  try {
    const raw = await llm.chatJSON({
      system: decisionSystemPrompt(config.product),
      user: decisionUserPrompt(lead),
      temperature: 0.2,
      maxTokens: 300,
    });
    const action = String(raw.action || '').trim();
    if (!AI_ACTIONS.includes(action)) return ruleDecision(lead);
    return {
      action,
      reason: String(raw.reason || '').trim() || 'AI decision.',
      confidence: clamp01(raw.confidence),
      source: 'ai',
    };
  } catch {
    return ruleDecision(lead);
  }
}

export default { decideNextAction };
