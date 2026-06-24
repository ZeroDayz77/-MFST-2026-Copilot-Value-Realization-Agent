// Express app bootstrap. buildApp() is exported for tests; the server only
// starts listening when this file is run directly.

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import { LeadStore } from './services/leadStore.js';
import { createLeadService } from './services/leadService.js';
import { makeLeadRoutes } from './routes/leads.routes.js';
import { makeMetaRoutes } from './routes/meta.routes.js';

const API_INFO = {
  name: 'Copilot CRM backend',
  endpoints: [
    'GET    /api/health',
    'GET    /api/meta',
    'GET    /api/leads',
    'POST   /api/leads',
    'POST   /api/leads/generate',
    'POST   /api/leads/intake',
    'POST   /api/leads/import',
    'POST   /api/leads/rank',
    'GET    /api/leads/:id',
    'PATCH  /api/leads/:id',
    'DELETE /api/leads/:id',
    'POST   /api/leads/:id/analyze',
    'POST   /api/leads/:id/outreach',
  ],
};

export async function buildApp({ store } = {}) {
  const leadStore = store || new LeadStore(config.dataFile);
  await leadStore.init();
  const leadService = createLeadService(leadStore);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '4mb' }));

  // API info (the JSON that used to live at "/").
  app.get('/api', (req, res) => {
    res.json({ ...API_INFO, product: config.product, docs: '/api/meta' });
  });

  app.use('/api', makeMetaRoutes({ store: leadStore }));
  app.use('/api/leads', makeLeadRoutes({ store: leadStore, leadService }));

  // Static frontend (served same-origin so the dashboard can call /api/* directly).
  const frontendDir = config.frontendDir;
  const hasFrontend = frontendDir && fs.existsSync(path.join(frontendDir, 'index.html'));
  if (hasFrontend) {
    app.use(express.static(frontendDir));
  }

  // 404 for unknown API routes; otherwise fall back to the dashboard (SPA-ish).
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (hasFrontend) {
      return res.sendFile(path.join(frontendDir, 'index.html'));
    }
    return res.status(404).json({ error: 'Not found', hint: 'Frontend not bundled; API is at /api.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', err);
    res.status(status).json({ error: err.message || 'Internal error', details: err.details });
  });

  app.locals.store = leadStore;
  app.locals.leadService = leadService;
  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  buildApp()
    .then((app) => {
      app.listen(config.port, () => {
        console.log(`Copilot CRM backend on http://localhost:${config.port}`);
        console.log(`  product       : ${config.product}`);
        console.log(`  scoring engine: ${config.scoring.engine}`);
        console.log(`  llm provider  : ${config.llm.provider}${config.llm.configured ? '' : ' (mock fallback — no credentials)'}`);
      });
    })
    .catch((err) => {
      console.error('Failed to start backend:', err);
      process.exit(1);
    });
}

export default buildApp;
