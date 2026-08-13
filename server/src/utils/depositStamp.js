'use strict';

// Workboard deposit values are an audit trail: a later transfer must not erase
// an earlier transfer. Keep the same M/D HH:mm format as review submissions.
function _dateToken(value) {
  const m = String(value == null ? '' : value).trim()
    .match(/(?:20\d{2}[.\/-]\s*)?(\d{1,2})[.\/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const month = Number(m[1]), day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const hour = m[3] == null ? null : Number(m[3]);
  const minute = m[4] == null ? null : Number(m[4]);
  if (hour != null && (hour > 23 || minute > 59)) return null;
  return {
    key: `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    label: `${month}/${day}${hour == null ? '' : ` ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`}`,
  };
}

function formatDepositStamp(value) {
  const token = _dateToken(value);
  return token ? token.label : String(value == null ? '' : value).trim();
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

// A transfer date may be moved only after the caller has positively identified
// both sides of the correction.  This helper deliberately removes a matching
// *date token* only; arbitrary free text in the audit value is retained.
function removeDepositStamp(existing, removing) {
  const target = _dateToken(removing);
  if (!target) return String(existing == null ? '' : existing).trim();
  const dated = new Map();
  const other = [];
  for (const part of String(existing == null ? '' : existing).split(/\s*,\s*/)) {
    const clean = part.trim();
    if (!clean) continue;
    const date = _dateToken(clean);
    if (date) {
      if (date.key !== target.key) dated.set(date.key, date.label);
    } else if (!other.includes(clean)) {
      other.push(clean);
    }
  }
  return [...other, ...[...dated.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, label]) => label)].join(', ');
}

module.exports = { formatDepositStamp, mergeDepositStamps, removeDepositStamp };
