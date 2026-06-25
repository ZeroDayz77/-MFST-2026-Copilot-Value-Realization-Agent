// Orchestration layer: ties together the domain model, scoring engine, LLM
// enrichment, and the store. Routes stay thin and call these methods.

import config from '../config.js';
import {
  newLead,
  applyLeadPatch,
  buildScoring,
  normalizeMetrics,
  addActivity,
  addOutboxEntry,
  setStage,
  PIPELINE_STAGES,
  TERMINAL_STAGES,
  AUTONOMY_LEVELS,
} from '../domain/lead.js';
import { parseLeadSystemPrompt, parseLeadUserPrompt } from '../domain/prompts.js';
import { scoreLeads } from './scoringService.js';
import { enrichLead, generateOutreach } from './enrichmentService.js';
import { generateLeads as generateLeadPayloads } from './leadGenerator.js';
import { decideNextAction } from './decisionService.js';
import { mail } from './mailService.js';
import { llm } from './llmClient.js';

const scoringOpts = {
  weights: config.scoring.weights,
  sizeRefUsd: config.scoring.sizeRefUsd,
};
const newLeadOpts = { product: config.product, defaultAutonomy: config.mail.defaultAutonomy };

// Non-terminal stages, in pipeline order, used for autopilot advancement.
const ADVANCEABLE = PIPELINE_STAGES.filter((s) => !TERMINAL_STAGES.includes(s));

export function createLeadService(store) {
  // Score a batch of leads in one engine call and attach scoring blocks.
  async function scoreAndAttach(leads, { log = false, actor = 'system' } = {}) {
    const results = await scoreLeads(leads.map((l) => l.metrics));
    leads.forEach((lead, i) => {
      const r = results[i];
      if (r && r.ok) {
        lead.scoring = buildScoring(r, lead.metrics, scoringOpts);
        if (log) {
          addActivity(lead, {
            type: 'scored',
            actor,
            summary: `Scored: ${lead.scoring.priority} priority, lead score ${lead.scoring.lead_score}`,
          });
        }
      } else {
        lead.scoring = { error: r?.error || 'scoring failed', scored_at: new Date().toISOString() };
      }
    });
    return leads;
  }

  async function maybeEnrich(leads, enrich, { actor = 'ai' } = {}) {
    if (!enrich) return leads;
    for (const lead of leads) {
      if (lead.scoring && !lead.scoring.error) {
        lead.enrichment = await enrichLead(lead);
        addActivity(lead, {
          type: 'analyzed',
          actor,
          summary: `AI insights generated (${lead.enrichment.model || 'model'})`,
        });
      }
    }
    return leads;
  }

  async function createLead(partial, { enrich = false } = {}) {
    const lead = newLead(partial, newLeadOpts);
    addActivity(lead, { type: 'created', actor: 'user', summary: `Lead created (${lead.source})` });
    await scoreAndAttach([lead], { log: true });
    await maybeEnrich([lead], enrich);
    await store.create(lead);
    await store.recomputeRanks();
    return store.get(lead.id);
  }

  async function createManyFromPayloads(payloads, { enrich = false } = {}) {
    const leads = payloads.map((p) => newLead(p, newLeadOpts));
    leads.forEach((lead) =>
      addActivity(lead, { type: 'created', actor: 'user', summary: `Lead created (${lead.source})` }),
    );
    await scoreAndAttach(leads, { log: true });
    await maybeEnrich(leads, enrich);
    await store.bulkCreate(leads);
    await store.recomputeRanks();
    return leads.map((l) => store.get(l.id));
  }

  async function generate({ prompt, count, hints, enrich = false } = {}) {
    const payloads = await generateLeadPayloads({ prompt, count, hints });
    return createManyFromPayloads(payloads, { enrich });
  }

  // Parse a free-text description into a structured lead via the LLM.
  async function createFromPrompt(text, { enrich = false } = {}) {
    if (!llm.available) {
      const err = new Error(
        'Free-text lead parsing needs an LLM. Configure a provider or POST structured `metrics` instead.',
      );
      err.status = 422;
      throw err;
    }
    let parsed;
    try {
      parsed = await llm.chatJSON({
        system: parseLeadSystemPrompt(config.product),
        user: parseLeadUserPrompt(text),
        temperature: 0.1,
      });
    } catch (e) {
      const err = new Error(`Could not parse lead from text: ${e.message}`);
      err.status = 422;
      throw err;
    }
    const { missing } = normalizeMetrics(parsed.metrics || parsed);
    if (missing.length) {
      const err = new Error(`Parsed lead is missing required metrics: ${missing.join(', ')}`);
      err.status = 422;
      err.details = { missing, parsed };
      throw err;
    }
    return createLead(parsed, { enrich });
  }

  async function updateLead(id, patch, { enrich = false, rescore = true, actor = 'user' } = {}) {
    const existing = store.get(id);
    if (!existing) return null;
    const updated = applyLeadPatch(existing, patch);
    // Stage changes are applied via setStage so they land on the timeline.
    if (patch.stage !== undefined) setStage(updated, patch.stage, actor);
    const metricsChanged = Boolean(patch.metrics || patch.company_size !== undefined);
    if (rescore && metricsChanged) {
      await scoreAndAttach([updated], { log: true, actor });
    }
    if (enrich) {
      await maybeEnrich([updated], true);
    }
    await store.upsert(updated);
    await store.recomputeRanks();
    return store.get(id);
  }

  async function analyzeLead(id, { actor = 'user' } = {}) {
    const lead = store.get(id);
    if (!lead) return null;
    await scoreAndAttach([lead], { log: true, actor });
    lead.enrichment = await enrichLead(lead);
    addActivity(lead, {
      type: 'analyzed',
      actor,
      summary: `AI insights generated (${lead.enrichment.model || 'model'})`,
    });
    await store.upsert(lead);
    await store.recomputeRanks();
    return store.get(id);
  }

  // Generate + attach a draft outreach email (no send). Returns the draft.
  async function draftOutreach(lead, opts = {}) {
    const actor = opts.actor || 'user';
    const outreach = await generateOutreach(lead, opts);
    lead.enrichment = lead.enrichment || {};
    lead.enrichment.outreach = {
      subject: outreach.subject,
      body: outreach.body,
      status: 'draft',
      generated_at: outreach.generated_at,
      model: outreach.model,
    };
    lead.last_outreach = { ...outreach, status: 'draft' };
    addActivity(lead, {
      type: 'outreach_drafted',
      actor,
      summary: `Outreach email drafted (draft — not sent): "${outreach.subject}"`,
    });
    return lead.enrichment.outreach;
  }

  async function outreachForLead(id, opts = {}) {
    const lead = store.get(id);
    if (!lead) return null;
    const draft = await draftOutreach(lead, opts);
    await store.upsert(lead);
    return { ...draft, status: 'draft' };
  }

  // EXECUTOR: actually send the lead's drafted outreach via mailService. Honors the
  // hard gate (mailService falls back to mock unless MAIL_SEND_ENABLED + configured).
  // Drafts one first if none exists. On success advances the stage to Contacted.
  async function sendOutreach(id, { actor = 'user' } = {}) {
    const lead = store.get(id);
    if (!lead) return null;

    if (!lead.enrichment?.outreach?.body) {
      await draftOutreach(lead, { actor, goal: 'book a 20-minute value review' });
    }
    const outreach = lead.enrichment.outreach;
    const to = lead.contact?.email;

    if (!to) {
      addActivity(lead, { type: 'email_failed', actor, summary: 'Send skipped: no contact email on file.' });
      outreach.status = 'failed';
      await store.upsert(lead);
      return { ok: false, reason: 'no_contact_email', outreach };
    }

    const result = await mail.send({ to, subject: outreach.subject, body: outreach.body });
    addOutboxEntry(lead, { to, subject: outreach.subject, status: result.status, provider: result.provider, mock: result.mock, error: result.error });

    if (result.status === 'sent') {
      outreach.status = 'sent';
      outreach.sent_at = new Date().toISOString();
      outreach.delivery = result.mock ? 'mock' : result.provider;
      const tag = result.mock ? ' (mock — not delivered)' : '';
      addActivity(lead, { type: 'email_sent', actor, summary: `Email sent to ${to}${tag}: "${outreach.subject}"` });
      // First real touch → move to Contacted.
      if (['New', 'Qualified'].includes(lead.stage)) setStage(lead, 'Contacted', actor);
    } else {
      outreach.status = 'failed';
      addActivity(lead, { type: 'email_failed', actor, summary: `Email send failed: ${result.error || 'unknown error'}` });
    }
    await store.upsert(lead);
    await store.recomputeRanks();
    return { ok: result.status === 'sent', result, lead: store.get(id) };
  }

  // Decide the next pipeline stage autopilot should advance to, based on what has
  // been done. Never advances into a terminal (Won/Lost) stage — a human closes.
  function suggestStageAdvance(lead) {
    const idx = ADVANCEABLE.indexOf(lead.stage);
    if (idx === -1) return null; // already terminal (Won/Lost)
    const hasEnrichment = Boolean(lead.enrichment && (lead.enrichment.sales_pitch || lead.enrichment.summary));
    const hasOutreach = Boolean(lead.enrichment?.outreach?.body);

    // New -> Qualified once analyzed; Qualified -> Contacted once outreach drafted.
    if (lead.stage === 'New' && hasEnrichment) return 'Qualified';
    if (lead.stage === 'Qualified' && hasOutreach) return 'Contacted';
    return null;
  }

  // AI-FIRST autopilot: prepare the lead, ask the AI planner for the next action,
  // then EXECUTE it according to the lead's autonomy level:
  //   manual   → AI may draft, never sends.
  //   approval → AI "send" is queued for human approval (status 'queued').
  //   auto     → AI "send" is executed via mailService (honors the hard gate).
  async function runAutopilot(id, { actor = 'ai' } = {}) {
    const lead = store.get(id);
    if (!lead) return null;
    const did = [];
    const autonomy = AUTONOMY_LEVELS.includes(lead.automation?.autonomy) ? lead.automation.autonomy : 'manual';

    // 1. Make sure the lead is scored + analyzed so the planner has signal.
    if (!lead.scoring || lead.scoring.error) {
      await scoreAndAttach([lead], { log: true, actor });
      did.push('scored the lead');
    }
    const hasEnrichment = Boolean(lead.enrichment && (lead.enrichment.sales_pitch || lead.enrichment.summary));
    if (!hasEnrichment) {
      lead.enrichment = await enrichLead(lead);
      addActivity(lead, { type: 'analyzed', actor, summary: `AI insights generated (${lead.enrichment.model || 'model'})` });
      did.push('generated AI insights');
    }

    // 2. AI planner decides the next action.
    const decision = await decideNextAction(lead);
    addActivity(lead, {
      type: 'decision',
      actor,
      summary: `AI decision: ${decision.action} — ${decision.reason} (${decision.source}, conf ${Math.round(decision.confidence * 100)}%)`,
    });

    // 3. Execute the decision under the autonomy gate.
    if (decision.action === 'send_email') {
      if (!lead.enrichment?.outreach?.body) {
        await draftOutreach(lead, { actor, goal: 'book a 20-minute value review' });
        did.push('drafted an outreach email');
      }
      if (autonomy === 'auto') {
        const sent = await sendOutreachInline(lead, actor);
        did.push(sent.ok ? `sent the email${sent.mock ? ' (mock)' : ''}` : `attempted send (${sent.reason || 'failed'})`);
      } else if (autonomy === 'approval') {
        lead.enrichment.outreach.status = 'queued';
        addActivity(lead, { type: 'email_queued', actor, summary: `Email queued for human approval: "${lead.enrichment.outreach.subject}"` });
        did.push('queued the email for approval');
      } else {
        did.push('left the email as a draft (manual mode)');
      }
    } else if (decision.action === 'draft_email') {
      if (!lead.enrichment?.outreach?.body) {
        await draftOutreach(lead, { actor, goal: 'book a 20-minute value review' });
        did.push('drafted an outreach email');
      }
    } else if (decision.action === 'advance_stage') {
      const nextStage = suggestStageAdvance(lead);
      if (nextStage) {
        setStage(lead, nextStage, actor);
        did.push(`advanced stage to ${nextStage}`);
      }
    } // wait_nurture / escalate_human → no state change beyond next_action below

    // 4. Always set the human-facing next action + stamp the run.
    lead.lifecycle = lead.lifecycle || {};
    const { next_action, reason } = computeNextAction(lead, decision);
    lead.lifecycle.next_action = next_action;
    lead.lifecycle.next_action_reason = reason;
    lead.automation = lead.automation || {};
    lead.automation.last_run_at = new Date().toISOString();

    const summary = did.length
      ? `Autopilot (${autonomy}): ${did.join(', ')}. Next: ${next_action}`
      : `Autopilot (${autonomy}): ${decision.action}. Next: ${next_action}`;
    addActivity(lead, { type: 'autopilot_run', actor, summary });

    await store.upsert(lead);
    await store.recomputeRanks();
    return store.get(id);
  }

  // Send helper used inside runAutopilot (operates on the in-memory lead; the caller
  // persists). Mirrors sendOutreach's logging without a second store round-trip.
  async function sendOutreachInline(lead, actor) {
    const outreach = lead.enrichment.outreach;
    const to = lead.contact?.email;
    if (!to) {
      outreach.status = 'failed';
      addActivity(lead, { type: 'email_failed', actor, summary: 'Send skipped: no contact email on file.' });
      return { ok: false, reason: 'no_contact_email' };
    }
    const result = await mail.send({ to, subject: outreach.subject, body: outreach.body });
    addOutboxEntry(lead, { to, subject: outreach.subject, status: result.status, provider: result.provider, mock: result.mock, error: result.error });
    if (result.status === 'sent') {
      outreach.status = 'sent';
      outreach.sent_at = new Date().toISOString();
      outreach.delivery = result.mock ? 'mock' : result.provider;
      addActivity(lead, { type: 'email_sent', actor, summary: `Email sent to ${to}${result.mock ? ' (mock — not delivered)' : ''}: "${outreach.subject}"` });
      if (['New', 'Qualified'].includes(lead.stage)) setStage(lead, 'Contacted', actor);
      return { ok: true, mock: result.mock };
    }
    outreach.status = 'failed';
    addActivity(lead, { type: 'email_failed', actor, summary: `Email send failed: ${result.error || 'unknown error'}` });
    return { ok: false, reason: result.error };
  }

  // Human-facing recommended next action (does not change the lead).
  function computeNextAction(lead, decision) {
    const stage = lead.stage;
    const status = lead.enrichment?.outreach?.status;
    if (stage === 'Won') return { next_action: 'Closed won — no action', reason: 'Deal won.' };
    if (stage === 'Lost') return { next_action: 'Closed lost — archive', reason: 'Deal lost.' };
    if (status === 'queued') {
      return { next_action: 'Approve and send the queued email', reason: 'AI queued an email pending your approval.' };
    }
    if (decision?.action === 'escalate_human') {
      return { next_action: 'Review this lead — AI flagged it for a human', reason: decision.reason };
    }
    if (status === 'sent') {
      return { next_action: 'Await a reply, then follow up', reason: 'Outreach has been sent.' };
    }
    if (lead.enrichment?.outreach?.body) {
      return { next_action: 'Send the drafted email', reason: 'A tailored draft is ready to go out.' };
    }
    if (stage === 'Engaged') {
      return { next_action: 'Prepare a tailored proposal', reason: 'Account is engaged; move toward Proposal.' };
    }
    if (stage === 'Proposal') {
      return { next_action: 'Follow up on the proposal and negotiate', reason: 'Proposal stage — drive to close.' };
    }
    return {
      next_action: 'Review the AI playbook and send outreach',
      reason: 'Early stage — qualify and make first contact.',
    };
  }

  async function setAutomation(id, { autopilot, autonomy } = {}, { actor = 'user' } = {}) {
    const lead = store.get(id);
    if (!lead) return null;
    lead.automation = lead.automation || {};
    const changes = [];
    if (autopilot !== undefined) {
      const next = Boolean(autopilot);
      if (lead.automation.autopilot !== next) {
        lead.automation.autopilot = next;
        changes.push(`autopilot ${next ? 'enabled' : 'disabled'}`);
      }
    }
    if (autonomy !== undefined && AUTONOMY_LEVELS.includes(autonomy)) {
      if (lead.automation.autonomy !== autonomy) {
        lead.automation.autonomy = autonomy;
        changes.push(`autonomy → ${autonomy}`);
      }
    }
    if (changes.length) {
      addActivity(lead, { type: 'automation_changed', actor, summary: changes.join(', ') });
      await store.upsert(lead);
    }
    return store.get(id);
  }

  // Run autopilot for every autopilot-enabled lead. Returns the affected leads.
  async function runAutopilotAll() {
    const targets = store.all().filter((l) => l.automation?.autopilot);
    const results = [];
    for (const lead of targets) {
      results.push(await runAutopilot(lead.id, { actor: 'ai' }));
    }
    return results;
  }

  async function removeLead(id) {
    const removed = await store.remove(id);
    if (removed) await store.recomputeRanks();
    return removed;
  }

  return {
    scoreAndAttach,
    createLead,
    createManyFromPayloads,
    generate,
    createFromPrompt,
    updateLead,
    analyzeLead,
    outreachForLead,
    sendOutreach,
    runAutopilot,
    runAutopilotAll,
    setAutomation,
    removeLead,
  };
}

export default createLeadService;
