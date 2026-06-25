// Same-origin API client. The dashboard is served by the backend, so the API
// base is just "/api" (override with window.DASHBOARD_API_BASE for split hosting).

const API_BASE = (window.DASHBOARD_API_BASE || '/api').replace(/\/+$/, '');

async function request(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const msg = data?.error || `${res.status} ${res.statusText}`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = data?.details || data?.missing || data?.rejected;
    throw err;
  }
  return data;
}

export const api = {
  base: API_BASE,
  getMeta: () => request('GET', '/meta'),
  getHealth: () => request('GET', '/health'),

  getLeads: ({ sort = 'rank', order = 'asc', stage } = {}) => {
    const q = new URLSearchParams({ sort, order });
    if (stage) q.set('stage', stage);
    return request('GET', `/leads?${q.toString()}`);
  },
  getLead: (id) => request('GET', `/leads/${id}`),

  createLead: (lead, { enrich = false } = {}) =>
    request('POST', `/leads?enrich=${enrich}`, lead),

  intake: ({ prompt, file, rows, count } = {}, { enrich = false } = {}) =>
    request('POST', `/leads/intake?enrich=${enrich}`, { prompt, file, rows, count }),

  generate: ({ prompt, count, hints } = {}, { enrich = false } = {}) =>
    request('POST', `/leads/generate?enrich=${enrich}`, { prompt, count, hints }),

  analyze: (id) => request('POST', `/leads/${id}/analyze`),
  outreach: (id, opts = {}) => request('POST', `/leads/${id}/outreach`, opts),
  autopilot: (id) => request('POST', `/leads/${id}/autopilot`),
  setAutomation: (id, autopilot) => request('POST', `/leads/${id}/automation`, { autopilot }),
  runAutopilotAll: () => request('POST', '/leads/autopilot/run'),

  patchLead: (id, patch, { enrich = false } = {}) =>
    request('PATCH', `/leads/${id}?enrich=${enrich}`, patch),
  deleteLead: (id) => request('DELETE', `/leads/${id}`),
  rank: () => request('POST', '/leads/rank'),
};

export default api;
