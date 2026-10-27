/**
 * 결정 299 — 필수 배송메세지가 확인되지 않은 주문의 「직원 확인 요청」은 두 번째 사진을 서버가 받았을 때만 받는다(사용자 확정 2026-10-27 다·1가).
 * 그리고 네이버의 라벨 없는 배송메모(배송지 카드 주소 아래 메모 아이콘 줄)를 AI 가 배송메세지로 읽는다.
 *   A. 서명 — 두 번째 사진 서명 발급/검증(주문번호 결속 · 다른 목적 서명 거부 · 위조 거부)
 *   B. 배선 — 판독 응답(성공·실패 둘 다)이 두 번째 장에만 서명을 싣는다 · 제출 게이트가 그 서명을 판정에 넘긴다
 *   C. AI 지시문 — 네이버 메모 아이콘 줄 규칙 · 캐시 접두 올림
 *   D. 화면 실행(vm) — 막힌 칸에만 「배송메세지 사진 추가」 · 첫 장 없으면 숨김 · 첫 장과 같은 사진 거부
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const roi = require('../src/services/reviewerOrderIdentity.service');

// ── A. 서명 ──
{
  const t = roi.issueSecondCaptureProof('2026-1027-001', 'hash1');
  assert.ok(t, 'issued');
  assert.equal(roi.readSecondCaptureProof(t, '20261027001'), true, 'same order (punctuation ignored)');
  assert.equal(roi.readSecondCaptureProof(t, '20261027002'), false, 'other order → false');
  assert.equal(roi.readSecondCaptureProof('', '20261027001'), false, 'none → false');
  assert.equal(roi.readSecondCaptureProof(t + 'x', '20261027001'), false, 'tampered → false');
  assert.equal(roi.issueSecondCaptureProof('', 'hash1'), '', 'no order number → no proof');
  const memoTok = roi.issueDeliveryMemoProof('문 앞', '20261027001');
  assert.equal(roi.readSecondCaptureProof(memoTok, '20261027001'), false, 'a delivery-memo proof is not a 2nd-photo proof');
  assert.equal(roi.readDeliveryMemoProof(t, '20261027001'), '', 'and vice versa');
}

// ── B. 배선 ──
{
  const diag = read('server/src/routes/diag.routes.js');
  assert.ok(/if \(secondCapture\) \{ try \{ capture2Token = reviewerOrderIdentity\.issueSecondCaptureProof\(memoOrder, imageHash\);/.test(diag), 'success path: only the 2nd capture gets the proof');
  assert.ok(/res\.json\(secondCapture \? \{ \.\.\.result, productLabel, deliveryMemoToken, capture2Token \} : \{ \.\.\.result, \.\.\.proof, productLabel, deliveryMemoToken \}\)/.test(diag), 'first capture response unchanged');
  assert.ok(/Number\(req\.body && req\.body\.captureIndex\) === 2\) \{\s*try \{ capture2Token = reviewerOrderIdentity\.issueSecondCaptureProof\(String\(\(req\.body && req\.body\.orderNumberHint\) \|\| ''\)\.trim\(\), imageHash\)/.test(diag),
    'AI failure path: the 2nd photo still counts as received');
  const sub = read('server/src/routes/submit.routes.js');
  assert.ok(/secondCaptureProven: reviewerOrderIdentity\.readSecondCaptureProof\(b\.capture2Token, orderNum\)/.test(sub), 'gate reads the proof bound to this order number');
  assert.ok(/needSecondCapture: rdmDecision\.needSecondCapture === true/.test(sub), 'block response tells the screen to ask for a 2nd photo');
  const sa = read('frontend/js/search-app.js');
  assert.ok(/capture2Token:\s+_cardAiState\[cid\]\?\.img2\?\.capture2Token \|\| ""/.test(sa) && /capture2Token:\s+o\.capture2Token \|\| ""/.test(sa), 'screen carries the proof to submit');
  assert.ok(/img\.capture2Token = \(json && json\.capture2Token\) \|\| "";\s*\/\/[^\n]*\n\s*if \(!json \|\| !json\.ok\)/.test(sa), 'proof kept even when the 2nd photo could not be read');
  assert.equal((sa.match(/id="\$\{cid\}_img2Add" style="display:none;/g) || []).length, 2, 'both card layouts have the (hidden) add-photo row');
}

// ── C. AI 지시문 ──
{
  const g = read('server/src/services/gemini.service.js');
  assert.ok(/메모\(문서\) 모양 아이콘과 함께 배송메모를 보여 준다/.test(g) && /아이콘 \+ "00" 이면 deliveryMemo="00"/.test(g), 'Naver icon-only memo line is the delivery memo');
  assert.ok(/배송지 카드 밖의 글이나 아이콘 없는 줄은 넣지 않는다/.test(g), 'kept narrow');
  assert.ok(/const EXTRACT_CACHE_VERSION = 'extract([6-9]|[1-9]\d+)';/.test(g), 'cache prefix bumped (old cache holds blank memos)');
}

// ── D. 화면 실행 ──
{
  const sa = read('frontend/js/search-app.js');
  const s = sa.indexOf('function _rdmNeedImg2(cid) {');
  const e = sa.indexOf('\n}\n', sa.indexOf('function onCardImg2AddSelected', s)) + 3;
  const s2 = sa.indexOf('function _setCardImg2(file, cid, opts = {}) {');
  const e2 = sa.indexOf('\n}\n', s2) + 3;
  const mk = () => ({ style: { display: 'none' }, textContent: '', src: '' });
  const els = {};
  const toasts = [];
  let readerInput = null;
  const ctx = {
    _cardAiState: { c1: { lastBase64: 'FIRST' }, c2: { lastBase64: '' } },
    document: { getElementById: (id) => (els[id] = els[id] || mk()) },
    showToast: (m) => toasts.push(m),
    _clearImg2Product: () => {}, _callCardExtractAi2: () => { ctx.aiCalls = (ctx.aiCalls || 0) + 1; },
    FileReader: function () { this.readAsDataURL = (f) => { readerInput = f; this.onload({ target: { result: 'data:image/png;base64,' + f.b64 } }); }; },
  };
  vm.createContext(ctx);
  vm.runInContext(sa.slice(s2, e2) + sa.slice(s, e) + '; this._rdmNeedImg2 = _rdmNeedImg2; this.onCardImg2AddSelected = onCardImg2AddSelected;', ctx);

  ctx._rdmNeedImg2('c1');
  assert.equal(els.c1_img2Add.style.display, 'flex', 'blocked card with a first photo → add button shown');
  ctx._rdmNeedImg2('c2');
  assert.equal((els.c2_img2Add || mk()).style.display, 'none', 'no first photo → not shown');

  const same = { value: 'x', files: [{ type: 'image/png', size: 10, b64: 'FIRST' }] };
  ctx.onCardImg2AddSelected(same, 'c1');
  assert.ok(/같은 사진/.test(toasts.pop() || ''), 'same photo as the first → rejected');
  assert.ok(!ctx._cardAiState.c1.img2, 'nothing attached');
  assert.equal(same.value, '', 'input cleared so the same file can be picked again');

  ctx.onCardImg2AddSelected({ value: 'x', files: [{ type: 'image/png', size: 10, b64: 'SECOND' }] }, 'c1');
  assert.ok(ctx._cardAiState.c1.img2 && ctx._cardAiState.c1.img2.capture2Token === '', 'different photo → attached (proof comes from the server read)');
  assert.equal(els.c1_img2Add.style.display, 'none', 'add button hidden once attached');
  assert.equal(ctx.aiCalls, 1, 'read right away (the first photo is already read)');

  ctx.onCardImg2AddSelected({ value: 'x', files: [{ type: 'image/png', size: 10, b64: 'Z' }] }, 'c2');
  assert.ok(/첫 번째 사진/.test(toasts.pop() || '') && !ctx._cardAiState.c2.img2, 'no first photo → asks for it first');
  assert.ok(readerInput, 'reader used');
}

console.log('deliveryMemoSecondPhoto: passed');
