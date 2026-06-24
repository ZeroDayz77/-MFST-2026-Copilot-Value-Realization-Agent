// Chart builders. All charts are driven by real aggregates from the leads; they
// visualize backend numbers and never synthesize data. Uses Chart.js (global).

import { fmtUsdCompact } from './format.js';

const palette = ['#6c63ff', '#ff4d6d', '#43d9ad', '#00c2ff', '#ffc857', '#ff6b9d', '#8a92ff'];
const refs = {};

if (window.Chart) {
  Chart.defaults.color = '#8b92b8';
  Chart.defaults.borderColor = '#2e3352';
  Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
}

function upsert(id, config) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (refs[id]) refs[id].destroy();
  refs[id] = new Chart(canvas, config);
}

const baseOpts = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } },
};

export function renderCharts(companies) {
  const labels = companies.map((c) => c.name);
  const colors = companies.map((_, i) => palette[i % palette.length]);

  // ROI % by company
  upsert('roiChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'ROI %', data: companies.map((c) => Number(c.roiPercent.toFixed(1))), backgroundColor: colors, borderRadius: 6 }],
    },
    options: { ...baseOpts, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => `${v}%` } } } },
  });

  // Gross vs Net value by company
  upsert('valueChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Gross', data: companies.map((c) => c.gross), backgroundColor: '#43d9ad', borderRadius: 6 },
        { label: 'Net', data: companies.map((c) => c.net), backgroundColor: '#6c63ff', borderRadius: 6 },
      ],
    },
    options: { ...baseOpts, scales: { y: { ticks: { callback: (v) => fmtUsdCompact(v) } } } },
  });

  // Portfolio adoption donut (active vs idle seats)
  const licensed = companies.reduce((s, c) => s + c.licensed, 0);
  const active = companies.reduce((s, c) => s + c.active, 0);
  upsert('adoptionDonut', {
    type: 'doughnut',
    data: {
      labels: ['Active', 'Idle'],
      datasets: [{ data: [active, Math.max(licensed - active, 0)], backgroundColor: ['#43d9ad', '#2e3352'], borderWidth: 0 }],
    },
    options: { ...baseOpts, cutout: '68%' },
  });

  // Monthly spend by company
  upsert('spendChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Monthly Spend', data: companies.map((c) => c.spend), backgroundColor: '#00c2ff', borderRadius: 6 }],
    },
    options: { ...baseOpts, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ticks: { callback: (v) => fmtUsdCompact(v) } } } },
  });

  // Seats distribution by company
  upsert('seatsDonut', {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: companies.map((c) => c.licensed), backgroundColor: colors, borderWidth: 0 }],
    },
    options: { ...baseOpts, cutout: '60%' },
  });
}

export { palette };
