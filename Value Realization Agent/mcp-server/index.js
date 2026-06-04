const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// Load tool descriptors from appPackage/mcp-tools.json if available
let toolsDescriptor = null;
try {
  const t = fs.readFileSync(path.join(__dirname, '..', 'appPackage', 'mcp-tools.json'), 'utf8');
  toolsDescriptor = JSON.parse(t).tools || [];
} catch (e) {
  console.warn('appPackage/mcp-tools.json not found — using built-in fallback tools', e?.message || e);
  toolsDescriptor = [
    {
      name: 'analyze_copilot_value',
      description: 'Analyze Copilot usage, seats, and spend data from text or document extracts.',
      inputSchema: { type: 'object' }
    }
  ];
}

app.post('/mcp', (req, res) => {
  const body = req.body || {};
  const method = body.method || '';
  const params = body.params || {};

  if (method === 'tools/list') {
    // Return list of tools in MCP format
    res.json({
      tools: toolsDescriptor
    });
    return;
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};

    if (name === 'analyze_copilot_value') {
      // Very small heuristic parser for demo purposes
      const text = args.source_text || '';
      const company = args.company_name || 'Unknown';

      // Simple fake extraction: look for numbers for seats and spend
      const seatsMatch = text.match(/seats?[:\s]+(\d+)/i);
      const activeMatch = text.match(/active users?[:\s]+(\d+)/i);
      const spendMatch = text.match(/spend[:\s]+\$?([0-9,.]+)/i);

      const seats = seatsMatch ? parseInt(seatsMatch[1].replace(/,/g, '')) : null;
      const active_users = activeMatch ? parseInt(activeMatch[1].replace(/,/g, '')) : null;
      const spend = spendMatch ? spendMatch[1] : null;

      const score = seats && active_users ? Math.round((active_users / seats) * 100) : 50;

      const result = {
        company: company,
        score: score,
        seats_purchased: seats,
        active_users: active_users,
        spend: spend,
        insights: `Detected seats=${seats || 'n/a'}, active_users=${active_users || 'n/a'}, spend=${spend || 'n/a'}`,
        recommendations: 'Increase training for low-adoption teams; consider seat reallocation.'
      };

      res.json({ result });
      return;
    }

    res.status(400).json({ error: 'Unknown tool' });
    return;
  }

  res.status(400).json({ error: 'Unsupported method' });
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`MCP local server listening on http://localhost:${port}/mcp`));
