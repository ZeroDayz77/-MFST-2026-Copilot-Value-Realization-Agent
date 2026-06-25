// Health + metadata routes for the dashboard (stages, priorities, weights,
// and live LLM / scoring engine status).

import { Router } from 'express';
import config from '../config.js';
import { PIPELINE_STAGES, PRIORITIES, REQUIRED_METRICS, AUTONOMY_LEVELS } from '../domain/lead.js';
import { scoringStatus } from '../services/scoringService.js';
import { llm } from '../services/llmClient.js';
import { mail } from '../services/mailService.js';

export function makeMetaRoutes({ store }) {
  const router = Router();

  router.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime_s: Math.round(process.uptime()), leads: store.all().length });
  });

  router.get('/meta', async (req, res) => {
    res.json({
      product: config.product,
      pipeline_stages: PIPELINE_STAGES,
      priorities: PRIORITIES,
      required_metrics: REQUIRED_METRICS,
      autonomy_levels: AUTONOMY_LEVELS,
      lead_score: {
        weights: config.scoring.weights,
        size_ref_usd: config.scoring.sizeRefUsd,
        components: ['expansion_propensity', 'proven_value', 'recoverable_waste', 'deal_size'],
      },
      scoring: await scoringStatus(),
      llm: llm.status(),
      mail: mail.status(),
      lead_count: store.all().length,
    });
  });

  return router;
}

export default makeMetaRoutes;
