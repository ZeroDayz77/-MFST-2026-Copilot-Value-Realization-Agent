// Orchestration layer: ties together the domain model, scoring engine, LLM
// enrichment, and the store. Routes stay thin and call these methods.

import config from '../config.js';
import { newLead, applyLeadPatch, buildScoring, normalizeMetrics } from '../domain/lead.js';
import { parseLeadSystemPrompt, parseLeadUserPrompt } from '../domain/prompts.js';
import { scoreLeads } from './scoringService.js';
import { enrichLead, generateOutreach } from './enrichmentService.js';
import { generateLeads as generateLeadPayloads } from './leadGenerator.js';
import { llm } from './llmClient.js';

const scoringOpts = {
  weights: config.scoring.weights,
  sizeRefUsd: config.scoring.sizeRefUsd,
};

export function createLeadService(store) {
  // Score a batch of leads in one engine call and attach scoring blocks.
  async function scoreAndAttach(leads) {
    const results = await scoreLeads(leads.map((l) => l.metrics));
    leads.forEach((lead, i) => {
      const r = results[i];
      if (r && r.ok) {
        lead.scoring = buildScoring(r, lead.metrics, scoringOpts);
      } else {
        lead.scoring = { error: r?.error || 'scoring failed', scored_at: new Date().toISOString() };
      }
    });
    return leads;
  }

  async function maybeEnrich(leads, enrich) {
    if (!enrich) return leads;
    for (const lead of leads) {
      if (lead.scoring && !lead.scoring.error) {
        lead.enrichment = await enrichLead(lead);
      }
    }
    return leads;
  }

  async function createLead(partial, { enrich = false } = {}) {
    const lead = newLead(partial, { product: config.product });
    await scoreAndAttach([lead]);
    await maybeEnrich([lead], enrich);
    await store.create(lead);
    await store.recomputeRanks();
    return store.get(lead.id);
  }

  async function createManyFromPayloads(payloads, { enrich = false } = {}) {
    const leads = payloads.map((p) => newLead(p, { product: config.product }));
    await scoreAndAttach(leads);
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

  async function updateLead(id, patch, { enrich = false, rescore = true } = {}) {
    const existing = store.get(id);
    if (!existing) return null;
    const updated = applyLeadPatch(existing, patch);
    const metricsChanged = Boolean(patch.metrics || patch.company_size !== undefined);
    if (rescore && metricsChanged) {
      await scoreAndAttach([updated]);
    }
    if (enrich) {
      await maybeEnrich([updated], true);
    }
    await store.upsert(updated);
    await store.recomputeRanks();
    return store.get(id);
  }

  async function analyzeLead(id) {
    const lead = store.get(id);
    if (!lead) return null;
    await scoreAndAttach([lead]);
    lead.enrichment = await enrichLead(lead);
    await store.upsert(lead);
    await store.recomputeRanks();
    return store.get(id);
  }

  async function outreachForLead(id, opts) {
    const lead = store.get(id);
    if (!lead) return null;
    const outreach = await generateOutreach(lead, opts);
    lead.enrichment = lead.enrichment || {};
    lead.enrichment.outreach = { subject: outreach.subject, body: outreach.body };
    lead.last_outreach = outreach;
    await store.upsert(lead);
    return outreach;
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
    removeLead,
  };
}

export default createLeadService;
