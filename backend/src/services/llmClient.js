// Provider-agnostic LLM client returning parsed JSON. Supports Azure OpenAI
// (default), OpenAI, and a "mock" mode. In mock mode chatJSON throws
// LlmUnavailableError so callers fall back to their deterministic generators —
// the same try/catch path also covers real network/parse failures.

import config from '../config.js';

export class LlmUnavailableError extends Error {}

function stripFences(text) {
  return String(text)
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

// Tolerant JSON parse: handles code fences and leading/trailing prose by
// extracting the outermost JSON object/array.
function parseJsonLoose(content) {
  const cleaned = stripFences(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('LLM did not return valid JSON');
  }
}

async function postJson(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function buildRequest({ system, user, temperature, maxTokens }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  return {
    messages,
    temperature: temperature ?? config.llm.temperature,
    max_tokens: maxTokens ?? config.llm.maxTokens,
    response_format: { type: 'json_object' },
  };
}

async function callAzure(payload) {
  const { endpoint, deployment, apiVersion, apiKey } = config.llm.azure;
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const data = await postJson(url, { 'api-key': apiKey }, payload);
  return data.choices?.[0]?.message?.content ?? '';
}

async function callOpenai(payload) {
  const { baseUrl, apiKey, model } = config.llm.openai;
  const url = `${baseUrl}/chat/completions`;
  const data = await postJson(url, { Authorization: `Bearer ${apiKey}` }, { model, ...payload });
  return data.choices?.[0]?.message?.content ?? '';
}

export const llm = {
  provider: config.llm.provider,
  available: config.llm.provider !== 'mock',

  // Returns a parsed JSON object/array, or throws (LlmUnavailableError in mock).
  async chatJSON(opts) {
    if (this.provider === 'mock') {
      throw new LlmUnavailableError('LLM in mock mode');
    }
    const payload = buildRequest(opts);
    const content = this.provider === 'azure' ? await callAzure(payload) : await callOpenai(payload);
    return parseJsonLoose(content);
  },

  status() {
    return {
      provider: this.provider,
      requested_provider: config.llm.requestedProvider,
      configured: config.llm.configured,
      model:
        config.llm.provider === 'azure'
          ? config.llm.azure.deployment || null
          : config.llm.provider === 'openai'
            ? config.llm.openai.model
            : 'mock',
    };
  },
};

export default llm;
