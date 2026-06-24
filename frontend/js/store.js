// In-memory app state shared by the dashboard. Holds meta + the lead list and a
// few derived helpers. The store is the single source of truth the UI renders;
// it never invents data — it only mirrors what the backend returned.

import { api } from './api.js';
import { n, adoptionPct } from './format.js';

const state = {
  meta: null,
  leads: [],
  loaded: false,
};

export const store = {
  get meta() {
    return state.meta;
  },
  get leads() {
    return state.leads;
  },

  // Load (or reload) meta + ranked leads from the backend.
  async load() {
    const [meta, leadsRes] = await Promise.all([
      api.getMeta(),
      api.getLeads({ sort: 'rank', order: 'asc' }),
    ]);
    state.meta = meta;
    state.leads = Array.isArray(leadsRes.leads) ? leadsRes.leads : [];
    state.loaded = true;
    return state;
  },

  getLead(id) {
    return state.leads.find((l) => l.id === id) || null;
  },

  // Replace a single lead in place (after analyze / patch / outreach).
  upsert(lead) {
    if (!lead || !lead.id) return;
    const i = state.leads.findIndex((l) => l.id === lead.id);
    if (i >= 0) state.leads[i] = lead;
    else state.leads.push(lead);
  },

  remove(id) {
    state.leads = state.leads.filter((l) => l.id !== id);
  },

  // Portfolio aggregates computed straight from the leads' model scores.
  totals() {
    const t = {
      count: state.leads.length,
      licensed: 0,
      active: 0,
      gross: 0,
      net: 0,
      waste: 0,
      spend: 0,
      roiWeightedNum: 0,
    };
    for (const lead of state.leads) {
      const m = lead.metrics || {};
      const s = lead.scoring || {};
      t.licensed += n(m.licensed_users);
      t.active += n(m.active_users);
      t.gross += n(s.gross_value_month_usd);
      t.net += n(s.net_value_month_usd);
      t.waste += n(s.waste_license_cost_month_usd);
      t.spend += n(m.license_cost_month_usd);
    }
    t.adoptionPct = t.licensed > 0 ? (t.active / t.licensed) * 100 : 0;
    // Portfolio ROI from aggregated net/spend (not an average of ratios).
    t.roiPct = t.spend > 0 ? (t.net / t.spend) * 100 : 0;
    return t;
  },
};

export { adoptionPct };
export default store;
