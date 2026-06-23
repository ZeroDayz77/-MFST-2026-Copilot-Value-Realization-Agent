// AI lead generation. Uses the LLM to invent realistic prospect accounts from a
// prompt; falls back to a deterministic generator (seeded, internally consistent
// metrics) so "generate leads" works in mock mode and during tests.

import config from '../config.js';
import { llm } from './llmClient.js';
import { generationSystemPrompt, generationUserPrompt } from '../domain/prompts.js';

const NAME_STEMS = [
  'Northwind', 'Contoso', 'Fabrikam', 'Tailspin', 'Adventure Works', 'Proseware',
  'Wingtip', 'Litware', 'Lucerne', 'Margie\'s', 'Coho', 'Alpine Ski House',
  'Blue Yonder', 'Graphic Design Inst', 'Trey Research', 'Woodgrove', 'VanArsdel',
  'Relecloud', 'Fourth Coffee', 'Humongous Insurance',
];
const SUFFIXES = ['Labs', 'Group', 'Holdings', 'Industries', 'Partners', 'Systems', 'Global', 'Co'];
const INDUSTRIES = ['Finance', 'Healthcare', 'Manufacturing', 'Retail', 'Technology', 'Energy', 'Legal', 'Insurance', 'Logistics', 'Telecom'];
const SEGMENTS = ['Market Leader', 'Enterprise', 'Mid-Market', 'Strategic', 'Growth'];
const DEPARTMENTS = ['Sales', 'Marketing', 'Finance', 'Operations', 'HR', 'IT', 'Legal', 'Customer Success'];
const FIRST = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Sam', 'Drew'];
const LAST = ['Nguyen', 'Patel', 'Garcia', 'Smith', 'Khan', 'Müller', 'Rossi', 'Cohen', 'Silva', 'Okafor'];
const TITLES = ['CIO', 'VP of Operations', 'Head of IT', 'CFO', 'Director of Productivity', 'COO', 'VP Digital Workplace'];

function lcg(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function intBetween(rand, lo, hi) {
  return Math.round(lo + rand() * (hi - lo));
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function fallbackGenerate(count, hints = {}, seedText = '') {
  let seed = 1234 + count * 7;
  for (const ch of String(seedText)) seed = (seed + ch.charCodeAt(0)) % 2147483647;
  const rand = lcg(seed || 1);

  const leads = [];
  for (let i = 0; i < count; i += 1) {
    const stem = pick(rand, NAME_STEMS);
    const company_name = `${stem} ${pick(rand, SUFFIXES)}`;
    const licensed = intBetween(rand, 150, 6000);
    const adoption = 0.2 + rand() * 0.65; // 20%-85%
    const active = Math.max(1, Math.round(licensed * adoption));
    const hours = Number((1.5 + rand() * 8).toFixed(2));
    const hourly = Number((45 + rand() * 70).toFixed(2));
    const licenseCost = licensed * 31; // ~ $31/user/mo (matches mock data)
    const companySize = licensed * intBetween(rand, 3, 12);
    const appMix = intBetween(rand, 200, 1200);
    const first = pick(rand, FIRST);
    const last = pick(rand, LAST);

    leads.push({
      company_name,
      industry: hints.industry || pick(rand, INDUSTRIES),
      company_segment: hints.segment || pick(rand, SEGMENTS),
      department: hints.department || pick(rand, DEPARTMENTS),
      contact: {
        name: `${first} ${last}`,
        title: pick(rand, TITLES),
        email: `${first}.${last}@${slug(stem)}.com`.toLowerCase(),
      },
      metrics: {
        licensed_users: licensed,
        active_users: active,
        app_mix_score: appMix,
        avg_hours_saved_per_user_month: hours,
        loaded_hourly_cost_usd: hourly,
        license_cost_month_usd: licenseCost,
        company_size: companySize,
        enablement_cost_month_usd: Math.round(licenseCost * 0.05),
      },
      source: 'ai_generated',
    });
  }
  return leads;
}

function coerceGenerated(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((l) => l && l.metrics && typeof l.metrics === 'object')
    .map((l) => ({ ...l, source: 'ai_generated' }));
}

// Returns an array of partial-lead payloads (NOT yet scored/stored).
export async function generateLeads({ prompt, count = 5, hints } = {}) {
  const n = Math.max(1, Math.min(Number(count) || 5, 25));
  try {
    const raw = await llm.chatJSON({
      system: generationSystemPrompt(config.product),
      user: generationUserPrompt({ prompt, count: n, hints }),
      temperature: 0.8,
      maxTokens: Math.min(400 * n + 400, 4000),
    });
    const leads = coerceGenerated(raw.leads || raw);
    if (leads.length) return leads.slice(0, n);
    return fallbackGenerate(n, hints, prompt);
  } catch {
    return fallbackGenerate(n, hints, prompt);
  }
}

export default { generateLeads };
