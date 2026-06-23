// Intake orchestration: the combined "prompt + optional file" flow.
// 1. Parse/normalize any uploaded leads file (LLM extraction when available,
//    deterministic CSV/JSON + metric estimation otherwise).
// 2. Follow the prompt to generate net-new leads (optionally seeded by the file
//    leads as style/context examples).
// Returns lead payloads (NOT yet scored/stored) plus intake metadata. The route
// hands the payloads to leadService.createManyFromPayloads for scoring + ranking.

import config from '../config.js';
import { llm } from './llmClient.js';
import { generateLeads } from './leadGenerator.js';
import { completeMetrics } from '../domain/lead.js';
import { parseLeadRows, rowToPayload } from './leadParser.js';
import { intakeSystemPrompt, intakeUserPrompt } from '../domain/prompts.js';

const MAX_CONTENT_CHARS = 12000;
const MAX_GENERATE = 25;

// Fill metrics on a parsed/extracted lead and strip internal fields.
function finalizePayload(p) {
  const src = p._metricsSource || p.metrics || p;
  const { metrics, estimated } = completeMetrics(src);
  const { _metricsSource, ...rest } = p;
  return { payload: { ...rest, metrics, source: p.source || 'import' }, estimated };
}

async function extractFromFile({ content, type, prompt }) {
  // Deterministic parse is the always-available base / fallback.
  let rows = [];
  try {
    rows = parseLeadRows(content, type).rows;
  } catch {
    rows = [];
  }

  if (llm.available) {
    try {
      const raw = await llm.chatJSON({
        system: intakeSystemPrompt(config.product),
        user: intakeUserPrompt({ prompt, content: String(content).slice(0, MAX_CONTENT_CHARS) }),
        temperature: 0.2,
        maxTokens: 3500,
      });
      const leads = Array.isArray(raw.leads) ? raw.leads : Array.isArray(raw) ? raw : [];
      if (leads.length) {
        return { leads: leads.map((l) => ({ ...l, source: 'import' })), llm_used: true };
      }
    } catch {
      // fall through to deterministic rows
    }
  }
  return { leads: rows.map(rowToPayload), llm_used: false };
}

// Build intake payloads. `file` may be a string or { content, type }.
export async function runIntake({ prompt, file, rows, count } = {}) {
  const meta = {
    llm_used: false,
    from_file: 0,
    generated: 0,
    estimated_metrics_for: [],
    source: 'deterministic',
  };

  let fileLeads = null;
  if (Array.isArray(rows) && rows.length) {
    fileLeads = { leads: rows.map((r) => (r.metrics ? { ...r, source: 'import' } : rowToPayload(r))), llm_used: false };
  } else if (file && (typeof file === 'string' || file.content)) {
    const content = typeof file === 'string' ? file : file.content;
    fileLeads = await extractFromFile({ content, type: file?.type, prompt });
  }

  const filePayloads = [];
  if (fileLeads) {
    meta.llm_used = meta.llm_used || fileLeads.llm_used;
    for (const lead of fileLeads.leads) {
      const { payload, estimated } = finalizePayload(lead);
      if (estimated.length) {
        meta.estimated_metrics_for.push({ company: payload.company_name, fields: estimated });
      }
      filePayloads.push(payload);
    }
  }
  meta.from_file = filePayloads.length;

  // Decide how many net-new leads to generate. Explicit `count` wins; otherwise
  // generate only when there's no file (prompt-only behaves like /generate).
  let genCount = Number(count);
  if (!Number.isFinite(genCount)) genCount = filePayloads.length ? 0 : prompt ? 5 : 0;
  genCount = Math.max(0, Math.min(genCount, MAX_GENERATE));

  let genPayloads = [];
  if (genCount > 0) {
    const examples = filePayloads.slice(0, 5).map((p) => ({
      company_name: p.company_name,
      industry: p.industry,
      metrics: p.metrics,
    }));
    genPayloads = await generateLeads({
      prompt,
      count: genCount,
      hints: examples.length ? { examples } : undefined,
    });
    if (llm.available) meta.llm_used = true;
  }
  meta.generated = genPayloads.length;
  meta.source = meta.llm_used ? 'llm' : 'deterministic';

  return { payloads: [...filePayloads, ...genPayloads], meta };
}

export default { runIntake };
