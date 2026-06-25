// Orchestration layer: ties together the domain model, scoring engine, LLM
// enrichment, and the store. Routes stay thin and call these methods.

import config from '../config.js';
import {
  newLead,
  applyLeadPatch,
  buildScoring,
  normalizeMetrics,
  addActivity,
  setStage,
  PIPELINE_STAGES,
  TERMINAL_STAGES,
} from '../domain/lead.js';
import { parseLeadSystemPrompt, parseLeadUserPrompt } from '../domain/prompts.js';
import { scoreLeads } from './scoringService.js';
import { enrichLead, generateOutreach } from './enrichmentService.js';
import { generateLeads as generateLeadPayloads } from './leadGenerator.js';
import { llm } from './llmClient.js';

const scoringOpts = {
  weights: config.scoring.weights,
  sizeRefUsd: config.scoring.sizeRefUsd,
};

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
    const lead = newLead(partial, { product: config.product });
    addActivity(lead, { type: 'created', actor: 'user', summary: `Lead created (${lead.source})` });
    await scoreAndAttach([lead], { log: true });
    await maybeEnrich([lead], enrich);
    await store.create(lead);
    await store.recomputeRanks();
    return store.get(lead.id);
  }

  async function createManyFromPayloads(payloads, { enrich = false } = {}) {
    const leads = payloads.map((p) => newLead(p, { product: config.product }));
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

  async function outreachForLead(id, opts = {}) {
    const lead = store.get(id);
    if (!lead) return null;
    const actor = opts.actor || 'user';
    const outreach = await generateOutreach(lead, opts);
    // Drafts are never auto-sent — there is no mailbox integration.
    outreach.status = 'draft';
    lead.enrichment = lead.enrichment || {};
    lead.enrichment.outreach = {
      subject: outreach.subject,
      body: outreach.body,
      status: 'draft',
      generated_at: outreach.generated_at,
      model: outreach.model,
    };
    lead.last_outreach = outreach;
    addActivity(lead, {
      type: 'outreach_drafted',
      actor,
      summary: `Outreach email drafted (draft — not sent): "${outreach.subject}"`,
    });
    await store.upsert(lead);
    return outreach;
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

  // AI "next best action": ensure scored, analyze if needed, draft outreach if
  // missing, advance the stage by one step when warranted, and record what it did.
  async function runAutopilot(id, { actor = 'ai' } = {}) {
    const lead = store.get(id);
    if (!lead) return null;
    const did = [];

    if (!lead.scoring || lead.scoring.error) {
      await scoreAndAttach([lead], { log: true, actor });
      did.push('scored the lead');
    }

    const hasEnrichment = Boolean(lead.enrichment && (lead.enrichment.sales_pitch || lead.enrichment.summary));
    if (!hasEnrichment) {
      lead.enrichment = await enrichLead(lead);
      addActivity(lead, {
        type: 'analyzed',
        actor,
        summary: `AI insights generated (${lead.enrichment.model || 'model'})`,
      });
      did.push('generated AI insights');
    }

    if (!lead.enrichment?.outreach?.body) {
      const outreach = await generateOutreach(lead, { actor, goal: 'book a 20-minute value review' });
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
      did.push('drafted an outreach email');
    }

    const nextStage = suggestStageAdvance(lead);
    if (nextStage) {
      setStage(lead, nextStage, actor);
      did.push(`advanced stage to ${nextStage}`);
    }

    // Recommend the human's next move.
    lead.lifecycle = lead.lifecycle || {};
    const { next_action, reason } = computeNextAction(lead);
    lead.lifecycle.next_action = next_action;
    lead.lifecycle.next_action_reason = reason;

    lead.automation = lead.automation || {};
    lead.automation.last_run_at = new Date().toISOString();

    const summary = did.length
      ? `Autopilot: ${did.join(', ')}. Next: ${next_action}`
      : `Autopilot: already up to date. Next: ${next_action}`;
    addActivity(lead, { type: 'autopilot_run', actor, summary });

    await store.upsert(lead);
    await store.recomputeRanks();
    return store.get(id);
  }

  // Human-facing recommended next action (does not change the lead).
  function computeNextAction(lead) {
    const stage = lead.stage;
    const hasOutreach = Boolean(lead.enrichment?.outreach?.body);
    if (stage === 'Won') return { next_action: 'Closed won — no action', reason: 'Deal won.' };
    if (stage === 'Lost') return { next_action: 'Closed lost — archive', reason: 'Deal lost.' };
    if (stage === 'Contacted' && hasOutreach) {
      return {
        next_action: 'Send the drafted email and book the value review',
        reason: 'Outreach is drafted; a rep needs to send it (no mailbox integration).',
      };
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

  async function setAutomation(id, { autopilot } = {}, { actor = 'user' } = {}) {
    const lead = store.get(id);
    if (!lead) return null;
    lead.automation = lead.automation || {};
    const next = Boolean(autopilot);
    if (lead.automation.autopilot !== next) {
      lead.automation.autopilot = next;
      addActivity(lead, {
        type: 'automation_changed',
        actor,
        summary: `Autopilot ${next ? 'enabled' : 'disabled'}`,
      });
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
    runAutopilot,
    runAutopilotAll,
    setAutomation,
    removeLead,
  };
}

export default createLeadService;
