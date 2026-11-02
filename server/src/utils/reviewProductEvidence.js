'use strict';
// Dependency-free semantic evidence; never imports a DB, parser or network client.
const PRODUCT_EVIDENCE_VERSION = 'review-product-evidence-v2';
const compact = s => s.replace(/[^\p{L}\p{N}]/gu, '');
function clean(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\s*\(?https?:\S*\)?\s*$/, '')
    .replace(/(?:…|‥|\.{2,})\s*$/, '')
    .replace(/\[new\]/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*시간\s*보습/g, '')
    .replace(/\d+(?:\.\d+)?\s*%\s*할인/g, '').trim();
}
// Exact base-ten shifts avoid Number rounding silently merging product options.
function decimal(value, shift = 0) {
  const [whole, fraction = ''] = value.split('.');
  const digits = whole + fraction + '0'.repeat(Math.max(0, shift - fraction.length));
  const point = whole.length + shift;
  const integer = (digits.slice(0, point) || '0').replace(/^0+(?=\d)/, '');
  const tail = digits.slice(point).replace(/0+$/, '');
  return integer + (tail ? `.${tail}` : '');
}
function parse(value) {
  let text = clean(value);
  const axes = {};
  const add = (role, val) => { (axes[role] || (axes[role] = [])).push(String(val)); };
  // A multiplication following a physical unit is an explicit unit count,
  // not a model. Keep each unit size; never compare total volume.
  text = text.replace(/(?<![a-z0-9.])(\d+(?:\.\d+)?\s*(?:ml|kg|mg|g|l))\s*[x×*]\s*(\d+)(?![\d.])/g,
    (_, size, n) => { add('count:개', decimal(n)); return size + ' § '; });
  // Protect the whole model before reading physical units: AB100ML is a
  // model token, not an independently stated 100ml quantity.
  const families = [];
  let ambiguousModel = false;
  text = text.replace(/(?<![a-z0-9.])([a-z]+(?:-[a-z]+)*)-?(\d+(?:\.\d+)?)([a-z0-9]*(?:-[a-z0-9]+)*)(?![a-z0-9.])/g,
    (_, family, number, suffix) => {
      const f = family.replace(/-/g, '');
      // Letter/number hyphens are cosmetic (AB-100-A); digit/digit
      // boundaries identify model segments (AB100-2 must not become AB10-02).
      add('model', `${f}${number}${suffix}`.replace(/(?<!\d)-|-(?!\d)/g, ''));
      families.push(f);
      if (number.includes('.')) ambiguousModel = true;
      return ' § ';
    });
  const numericSource = text;
  let numericSyntaxUnknown = /(?<!\d)\.\d/.test(numericSource);
  text = text.replace(/([-+−±]\s*)?(\d+(?:\.\d+)?)\s*(년형|년도|년|세대|mah|kg|mg|ml|cm|mm|g|l|캡슐|박스|세트|개입|정|포|개|매|입|종|인치|%)(?![a-z])/g,
    (_, sign, num, unit) => {
      // Use the role match itself: cleanup must not erase a signed quantity.
      // Models (including legitimate hyphens) have already been protected.
      if (sign) numericSyntaxUnknown = true;
      const n = decimal(num);
      const physical = { ml: ['volume', 0], l: ['volume', 3], mg: ['mass', 0], g: ['mass', 3], kg: ['mass', 6] }[unit];
      if (physical) add(physical[0], decimal(num, physical[1]));
      else if (['년형', '년도', '년'].includes(unit)) add('year', n);
      else if (unit === '%') add('concentration', n);
      else add(`count:${unit}`, n);
      return ' § ';
    });

  const unknown = text.match(/\d+(?:\.\d+)?/g) || [];
  // Sorting role values cannot prove which separated body component owned
  // a quantity/model/year. Preserve boundaries from this same parser. One
  // contiguous body may still have global quantities before and after it.
  const dimensionCount = Object.values(axes).reduce((n, vals) => n + vals.length, 0);
  const interleaved = dimensionCount > 0 && text.split('§')
    .filter(part => compact(part.replace(/\d+(?:\.\d+)?/g, ''))).length > 1;
  const body = compact(text.replace(/\d+(?:\.\d+)?/g, '')) + families.sort().join('');
  for (const key of Object.keys(axes)) axes[key].sort();
  const countRoles = Object.keys(axes).filter(k => k.startsWith('count:'));
  const ambiguous = ambiguousModel || interleaved || unknown.length > 0 || Object.values(axes).some(vals => vals.includes('0') || vals.length > 1) || numericSyntaxUnknown || countRoles.length > 1 ||
    countRoles.some(k => axes[k].length > 1 || axes[k].some(n => n.includes('.'))) ||
    (countRoles.length > 0 && ['volume', 'mass'].some(k => axes[k] && axes[k].length > 1));
  return { body, dimensions: axes, unknown, ambiguous };
}
function dice(a, b) {
  if (a === b) return a ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map();
  for (let i = 0; i < a.length - 1; i++) { const p = a.slice(i, i + 2); pairs.set(p, (pairs.get(p) || 0) + 1); }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) { const p = b.slice(i, i + 2); if (pairs.get(p) > 0) { overlap++; pairs.set(p, pairs.get(p) - 1); } }
  return 2 * overlap / (a.length + b.length - 2);
}
function isHeading(value) {
  const s = compact(clean(value));
  return !s || s === '상품' || s.startsWith('합계최종모집인원') || s.startsWith('최종모집인원');
}
function semanticKey(parsed) {
  return JSON.stringify([parsed.body, Object.keys(parsed.dimensions).sort().map(k => [k, parsed.dimensions[k]]),
    parsed.unknown, !!parsed.ambiguous]);
}
function compareReviewProduct(ocr, canonicalExpected, { aliases = [], criteriaIncomplete = false } = {}) {
  // Aliases are deliberately not positive proof. Do not turn them into candidates.
  void aliases;
  const rawCandidates = (Array.isArray(canonicalExpected) ? canonicalExpected : []).map(s => String(s || ''));
  const candidates = rawCandidates.filter(s => !isHeading(s));
  const observed = parse(ocr);
  const signature = JSON.stringify([PRODUCT_EVIDENCE_VERSION, rawCandidates.slice().sort(), String(ocr || ''), !!criteriaIncomplete]);
  const semanticSignature = JSON.stringify([PRODUCT_EVIDENCE_VERSION, !!criteriaIncomplete,
    [...new Set(candidates.map(candidate => semanticKey(parse(candidate))))].sort(), semanticKey(observed)]);
  function result(kind, reason, candidate = '', expected = parse(''), score = 0, lengthRatio = 0) {
    return { kind, reason, candidate, axes: { expected, observed },
      score: dice(expected.body, observed.body), rawScore: score, lengthRatio,
      version: PRODUCT_EVIDENCE_VERSION, signature, semanticSignature };
  }
  if (!candidates.length) return result('insufficient', 'no_expected');
  if (isHeading(ocr)) return result('insufficient', 'no_ocr');
  if (criteriaIncomplete) return result('insufficient', 'incomplete_criteria');
  const evaluations = candidates.map(candidate => {
    const expected = parse(candidate);
    const aText = compact(clean(candidate)), bText = compact(clean(ocr));
    const lengthRatio = Math.min(aText.length, bText.length) / Math.max(aText.length, bText.length);
    const score = dice(aText, bText);
    // Similarity is diagnostic only: without independent proof, a changed
    // body may be a real variant rather than an OCR typo.
    const identity = expected.body && expected.body === observed.body;
    let kind = 'insufficient', reason = 'identity_mismatch';
    if (identity) {
      const a = expected.dimensions, b = observed.dimensions;
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      if (expected.ambiguous || observed.ambiguous) reason = 'ambiguous_dimensions';
      else if (keys.some(k => !a[k] || !b[k])) reason = 'missing_dimensions';
      else if (keys.some(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))) { kind = 'conflict'; reason = 'numeric_conflict'; }
      else { kind = 'match'; reason = 'semantic_match'; }
    }
    return result(kind, reason, candidate, expected, score, lengthRatio);
  });
  const matches = evaluations.filter(r => r.kind === 'match');
  if (new Set(matches.map(r => semanticKey(r.axes.expected))).size > 1) return { ...matches[0], kind: 'insufficient', reason: 'ambiguous_candidates' };
  if (matches.length) return matches[0];
  return evaluations.find(r => r.kind === 'conflict') || evaluations.sort((a, b) => b.score - a.score)[0];
}
module.exports = { compareReviewProduct, PRODUCT_EVIDENCE_VERSION };
