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

// HTTP error that preserves status + parsed body so callers can adapt the request.
class LlmHttpError extends Error {
  constructor(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    super(`LLM HTTP ${status}: ${text.slice(0, 500)}`);
    this.status = status;
    this.body = body;
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
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      throw new LlmHttpError(res.status, parsed);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// Newer models (GPT-5 family, o-series reasoning models) require
// `max_completion_tokens` instead of `max_tokens` and only accept the default
// temperature. Seed the request style from the model/deployment name.
function isNewerModel(name) {
  return /(gpt-5|gpt5|o1|o3|o4)/i.test(name || '');
}

function buildRequest({ system, user, temperature, maxTokens }, style = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const req = { messages, response_format: { type: 'json_object' } };
  const tokens = maxTokens ?? config.llm.maxTokens;
  if (style.useCompletionTokens) {
    // Reasoning models consume part of this budget on hidden reasoning, so add
    // headroom on top of the desired output tokens to avoid empty completions.
    req.max_completion_tokens = tokens + (config.llm.reasoningHeadroom || 0);
  } else {
    req.max_tokens = tokens;
  }
  if (!style.omitTemperature) {
    req.temperature = temperature ?? config.llm.temperature;
  }
  return req;
}

// Inspect a 400 body and flip request-style flags to satisfy model constraints.
// Returns true if it adapted something (caller should retry).
function adaptStyle(body, style) {
  const err = body && body.error ? body.error : {};
  const blob = `${err.message || ''} ${err.param || ''} ${err.code || ''}`.toLowerCase();
  let adapted = false;
  if (!style.useCompletionTokens && blob.includes('max_tokens')) {
    style.useCompletionTokens = true;
    adapted = true;
  }
  if (!style.omitTemperature && blob.includes('temperature')) {
    style.omitTemperature = true;
    adapted = true;
  }
  return adapted;
}

// Shared send-with-adaptation loop used by both providers.
async function sendAdaptive(opts, modelName, doPost) {
  const style = {
    useCompletionTokens: isNewerModel(modelName),
    omitTemperature: isNewerModel(modelName),
  };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const data = await doPost(buildRequest(opts, style));
      return data.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      lastErr = e;
      if (e instanceof LlmHttpError && e.status === 400 && adaptStyle(e.body, style)) {
        continue; // retry with adjusted params
      }
      throw e;
    }
  }
  throw lastErr;
}

async function callAzure(opts) {
  const { endpoint, deployment, apiVersion, apiKey } = config.llm.azure;
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  return sendAdaptive(opts, deployment, (payload) => postJson(url, { 'api-key': apiKey }, payload));
}

async function callOpenai(opts) {
  const { baseUrl, apiKey, model } = config.llm.openai;
  const url = `${baseUrl}/chat/completions`;
  return sendAdaptive(opts, model, (payload) =>
    postJson(url, { Authorization: `Bearer ${apiKey}` }, { model, ...payload }),
  );
}

export const llm = {
  provider: config.llm.provider,
  available: config.llm.provider !== 'mock',

  // Returns a parsed JSON object/array, or throws (LlmUnavailableError in mock).
  async chatJSON(opts) {
    if (this.provider === 'mock') {
      throw new LlmUnavailableError('LLM in mock mode');
    }
    const content = this.provider === 'azure' ? await callAzure(opts) : await callOpenai(opts);
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
