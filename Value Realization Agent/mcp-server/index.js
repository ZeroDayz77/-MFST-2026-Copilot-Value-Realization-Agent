const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// Python serving layer (Models/predict.py) that loads the trained models.
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const PREDICT_SCRIPT =
  process.env.PREDICT_SCRIPT ||
  path.join(__dirname, '..', '..', 'Models', 'predict.py');

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

function hasCardPayload(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.card && typeof obj.card === 'object') return true;
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && hasCardPayload(value)) {
      return true;
    }
  }
  return false;
}

function normalizeCard(args = {}) {
  const title = args.title || args.company_name || 'Copilot ROI Summary';
  const roiPercent = args.roi_percent || args.roi_percent_month || 'N/A';
  const numericRoi = Number(args.roi_percent_numeric);

  let health = args.health;
  let healthColor = args.health_color;
  if ((!health || !healthColor) && Number.isFinite(numericRoi)) {
    if (numericRoi >= 100) {
      health = health || 'Strong';
      healthColor = healthColor || 'Good';
    } else if (numericRoi >= 25) {
      health = health || 'Moderate';
      healthColor = healthColor || 'Warning';
    } else {
      health = health || 'At Risk';
      healthColor = healthColor || 'Attention';
    }
  }

  return {
    card: {
      title,
      health: health || 'Pending',
      health_color: healthColor || 'Default',
      roi_percent: String(roiPercent),
      roi_caption: args.roi_caption || 'Estimated from provided inputs',
      model_roi_percent: String(args.model_roi_percent || args.roi_model_percent || 'N/A'),
      net_value: String(args.net_value || 'N/A'),
      gross_value: String(args.gross_value || 'N/A'),
      license_cost: String(args.license_cost || 'N/A'),
      waste_cost: String(args.waste_cost || 'N/A'),
      adoption: String(args.adoption || 'N/A'),
      hours_saved: String(args.hours_saved || 'N/A'),
      expansion: String(args.expansion || 'Expansion recommendation unavailable'),
      expansion_color: String(args.expansion_color || 'Default'),
      insight: String(args.insight || 'Use this scorecard as the default summary for decision-making.'),
      note: String(args.note || 'Directional estimate. Validate assumptions before committing budget changes.')
    }
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function benchmarkDepartments(args = {}) {
  let rows = Array.isArray(args.departments) ? args.departments : [];
  if (!rows.length && typeof args.departments_json === 'string' && args.departments_json.trim()) {
    try {
      const parsed = JSON.parse(args.departments_json);
      if (Array.isArray(parsed)) {
        rows = parsed;
      }
    } catch (e) {
      return {
        error: 'departments_json must be a valid JSON array string.'
      };
    }
  }
  if (!rows.length) {
    return {
      error: 'Provide at least one department row in departments_json (or departments).'
    };
  }

  const scored = rows.map((row) => {
    const licensed = Number(row.licensed_users) || 0;
    const active = Number(row.active_users) || 0;
    const adoption = Number.isFinite(Number(row.adoption_rate))
      ? Number(row.adoption_rate)
      : (licensed > 0 ? active / licensed : 0);
    const roi = Number(row.roi_percent_month) || 0;
    const hours = Number(row.avg_hours_saved_per_user_month) || 0;
    const waste = Number(row.waste_cost_month_usd) || Math.max(licensed - active, 0) * 30;

    // Weighted opportunity score: lower ROI/adoption/hours and higher waste rank as higher priority.
    const opportunity =
      clamp((1 - clamp(adoption, 0, 1)) * 100, 0, 100) * 0.40 +
      clamp((100 - clamp(roi, -100, 200)) / 2, 0, 100) * 0.35 +
      clamp((12 - clamp(hours, 0, 12)) / 12 * 100, 0, 100) * 0.15 +
      clamp(waste / 50, 0, 100) * 0.10;

    const recParts = [];
    if (adoption < 0.6) recParts.push('run manager-led Copilot usage sprints and seat-rightsizing');
    if (hours < 4) recParts.push('deploy role-based prompt packs for highest-volume workflows');
    if (roi < 25) recParts.push('focus on top 3 repeatable scenarios with measurable time savings');
    if (waste > 500) recParts.push('reclaim inactive licenses and reassign to high-intent users');
    if (!recParts.length) recParts.push('expand to adjacent teams using current playbook');

    return {
      name: row.name || 'Unknown Department',
      licensed_users: licensed,
      active_users: active,
      adoption_rate: adoption,
      roi_percent_month: roi,
      avg_hours_saved_per_user_month: hours,
      waste_cost_month_usd: waste,
      opportunity_score: Number(opportunity.toFixed(2)),
      recommendation: recParts.join('; ')
    };
  });

  const ranked = [...scored].sort((a, b) => b.opportunity_score - a.opportunity_score);
  const topN = Math.max(1, Math.min(Number(args.low_performer_count) || 3, ranked.length));
  const lowPerformers = ranked.slice(0, topN);

  const chartConfig = {
    type: 'bar',
    data: {
      labels: ranked.map((d) => d.name),
      datasets: [
        {
          label: 'ROI %',
          data: ranked.map((d) => Number(d.roi_percent_month.toFixed(2))),
          backgroundColor: '#2F6FED'
        },
        {
          label: 'Adoption %',
          data: ranked.map((d) => Number((d.adoption_rate * 100).toFixed(2))),
          backgroundColor: '#22A06B'
        }
      ]
    },
    options: {
      plugins: { legend: { position: 'bottom' } },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Percent' }
        }
      }
    }
  };

  const chartUrl = `https://quickchart.io/chart?width=900&height=420&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
  const avgRoi = scored.reduce((sum, d) => sum + d.roi_percent_month, 0) / scored.length;
  const avgAdoption = scored.reduce((sum, d) => sum + d.adoption_rate, 0) / scored.length;

  return {
    department_comparison: {
      title: `${args.company_name || 'Company'} Department Comparison`,
      summary: `Benchmarked ${scored.length} departments. Avg ROI ${avgRoi.toFixed(1)}%, avg adoption ${toPercent(avgAdoption)}.`,
      chart_url: chartUrl,
      low_performer_headline: `Top ${topN} departments needing intervention`,
      low_performer_names: lowPerformers.map((d) => d.name).join(', '),
      low_performer_actions: lowPerformers.map((d) => `${d.name}: ${d.recommendation}`).join('\n'),
      recommendations: lowPerformers.map((d) => `- ${d.name}: ${d.recommendation}`).join('\n'),
      departments_ranked: ranked,
      low_performers: lowPerformers
    }
  };
}

function runPrediction(args, res) {
  let stdout = '';
  let stderr = '';

  let child;
  try {
    child = spawn(PYTHON_BIN, [PREDICT_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    res.status(500).json({ error: `Failed to start prediction process: ${e?.message || e}` });
    return;
  }

  const timeout = setTimeout(() => {
    child.kill();
    res.status(504).json({ error: 'Prediction timed out.' });
  }, 30000);

  child.on('error', (e) => {
    clearTimeout(timeout);
    res.status(500).json({ error: `Prediction process error: ${e?.message || e}` });
  });

  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  child.on('close', (code) => {
    clearTimeout(timeout);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      res.status(500).json({
        error: 'Could not parse prediction output.',
        details: stderr || stdout || String(e)
      });
      return;
    }

    if (code !== 0 || parsed.error) {
      res.status(400).json({ error: parsed.error || `Prediction exited with code ${code}`, details: stderr || undefined });
      return;
    }

    if (!hasCardPayload(parsed)) {
      const enriched = {
        ...parsed,
        ...normalizeCard({
          title: args.company_name ? `${args.company_name} ROI Scorecard` : 'Copilot ROI Scorecard',
          roi_percent: parsed.roi_percent || parsed.roi_percent_month,
          roi_percent_numeric: parsed.roi_percent_numeric || parsed.roi_percent || parsed.roi_percent_month,
          model_roi_percent: parsed.model_roi_percent || parsed.roi_model_percent || parsed.roi_percent,
          net_value: parsed.net_value || parsed.finance_model?.net_value,
          gross_value: parsed.gross_value || parsed.finance_model?.gross_value,
          license_cost: parsed.license_cost || parsed.license_cost_month_usd || args.license_cost_month_usd,
          waste_cost: parsed.waste_cost || parsed.wasted_license_cost || parsed.wasted_license_cost_usd,
          adoption: parsed.adoption || parsed.adoption_rate,
          hours_saved: parsed.hours_saved || parsed.avg_hours_saved_per_user_month,
          expansion: parsed.expansion || parsed.expansion_recommendation || parsed.expansion_probability,
          expansion_color: parsed.expansion_color,
          insight: parsed.insight,
          note: parsed.note
        })
      };
      res.json({ result: enriched });
      return;
    }

    res.json({ result: parsed });
  });

  child.stdin.write(JSON.stringify(args || {}));
  child.stdin.end();
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
        scorecard: {
          company: company,
          score: score,
          seats_purchased: seats,
          active_users: active_users,
          spend: spend,
          insights: `Detected seats=${seats || 'n/a'}, active_users=${active_users || 'n/a'}, spend=${spend || 'n/a'}`,
          recommendations: 'Increase training for low-adoption teams; consider seat reallocation.'
        }
      };

      res.json({ result });
      return;
    }

    if (name === 'predict_copilot_value') {
      runPrediction(args, res);
      return;
    }

    if (name === 'render_value_card') {
      res.json({ result: normalizeCard(args) });
      return;
    }

    if (name === 'benchmark_department_value') {
      const result = benchmarkDepartments(args);
      if (result.error) {
        res.status(400).json({ error: result.error });
        return;
      }
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
