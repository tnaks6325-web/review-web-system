/**
 * 결정 243 — "참여하기" 없이 연 인기 공고 구매양식의 참여권 안내(막지 않음).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

const r = read('server/src/routes/campaign.routes.js');
const gi = r.indexOf("router.get('/order-form-gate'");
assert.ok(gi > 0 && gi < r.indexOf("router.get('/:id'"), 'registered before /:id');
const g = r.slice(gi, r.indexOf('\n});', gi));
assert.ok(/reviewerSessionMiddleware/.test(g), 'signed reviewer session only (no phone parameter trust)');
assert.ok(/camp\.is_popular !== true\) return res\.json\(\{ ok: true, gate: false \}\)/.test(g), 'only popular campaigns');
assert.ok(/loadVerifiedOwnerPhones/.test(g) && /req\.reviewer\.loginKind === 'sub'/.test(g), 'owner login: any verified name · sub login: that name only');
assert.ok(/loadPopularCreditState\(pool, p8\)/.test(g) && /canUsePopularCredit\(st\)/.test(g), 'same single source as the apply gate');
assert.ok(/gate: credits <= 0, credits/.test(g), 'returns remaining credits so the form can compare against order cards');
assert.ok(/NULLIF\(linked_tab_gid, ''\) IS NOT NULL AND linked_tab_gid = NULLIF\(\$3, ''\)/.test(g), 'renamed tab: gid match (blank-safe)');
assert.ok(/res\.json\(\{ ok: true, gate: false, unknown: true \}\)/.test(g), 'failure opens (fail-open)');

const sa = read('frontend/js/search-app.js');
assert.ok(/if \(!\(_EMBED_CTX && _EMBED_CTX\.app\) && !_PREVIEW_MODE && authSession && authSession\.reviewerToken\) \{\s*_orderFormPopularGate/.test(sa),
  'only forms opened without a hold (participation path untouched)');
const fn = sa.slice(sa.indexOf('let _POPULAR_GATE = null;'), sa.indexOf('function initOrderFormMode('));
assert.ok(/_BATCH\.holds\.length\) return;/.test(fn), 'batch hold submissions skip');
assert.ok(/if \(!r\.ok\) return;/.test(fn) && /catch \(_\) \{/.test(fn), 'old server / failure = nothing');
assert.ok(/data-pg-continue/.test(fn) && /ov\.remove\(\)/.test(fn), 'continue anyway closes the notice (never blocks)');
assert.ok(/campaign\.html\?id=' \+ encodeURIComponent\(info\.campaignId\)/.test(fn), 'go to participate');
assert.ok(/className = "modal-overlay"/.test(fn) && /class="modal-box"/.test(fn) && /class="modal-actions"/.test(fn), 'existing purchase-form popup style (no new look)');
assert.ok(/if \(cards <= g\.credits \|\| cards <= \(Number\(g\.acked\) \|\| 0\)\) return true;/.test(fn), 'per-card credit check, asked once');
assert.ok(/if \(!\(await _popularGateBeforeSubmit\(\)\)\)/.test(sa), 'submit asks before sending when cards exceed credits');
assert.ok(/"X-Reviewer-Token": token/.test(fn), 'session token header');

console.log('orderFormPopularGate: passed');
