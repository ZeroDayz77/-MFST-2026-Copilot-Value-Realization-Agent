// JSON-file lead persistence with an in-memory cache and serialized atomic
// writes. Deliberately behind a small interface so it can be swapped for a real
// database later without touching routes/services.

import fsp from 'node:fs/promises';
import path from 'node:path';

const SORTABLE = {
  rank: (l) => l.scoring?.rank ?? Number.POSITIVE_INFINITY,
  lead_score: (l) => l.scoring?.lead_score ?? -1,
  created_at: (l) => l.created_at,
  updated_at: (l) => l.updated_at,
  company_name: (l) => (l.company_name || '').toLowerCase(),
};

export class LeadStore {
  constructor(file) {
    this.file = file;
    this.leads = new Map();
    this._loaded = false;
    this._writeChain = Promise.resolve();
  }

  async init() {
    if (this._loaded) return;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const lead of arr) this.leads.set(lead.id, lead);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[leadStore] could not load ${this.file}: ${err.message}`);
      }
    }
    this._loaded = true;
  }

  all() {
    return [...this.leads.values()];
  }

  get(id) {
    return this.leads.get(id) || null;
  }

  list({ stage, sort = 'rank', order, limit } = {}) {
    let rows = this.all();
    if (stage) rows = rows.filter((l) => l.stage?.toLowerCase() === String(stage).toLowerCase());

    const keyFn = SORTABLE[sort] || SORTABLE.rank;
    const dir = (order || (sort === 'lead_score' ? 'desc' : 'asc')).toLowerCase() === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const av = keyFn(a);
      const bv = keyFn(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    if (Number.isFinite(Number(limit))) rows = rows.slice(0, Number(limit));
    return rows;
  }

  async create(lead) {
    this.leads.set(lead.id, lead);
    await this.persist();
    return lead;
  }

  async bulkCreate(leads) {
    for (const lead of leads) this.leads.set(lead.id, lead);
    await this.persist();
    return leads;
  }

  async upsert(lead) {
    this.leads.set(lead.id, lead);
    await this.persist();
    return lead;
  }

  async remove(id) {
    const existed = this.leads.delete(id);
    if (existed) await this.persist();
    return existed;
  }

  // Rank all scored leads by lead_score (desc); unscored leads sink to the bottom.
  async recomputeRanks() {
    const scored = this.all()
      .filter((l) => l.scoring && Number.isFinite(l.scoring.lead_score))
      .sort((a, b) => b.scoring.lead_score - a.scoring.lead_score);
    scored.forEach((lead, i) => {
      lead.scoring.rank = i + 1;
    });
    for (const lead of this.all()) {
      if (lead.scoring && !Number.isFinite(lead.scoring.rank)) lead.scoring.rank = null;
    }
    await this.persist();
    return this.all();
  }

  persist() {
    const data = JSON.stringify(this.all(), null, 2);
    this._writeChain = this._writeChain
      .then(() => this._atomicWrite(data))
      .catch((err) => console.error(`[leadStore] persist failed: ${err.message}`));
    return this._writeChain;
  }

  async _atomicWrite(data) {
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, this.file);
  }
}

export default LeadStore;
