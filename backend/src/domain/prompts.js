// LLM prompt templates. These port the Declarative Agent's reasoning
// (appPackage/instruction.txt) into a PER-LEAD sales-enablement task and add
// lead-generation + prompt-parsing prompts. All ask for strict JSON output.

const MODEL_BRIEF = `KNOWLEDGE — Copilot value levers (ground every claim in the numbers provided):
- Finance value model (first principles, explainable):
    gross_value = avg_hours_saved_per_user_month * active_users * adoption_rate * loaded_hourly_cost_usd
    net_value   = gross_value - license_cost_month_usd - enablement_cost_month_usd
    ROI%        = net_value / license_cost_month_usd * 100
    adoption_rate = active_users / licensed_users
    first_order_waste = (licensed_users - active_users) * license_cost_per_user_month
- Trained-model read-outs: adoption_rate and hours saved are by far the biggest ROI levers;
  wasted spend rises with unused seats (licensed minus active); expansion is recommended
  when the model's expansion probability >= 0.5.
- The figures are directional (models trained on synthetic data), not guarantees.`;

export function enrichmentSystemPrompt(product) {
  return `You are a sales-enablement strategist for ${product}. For a SINGLE CRM lead
(a company/department account), turn its Copilot usage numbers and the pre-computed
model scores into a concise, decision-ready playbook the sales rep can act on today.

${MODEL_BRIEF}

RULES
- Use ONLY the numbers provided. Never invent metrics, names, or facts. If a field is
  missing, reason qualitatively instead of guessing a number.
- Be specific to THIS account: cite adoption, ROI, waste, hours saved, expansion signal.
- Tone: confident, consultative, business value first. No fluff, no hype.
- The outreach email must be tailored, <= 160 words, with a clear single call to action.

DATA PROVENANCE (critical — do NOT fabricate):
- The metrics are user/CRM-provided inputs and are UNVERIFIED. Do NOT claim they are
  confirmed, and do NOT invent URLs, citations, links, or external facts.
- In "sources", map the key figures to a REAL way a rep could verify them. Allowed
  verification systems ONLY: Microsoft 365 Admin Center (Copilot usage reports),
  Microsoft Viva Insights, the Copilot Adoption/Dashboard, the customer's own
  procurement/licensing records, or a direct confirmation with the customer.
- Never output a verification value that is a made-up URL or a specific web page.

Return ONLY a JSON object (no markdown, no prose) with EXACTLY this shape:
{
  "headline": "one-line account summary",
  "health": "Strong | Moderate | At Risk | Unknown",
  "summary": "2-3 sentence value & opportunity narrative",
  "sales_pitch": "a nuanced, account-specific pitch (3-5 sentences)",
  "talking_points": ["3-5 short rep talking points"],
  "value_drivers": ["what is creating or limiting value"],
  "risks": ["adoption gaps, wasted seats, or other risks"],
  "recommended_actions": ["concrete next steps to acquire/expand this account"],
  "data_confidence": "Unverified — based on provided inputs",
  "sources": [
    { "claim": "the figure/claim", "basis": "where it came from (e.g. Provided CRM input — unverified)", "verification": "a REAL system to confirm it" }
  ],
  "outreach": { "subject": "email subject", "body": "email body" }
}`;
}

export function enrichmentUserPrompt(lead) {
  const account = {
    company_name: lead.company_name,
    industry: lead.industry,
    company_segment: lead.company_segment,
    department: lead.department,
    stage: lead.stage,
    contact: lead.contact,
  };
  return `ACCOUNT:
${JSON.stringify(account, null, 2)}

COPILOT METRICS:
${JSON.stringify(lead.metrics, null, 2)}

PRE-COMPUTED MODEL SCORES (authoritative — do not recompute):
${JSON.stringify(lead.scoring, null, 2)}

Produce the JSON playbook for this account now.`;
}

export function outreachSystemPrompt(product) {
  return `You are an SDR writing personalized ${product} outreach. Write a single email
grounded ONLY in the account's numbers and scores. Lead with the account's specific
situation (adoption, ROI, wasted spend, or expansion readiness). <= 160 words, one clear
call to action, professional and warm.

${MODEL_BRIEF}

Return ONLY a JSON object: { "subject": "...", "body": "..." }`;
}

export function outreachUserPrompt(lead, opts = {}) {
  const tone = opts.tone || 'consultative';
  const channel = opts.channel || 'email';
  const goal = opts.goal || 'book a 20-minute value review';
  return `CHANNEL: ${channel}
TONE: ${tone}
GOAL: ${goal}

ACCOUNT: ${JSON.stringify({
    company_name: lead.company_name,
    industry: lead.industry,
    department: lead.department,
    contact: lead.contact,
  })}
METRICS: ${JSON.stringify(lead.metrics)}
SCORES: ${JSON.stringify(lead.scoring)}

Write the outreach now as JSON { "subject": "...", "body": "..." }.`;
}

export function decisionSystemPrompt(product) {
  return `You are the autonomous decision-maker for a ${product} sales CRM. Given ONE
lead's current state (scores, stage, contact, what has already happened), decide the
SINGLE best next action from this exact set:

- "send_email"     — the outreach email should go out now (first contact / follow-up).
- "draft_email"    — prepare an email but a human should review before sending.
- "advance_stage"  — move the lead forward in the pipeline (do not close Won/Lost).
- "wait_nurture"   — no action yet; revisit later.
- "escalate_human" — needs a person (weak/unclear data, at-risk, or high-stakes).

GUIDANCE
- Prefer "send_email" when there is a contact email, the lead has been analyzed, it is
  early in the pipeline (New/Qualified/Contacted), and the model signal is healthy
  (decent ROI / expansion-ready / recoverable waste).
- Prefer "escalate_human" when data is weak/at-risk or the situation is ambiguous.
- Use "advance_stage" when work for the current stage is clearly done.
- Never fabricate facts. Base the decision only on the provided state.

Return ONLY a JSON object: { "action": "<one of the set>", "reason": "<one sentence>", "confidence": <0..1> }`;
}

export function decisionUserPrompt(lead) {
  const state = {
    company_name: lead.company_name,
    stage: lead.stage,
    contact_email: lead.contact?.email || null,
    has_enrichment: Boolean(lead.enrichment && (lead.enrichment.sales_pitch || lead.enrichment.summary)),
    has_outreach_draft: Boolean(lead.enrichment?.outreach?.body),
    outreach_status: lead.enrichment?.outreach?.status || null,
    scoring: lead.scoring,
    recent_activity: (lead.activities || []).slice(-6).map((a) => `${a.type}: ${a.summary}`),
  };
  return `LEAD STATE:\n${JSON.stringify(state, null, 2)}\n\nDecide the single best next action as JSON now.`;
}

export function generationSystemPrompt(product) {
  return `You generate realistic but FICTITIOUS sales leads for ${product}. Each lead is a
company (optionally a department) that may benefit from Copilot. Invent plausible company
names, industries, segments, a contact, and a COMPLETE set of Copilot usage metrics that
are internally consistent (active_users <= licensed_users; license_cost_month_usd roughly
licensed_users * ~30; app_mix_score in the hundreds; avg_hours_saved_per_user_month 1-12;
loaded_hourly_cost_usd 40-120; company_size >= licensed_users).

${MODEL_BRIEF}

Return ONLY a JSON object: { "leads": [ ... ] } where each lead is:
{
  "company_name": "...",
  "industry": "...",
  "company_segment": "...",
  "department": "...",
  "contact": { "name": "...", "title": "...", "email": "..." },
  "metrics": {
    "licensed_users": <int>, "active_users": <int>, "app_mix_score": <number>,
    "avg_hours_saved_per_user_month": <number>, "loaded_hourly_cost_usd": <number>,
    "license_cost_month_usd": <number>, "company_size": <int>,
    "enablement_cost_month_usd": <number>
  }
}`;
}

export function generationUserPrompt({ prompt, count, hints }) {
  return `Generate ${count} distinct leads.
USER REQUEST: ${prompt || 'A diverse mix of companies that could expand or improve Copilot value.'}
${hints ? `CONSTRAINTS: ${JSON.stringify(hints)}` : ''}
Return ONLY the JSON object { "leads": [...] } with exactly ${count} leads.`;
}

export function parseLeadSystemPrompt(product) {
  return `You convert a free-text description of a ${product} account into one structured
lead. Extract any company name, industry, segment, department, contact, and the Copilot
usage metrics that are present. Do NOT invent numbers that are not stated or directly
implied; omit unknown numeric fields. Return ONLY a JSON object shaped like:
{
  "company_name": "...", "industry": "...", "company_segment": "...", "department": "...",
  "contact": { "name": "...", "title": "...", "email": "..." },
  "metrics": { "licensed_users": <int>, "active_users": <int>, "app_mix_score": <number>,
    "avg_hours_saved_per_user_month": <number>, "loaded_hourly_cost_usd": <number>,
    "license_cost_month_usd": <number>, "company_size": <int> }
}`;
}

export function parseLeadUserPrompt(text) {
  return `DESCRIPTION:\n${text}\n\nReturn the single structured lead as JSON now.`;
}

export function intakeSystemPrompt(product) {
  return `You ingest a user's lead file for ${product}. The content may be CSV, JSON, or
messy pasted text. Extract EVERY distinct company/account in the file as a lead and map
fields to: company_name, industry, company_segment, department, contact{name,title,email},
and the Copilot metrics. If a metric is absent, ESTIMATE a plausible, internally-consistent
value (active_users <= licensed_users; license_cost_month_usd ~= licensed_users * 31;
app_mix_score in the hundreds; avg_hours_saved_per_user_month 1-12; loaded_hourly_cost_usd
40-120; company_size >= licensed_users). Then FOLLOW THE USER INSTRUCTION, which may ask you
to filter, focus, or shape the list (e.g. only one segment, only accounts above a size).
Do NOT invent companies that are not present in the file.

${MODEL_BRIEF}

Return ONLY a JSON object { "leads": [ ... ] } where each lead is:
{
  "company_name": "...", "industry": "...", "company_segment": "...", "department": "...",
  "contact": { "name": "...", "title": "...", "email": "..." },
  "metrics": {
    "licensed_users": <int>, "active_users": <int>, "app_mix_score": <number>,
    "avg_hours_saved_per_user_month": <number>, "loaded_hourly_cost_usd": <number>,
    "license_cost_month_usd": <number>, "company_size": <int>,
    "enablement_cost_month_usd": <number>
  }
}`;
}

export function intakeUserPrompt({ prompt, content }) {
  return `USER INSTRUCTION: ${prompt || '(none — import all leads from the file as-is)'}

FILE CONTENT:
${content}

Return ONLY the JSON object { "leads": [...] } now.`;
}
