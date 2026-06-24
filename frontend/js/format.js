// Formatting + small DOM helpers. Pure presentation — no business logic.

export function n(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function fmtInt(value) {
  return Number(value || 0).toLocaleString('en-US');
}

export function fmtUsd(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

export function fmtUsdCompact(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
}

export function fmtPct(value, digits = 1) {
  return `${Number(value || 0).toFixed(digits)}%`;
}

// Null-safe display: returns the dash placeholder when a value is missing.
export function orDash(value) {
  return value === null || value === undefined || value === '' ? '—' : value;
}

export function priorityClass(priority) {
  return `priority-${String(priority || 'cold').toLowerCase()}`;
}

export function roiClass(roiPct) {
  if (roiPct >= 100) return { bg: 'rgba(67,217,173,0.15)', fg: 'var(--accent4)' };
  if (roiPct >= 30) return { bg: 'rgba(255,200,87,0.15)', fg: 'var(--warning)' };
  return { bg: 'rgba(255,77,109,0.15)', fg: 'var(--danger)' };
}

export function healthColor(health) {
  const h = String(health || '').toLowerCase();
  if (h.includes('strong')) return 'var(--accent4)';
  if (h.includes('moderate')) return 'var(--warning)';
  if (h.includes('risk') || h.includes('weak')) return 'var(--danger)';
  return 'var(--text-secondary)';
}

// Escape user/LLM text before injecting into innerHTML.
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render multi-paragraph text (preserves blank-line paragraphs + newlines).
export function escMultiline(value) {
  return esc(value).replace(/\n/g, '<br>');
}

// Tiny element factory: el('div', { class: 'x' }, [child, 'text']).
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function adoptionPct(metrics = {}) {
  const licensed = n(metrics.licensed_users);
  const active = n(metrics.active_users);
  if (Number.isFinite(Number(metrics.adoption_rate)) && metrics.adoption_rate) {
    return Number(metrics.adoption_rate) * 100;
  }
  return licensed > 0 ? (active / licensed) * 100 : 0;
}
