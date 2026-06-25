// Central configuration. Loads .env, resolves paths, and decides the effective
// LLM provider (falling back to the no-key "mock" provider when credentials are
// missing so the service always boots and is demo/test friendly).

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const DEFAULT_MODELS_DIR = path.join(REPO_ROOT, 'Models');

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolveMaybe(value, fallback) {
  return value ? path.resolve(value) : fallback;
}

// Return the first path that exists, else the last candidate. Lets a deployed
// `backend/` bundle its own model_params.json (backend/artifacts/...) while local
// dev falls back to the Models/ sibling — no env var required either way.
function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return paths[paths.length - 1];
}

const modelsDir = resolveMaybe(process.env.MODELS_DIR, DEFAULT_MODELS_DIR);

// Azure OpenAI resource base. Foundry/AI Studio often hands out an endpoint with
// a "/openai/v1" (or trailing "/openai") suffix; strip it so we can build the
// classic data-plane URL (/openai/deployments/{deployment}/chat/completions).
function normalizeAzureEndpoint(raw) {
  return (raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/openai\/v1$/i, '')
    .replace(/\/openai$/i, '')
    .replace(/\/+$/, '');
}

const azure = {
  endpoint: normalizeAzureEndpoint(process.env.AZURE_OPENAI_ENDPOINT),
  apiKey: process.env.AZURE_OPENAI_API_KEY || '',
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT || '',
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview',
};

const openai = {
  apiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
};

let requestedProvider = (process.env.LLM_PROVIDER || 'azure').toLowerCase();
if (!['azure', 'openai', 'mock'].includes(requestedProvider)) {
  requestedProvider = 'azure';
}

let configured = true;
if (requestedProvider === 'azure') {
  configured = Boolean(azure.endpoint && azure.apiKey && azure.deployment);
} else if (requestedProvider === 'openai') {
  configured = Boolean(openai.apiKey);
}
const effectiveProvider = requestedProvider === 'mock' || !configured ? 'mock' : requestedProvider;

let weights = { expansion: 0.4, value: 0.25, waste: 0.2, size: 0.15 };
if (process.env.LEAD_SCORE_WEIGHTS) {
  try {
    weights = { ...weights, ...JSON.parse(process.env.LEAD_SCORE_WEIGHTS) };
  } catch {
    // keep defaults on malformed override
  }
}

// --- Mail / outreach sending -------------------------------------------------
// HARD SAFETY GATE: real email is NEVER sent unless MAIL_SEND_ENABLED=true AND a
// real provider (smtp|graph) is fully configured. Default is a mock outbox that
// records "sends" without anything leaving the box.
function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

let mailProvider = (process.env.MAIL_PROVIDER || 'mock').toLowerCase();
if (!['mock', 'smtp', 'graph'].includes(mailProvider)) mailProvider = 'mock';

const smtp = {
  host: process.env.SMTP_HOST || '',
  port: num(process.env.SMTP_PORT, 587),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  secure: boolEnv(process.env.SMTP_SECURE, false),
};

const graphMail = {
  tenantId: process.env.GRAPH_TENANT_ID || '',
  clientId: process.env.GRAPH_CLIENT_ID || '',
  clientSecret: process.env.GRAPH_CLIENT_SECRET || '',
  sender: process.env.GRAPH_SENDER || '', // the mailbox to send as (UPN)
};

let mailProviderConfigured = true;
if (mailProvider === 'smtp') mailProviderConfigured = Boolean(smtp.host && smtp.user && smtp.pass);
else if (mailProvider === 'graph') {
  mailProviderConfigured = Boolean(graphMail.tenantId && graphMail.clientId && graphMail.clientSecret && graphMail.sender);
}

// The gate the user explicitly asked for. Off by default.
const mailSendEnabled = boolEnv(process.env.MAIL_SEND_ENABLED, false);
// "live" means a real provider is configured AND the gate is on. Otherwise mock.
const mailLive = mailProvider !== 'mock' && mailProviderConfigured && mailSendEnabled;
const effectiveMailProvider = mailLive ? mailProvider : 'mock';

// Default autonomy for new leads: manual | approval | auto.
let defaultAutonomy = (process.env.DEFAULT_AUTONOMY || 'manual').toLowerCase();
if (!['manual', 'approval', 'auto'].includes(defaultAutonomy)) defaultAutonomy = 'manual';

export const config = {
  backendRoot: BACKEND_ROOT,
  repoRoot: REPO_ROOT,
  port: num(process.env.PORT, 3000),
  product: process.env.PRODUCT_NAME || 'Microsoft 365 Copilot',
  // Static frontend dir: bundled copy (backend/frontend, used in deploys) wins,
  // else the repo-root sibling for local dev.
  frontendDir: resolveMaybe(
    process.env.FRONTEND_DIR,
    firstExisting([
      path.join(BACKEND_ROOT, 'frontend'),
      path.join(REPO_ROOT, 'frontend'),
    ]),
  ),
  dataFile: resolveMaybe(process.env.DATA_FILE, path.join(BACKEND_ROOT, 'data', 'leads.json')),
  scoring: {
    engine: (process.env.SCORING_ENGINE || 'auto').toLowerCase(), // auto | python | js
    pythonBin: process.env.PYTHON_BIN || 'python',
    modelsDir,
    modelParamsPath: process.env.MODEL_PARAMS_PATH
      ? path.resolve(process.env.MODEL_PARAMS_PATH)
      : firstExisting([
          path.join(BACKEND_ROOT, 'artifacts', 'model_params.json'),
          path.join(modelsDir, 'artifacts', 'model_params.json'),
        ]),
    scoreBatchScript: resolveMaybe(
      process.env.SCORE_BATCH_SCRIPT,
      path.join(modelsDir, 'score_batch.py'),
    ),
    timeoutMs: num(process.env.SCORING_TIMEOUT_MS, 30000),
    weights,
    sizeRefUsd: num(process.env.LEAD_SCORE_SIZE_REF_USD, 100000),
  },
  llm: {
    provider: effectiveProvider,
    requestedProvider,
    configured,
    azure,
    openai,
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 30000),
    maxTokens: num(process.env.LLM_MAX_TOKENS, 1400),
    // Reasoning models (GPT-5/o-series) spend hidden tokens before output; add
    // this headroom on top of the requested output budget so content isn't empty.
    reasoningHeadroom: num(process.env.LLM_REASONING_HEADROOM, 4000),
    temperature: num(process.env.LLM_TEMPERATURE, 0.4),
  },
  mail: {
    // effective provider after the safety gate (mock unless live).
    provider: effectiveMailProvider,
    requestedProvider: mailProvider,
    // The explicit on/off gate. When false, NOTHING is really emailed.
    sendEnabled: mailSendEnabled,
    providerConfigured: mailProviderConfigured,
    live: mailLive,
    fromAddress: process.env.MAIL_FROM || graphMail.sender || smtp.user || 'value-iq@example.com',
    defaultAutonomy,
    smtp,
    graph: graphMail,
    timeoutMs: num(process.env.MAIL_TIMEOUT_MS, 20000),
  },
};

export default config;
