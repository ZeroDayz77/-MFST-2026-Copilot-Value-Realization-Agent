// Dependency-free parsing of an uploaded leads file (CSV or JSON) plus mapping a
// flat row into a lead payload. Used by the intake flow as the deterministic
// path (and as a base even when the LLM extracts), so file intake works offline.

export function detectContentType(content, hint) {
  if (hint && hint !== 'auto') return String(hint).toLowerCase();
  const t = String(content).trim();
  if (t.startsWith('[') || t.startsWith('{')) return 'json';
  return 'csv';
}

// Full CSV parse: handles quoted fields, escaped quotes, and newlines in quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows
    .slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => {
      const obj = {};
      headers.forEach((h, idx) => {
        if (h) obj[h] = (r[idx] ?? '').trim();
      });
      return obj;
    });
}

// Returns { rows, type }. JSON accepts an array, {leads:[...]}, or a single object.
export function parseLeadRows(content, hint) {
  const type = detectContentType(content, hint);
  if (type === 'json') {
    try {
      const data = JSON.parse(content);
      const rows = Array.isArray(data)
        ? data
        : Array.isArray(data?.leads)
          ? data.leads
          : [data];
      return { rows, type: 'json' };
    } catch {
      // fall through to CSV if JSON was malformed
    }
  }
  return { rows: parseCsv(content), type: 'csv' };
}

// Map a flat row (or loose object) into a lead payload. Descriptive fields are
// pulled out; the whole row is kept as the metrics source for alias/estimation.
export function rowToPayload(row = {}) {
  const company_name =
    row.company_name || row.company || row.account || row.name || row.organization || '';
  return {
    company_name: company_name || 'Untitled Account',
    industry: row.industry || row.vertical || '',
    company_segment: row.company_segment || row.segment || '',
    department: row.department || row.team || '',
    contact: {
      name: row.contact_name || row.contact || row.poc || '',
      title: row.contact_title || row.title || '',
      email: row.email || row.contact_email || '',
    },
    _metricsSource: row,
    source: 'import',
  };
}

export default { detectContentType, parseCsv, parseLeadRows, rowToPayload };
