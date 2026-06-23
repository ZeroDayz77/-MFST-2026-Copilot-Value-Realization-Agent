// CRM lead routes: CRUD + AI generate + analyze + outreach + rank + import.

import { Router } from 'express';
import { normalizeMetrics, REQUIRED_METRICS } from '../domain/lead.js';
import { runIntake } from '../services/intakeService.js';

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function wantsEnrich(req) {
  return req.query.enrich === 'true' || req.body?.enrich === true;
}

export function makeLeadRoutes({ store, leadService }) {
  const router = Router();

  // List leads (ranked by default).
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { stage, sort, order, limit } = req.query;
      const leads = store.list({ stage, sort, order, limit });
      res.json({ count: leads.length, leads });
    }),
  );

  // Create a lead from structured metrics OR a free-text prompt.
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const source = body.metrics || body;
      const { missing } = normalizeMetrics(source);

      if (missing.length) {
        if (body.prompt) {
          const lead = await leadService.createFromPrompt(body.prompt, { enrich: wantsEnrich(req) });
          return res.status(201).json({ lead });
        }
        return res.status(422).json({
          error: 'Missing required metrics. Provide them in `metrics`, or send a `prompt` to parse.',
          missing,
          required: REQUIRED_METRICS,
        });
      }

      const lead = await leadService.createLead(body, { enrich: wantsEnrich(req) });
      return res.status(201).json({ lead });
    }),
  );

  // AI-generate N leads from a prompt.
  router.post(
    '/generate',
    asyncHandler(async (req, res) => {
      const { prompt, count, hints } = req.body || {};
      const leads = await leadService.generate({
        prompt,
        count,
        hints,
        enrich: wantsEnrich(req),
      });
      res.status(201).json({ count: leads.length, leads });
    }),
  );

  // Combined intake: a prompt and/or an uploaded leads file (CSV/JSON/text) or
  // pre-parsed rows. Parses + estimates metrics, follows the prompt, then scores
  // and ranks. `?enrich=true` also attaches the AI playbook to each lead.
  router.post(
    '/intake',
    asyncHandler(async (req, res) => {
      const { prompt, file, rows, count } = req.body || {};
      const hasFile = file && (typeof file === 'string' || file.content);
      const hasRows = Array.isArray(rows) && rows.length > 0;
      if (!prompt && !hasFile && !hasRows) {
        return res.status(400).json({
          error: 'Provide a `prompt` and/or a `file` (CSV/JSON/text) or `rows` to intake.',
        });
      }

      const { payloads, meta } = await runIntake({ prompt, file, rows, count });
      if (!payloads.length) {
        return res.status(422).json({ error: 'No leads could be built from the input.', intake: meta });
      }

      const leads = await leadService.createManyFromPayloads(payloads, { enrich: wantsEnrich(req) });
      return res.status(201).json({
        imported: leads.length,
        from_file: meta.from_file,
        generated: meta.generated,
        intake: meta,
        leads,
      });
    }),
  );

  // Bulk import structured leads.
  router.post(
    '/import',
    asyncHandler(async (req, res) => {
      const list = Array.isArray(req.body) ? req.body : req.body?.leads;
      if (!Array.isArray(list) || !list.length) {
        return res.status(400).json({ error: 'Provide a non-empty array of leads (or { leads: [...] }).' });
      }
      const valid = [];
      const rejected = [];
      list.forEach((item, i) => {
        const { missing } = normalizeMetrics(item.metrics || item);
        if (missing.length) rejected.push({ index: i, missing });
        else valid.push(item);
      });
      const leads = valid.length
        ? await leadService.createManyFromPayloads(valid, { enrich: wantsEnrich(req) })
        : [];
      return res.status(leads.length ? 201 : 422).json({ imported: leads.length, leads, rejected });
    }),
  );

  // Recompute ranks across all leads.
  router.post(
    '/rank',
    asyncHandler(async (req, res) => {
      await store.recomputeRanks();
      const leads = store.list({ sort: 'rank' });
      res.json({ count: leads.length, leads });
    }),
  );

  // Single lead.
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const lead = store.get(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      return res.json({ lead });
    }),
  );

  // Edit a lead (re-scores when metrics change).
  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const lead = await leadService.updateLead(req.params.id, req.body || {}, {
        enrich: wantsEnrich(req),
      });
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      return res.json({ lead });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const removed = await leadService.removeLead(req.params.id);
      if (!removed) return res.status(404).json({ error: 'Lead not found' });
      return res.status(204).send();
    }),
  );

  // Force re-score + LLM enrichment (pitch, actions, outreach).
  router.post(
    '/:id/analyze',
    asyncHandler(async (req, res) => {
      const lead = await leadService.analyzeLead(req.params.id);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      return res.json({ lead });
    }),
  );

  // Generate/refresh an outreach email for a lead.
  router.post(
    '/:id/outreach',
    asyncHandler(async (req, res) => {
      const { tone, channel, goal } = req.body || {};
      const outreach = await leadService.outreachForLead(req.params.id, { tone, channel, goal });
      if (!outreach) return res.status(404).json({ error: 'Lead not found' });
      return res.json({ outreach });
    }),
  );

  return router;
}

export default makeLeadRoutes;
