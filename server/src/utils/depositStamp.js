'use strict';

// Workboard deposit values are an audit trail: a later transfer must not erase
// an earlier date.  Keep a compact, date-only list so a repeated repair is safe.
function _dateToken(value) {
  const m = String(value == null ? '' : value).trim()
    .match(/(?:20\d{2}[.\/-]\s*)?(\d{1,2})[.\/-](\d{1,2})(?:\s+\d{1,2}:\d{2})?/);
  if (!m) return null;
  const month = Number(m[1]), day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { key: `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, label: `${month}/${day}` };
}

function mergeDepositStamps(existing, incoming) {
  if (!String(existing == null ? '' : existing).trim()) return String(incoming == null ? '' : incoming).trim();
  const raw = [existing, incoming].filter(v => String(v == null ? '' : v).trim());
  const dated = new Map();
  const other = [];
  for (const part of raw.flatMap(v => String(v).split(/\s*,\s*/))) {
    const date = _dateToken(part);
    if (date) dated.set(date.key, date.label);
    else if (part.trim() && !other.includes(part.trim())) other.push(part.trim());
  }
  return [...other, ...[...dated.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, label]) => label)].join(', ');
}

module.exports = { mergeDepositStamps };
