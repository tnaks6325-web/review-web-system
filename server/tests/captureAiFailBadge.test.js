'use strict';
/**
 * 결정 331 보강 — 구매캡처 AI 분석이 실패하면 사진 옆 표시(`<cid>_imgLabel`)가 「분석 완료 ✓」로 남지 않는다.
 *
 * 종전: `_callCardExtractAi` 가 서버 응답을 받자마자(오류 여부를 보기 전에) 「분석 완료 ✓」를 찍고,
 *   `_showCardAiError` 는 표시가 「분석 중」일 때만 「분석 실패 ✗」로 바꿨다 → 서버가 판독 실패({error})를
 *   돌려주면 빨간 오류 상자 옆에 「분석 완료 ✓」가 그대로 보였다(PR #1756 캡처).
 * 지금: 「분석 완료 ✓」는 판독이 성공한 뒤에만 · 실패 상자를 띄우면 표시는 「분석 실패 ✗」 ·
 *   [다시 분석하기]로 성공하면 다시 「분석 완료 ✓」.
 *
 * 화면 함수 두 개(`_callCardExtractAi`·`_showCardAiError`)를 search-app.js 에서 그대로 떼어 vm 으로 돌린다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/search-app.js'), 'utf8');
const fnSrc = (head) => {
  const start = source.indexOf(head);
  assert(start >= 0, head);
  const ends = ['\nfunction ', '\nasync function ', '\nwindow.', '\n/**'].map(x => source.indexOf(x, start + 1)).filter(x => x >= 0);
  return source.slice(start, Math.min(...ends));
};

function makeCtx(responder) {
  const els = {};
  const elFor = (id) => els[id] || (els[id] = { id, textContent: '', innerHTML: '', value: '', style: {}, dataset: {}, classList: { add() {}, remove() {} } });
  const ctx = {
    _cardAiState: { c1: {} }, APP_CONFIG: { GAS_WEB_APP_URL: 'http://local' }, window: {}, _orderCardIds: ['c1'],
    document: { getElementById: elFor },
    _resetSavedIdentityPickerLabels() {}, _syncSubmissionIdentityAction() {}, _stopCardCountdown() {},
    _renderIdentityMatchState() {}, _ofpOnExtracted() {}, _ncVerifyIdentity() {}, _callCardExtractAi2() {},
    _matchCardIdentity: async () => { if (ctx._matchThrows) throw new Error('명의 확인 중 오류'); },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, AbortController: class { abort() {} },
    gasPostUpload: async () => responder(),
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc('async function _callCardExtractAi(') + '\n' + fnSrc('function _showCardAiError(') +
    '\nthis._run = _callCardExtractAi;', ctx);
  ctx.label = () => elFor('c1_imgLabel').textContent;
  ctx.errShown = () => elFor('c1_aiError').style.display === 'block';
  ctx.setLabel = (t) => { elFor('c1_imgLabel').textContent = t; };
  return ctx;
}

const SUCCESS = { ok: true, orderNumber: '123', recipient: '홍길동', extractToken: 't', imageHash: 'h' };

(async () => {
  console.log('\n구매캡처 AI 실패 → 사진 옆 표시');

  // 1) 서버가 판독 실패를 돌려줌(시간초과·인식 실패 등 — 결정 331 의 쉬운 안내)
  let resp = { error: 'AI가 잠시 응답하지 않아요. [다시 분석하기]를 누르거나 아래 칸을 직접 채워 주세요.', extractToken: 't', imageHash: 'h' };
  const c = makeCtx(() => resp);
  c.setLabel('a.jpg · AI 분석 중…');
  await c._run('c1', 'aGVsbG8=', 'image/jpeg');
  ok('서버 판독 실패 → 빨간 상자가 뜬다', c.errShown());
  ok('서버 판독 실패 → 표시는 「분석 실패 ✗」(「분석 완료 ✓」 아님)', c.label() === '분석 실패 ✗');

  // 2) [다시 분석하기] → 성공하면 「분석 완료 ✓」로 돌아온다(_retryCardAi 가 「AI 분석 중…」을 먼저 찍는다)
  resp = SUCCESS;
  c.setLabel('AI 분석 중…');
  await c._run('c1', 'aGVsbG8=', 'image/jpeg');
  ok('다시 분석해 성공 → 「분석 완료 ✓」', c.label() === '분석 완료 ✓');

  // 3) 성공 뒤 다시 분석했는데 실패 → 다시 「분석 실패 ✗」
  resp = { error: '주문 정보를 인식하지 못했습니다.' };
  c.setLabel('AI 분석 중…');
  await c._run('c1', 'aGVsbG8=', 'image/jpeg');
  ok('성공 뒤 재분석 실패 → 「분석 실패 ✗」', c.label() === '분석 실패 ✗');

  // 4) 사진이 서버에 못 닿음(_transport) · 응답 없음(null)
  for (const [name, r] of [['사진 전송 실패(_transport)', { error: 'timeout', _transport: true }], ['빈 응답(null)', null]]) {
    const x = makeCtx(() => r);
    x.setLabel('AI 분석 중…');
    await x._run('c1', 'aGVsbG8=', 'image/jpeg');
    ok(name + ' → 「분석 실패 ✗」', x.label() === '분석 실패 ✗' && x.errShown());
  }

  // 5) 화면 시간초과(AbortError) — 종전에도 실패 표시였다(불변)
  const a = makeCtx(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  a.setLabel('AI 분석 중…');
  await a._run('c1', 'aGVsbG8=', 'image/jpeg');
  ok('화면 시간초과 → 「분석 실패 ✗」(불변)', a.label() === '분석 실패 ✗');

  // 6) 판독은 받았는데 뒤 처리에서 예외 → 빨간 상자가 뜨면 표시도 실패
  const m = makeCtx(() => SUCCESS);
  m._matchThrows = true;
  m.setLabel('AI 분석 중…');
  await m._run('c1', 'aGVsbG8=', 'image/jpeg');
  ok('판독 뒤 처리 예외로 빨간 상자 → 「분석 완료 ✓」로 남지 않는다', m.errShown() && m.label() === '분석 실패 ✗');

  // 7) 성공 흐름 불변 — 빨간 상자 없음 · 추출값 그대로
  const s = makeCtx(() => SUCCESS);
  s.setLabel('a.jpg · AI 분석 중…');
  await s._run('c1', 'aGVsbG8=', 'image/jpeg');
  ok('성공 → 「분석 완료 ✓」 · 빨간 상자 없음 · 추출값 보존',
    s.label() === '분석 완료 ✓' && !s.errShown() && s._cardAiState.c1.extracted.orderNumber === '123' && s._cardAiState.c1.extractToken === 't');

  // 8) 실패 상자가 사진과 무관한 표시(예: 배치 「복원된 사진(축소본)」)를 덮어쓰지 않는다
  const r = makeCtx(() => null);
  r.setLabel('복원된 사진(축소본)');
  r.document.getElementById('c1_aiError');
  vm.runInContext('_showCardAiError("c1", "x", false)', r);
  ok('「분석 중/완료」가 아닌 표시는 건드리지 않는다', r.label() === '복원된 사진(축소본)');

  console.log(`\n${n}개 규칙 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
