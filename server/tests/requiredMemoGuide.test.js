/**
 * 리뷰어 작업가이드 — 필수 배송메세지 안내 (결정 386)
 *
 *   공고에 필수 배송메세지(결정 260 · 예: 「문앞에 놓아주세요!」)를 적으면 구매양식 제출 때 캡처에서 그 글자를 확인해 막는데,
 *   리뷰어 작업가이드에는 그 문구가 어디에도 안 보였다(직원이 공고 제목에 「배송메시지 00<<<」를 적어 우회하던 상태).
 *
 *   확인:
 *     ① 서버 — 참여 후 작업가이드(/work-detail)·관리자 미리보기(/admin/:id/preview) 응답에 requiredDeliveryMemo(정규화된 글자 · 없으면 '')
 *     ② 화면 — 값이 있으면 상품 카드 바로 아래 「🚚 필수 배송메세지」 카드(글자 그대로 · 꺾쇠는 글자) · 없으면 카드 없음
 *     ③ Q&A(구매 없음)에는 안 보인다 · 개편 배치(v18)에서도 접히지 않고 남는다
 *     ④ 화면 연결 — 리뷰어 작업가이드(campaign.html)와 공고 창 미리보기가 값을 넘긴다
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (n, c, x) => { assert(c, n + (x ? '  ← ' + x : '')); passed++; console.log('  ✓ ' + n); };
const ROOT = path.resolve(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('\n[① 서버 응답]');
const route = read('server/src/routes/campaign.routes.js');
const slice = (head, endHead) => { const s = route.indexOf(head); assert(s >= 0, head); return route.slice(s, route.indexOf(endHead, s + head.length)); };
const wdRoute = slice("router.get('/:id/work-detail'", '\nrouter.');
const pvRoute = slice("router.get('/admin/:id/preview'", '\nrouter.');
ok('작업가이드 응답에 requiredDeliveryMemo(정규화 함수 단일 출처)', /requiredDeliveryMemo:\s*_requiredMemoView\(camp\)/.test(wdRoute));
ok('관리자 미리보기 응답에도 같은 값', /requiredDeliveryMemo:\s*_requiredMemoView\(camp\)/.test(pvRoute));
const fnStart = route.indexOf('function _requiredMemoView(');
ok('_requiredMemoView 가 있다', fnStart >= 0);
const vm = require('vm');
const fnSrc = route.slice(fnStart, route.indexOf('\n}\n', fnStart) + 3);
const ctx = { require: p => require(path.join(__dirname, '..', 'src', 'routes', p)) };
vm.createContext(ctx);
vm.runInContext(fnSrc + '\nthis.f = _requiredMemoView;', ctx);
ok('공백 정리된 글자 · 없으면 빈 문자열', ctx.f({ required_delivery_memo: '  문앞에   놓아주세요! ' }) === '문앞에 놓아주세요!'
  && ctx.f({ required_delivery_memo: null }) === '' && ctx.f({}) === '' && ctx.f(null) === '');

console.log('\n[② 화면 카드]');
global.window = { API_BASE_URL: 'https://api.example' };
global.document = { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } };
require('../../frontend/js/campaign-workdetail.js');
const M = global.window.CampWorkDetail;
const wd = { productLines: '가상 탈취제 300g - 결제금액 10,000원', reviewGuide: '포토 리뷰' };
const withMemo = M.cardsHtml({ workDetail: wd, requiredDeliveryMemo: '문앞에 놓아주세요!' }, { showOption: false });
ok('「🚚 필수 배송메세지」 카드에 글자가 그대로', withMemo.includes('🚚 필수 배송메세지') && withMemo.includes('문앞에 놓아주세요!'), withMemo);
ok('하단 안내는 「구매캡처에 이 배송메세지가 보여야 구매양식이 제출돼요.」 한 문장만(사용자 확정 2026-11-19)',
  withMemo.includes('>구매캡처에 이 배송메세지가 보여야 구매양식이 제출돼요.</div>') && !/결제할 때 배송메세지/.test(withMemo), withMemo);
const iProd = withMemo.indexOf('📦 상품'), iMemo = withMemo.indexOf('🚚 필수 배송메세지'), iRev = withMemo.indexOf('📝 리뷰 가이드');
ok('상품 카드 바로 아래 · 리뷰 가이드보다 위', iProd >= 0 && iProd < iMemo && iMemo < iRev);
ok('꺾쇠는 글자로', M.cardsHtml({ workDetail: wd, requiredDeliveryMemo: '<b>00</b>' }, {}).includes('&lt;b&gt;00'));
ok('값이 없거나 공백·옛 서버(칸 없음)면 카드 없음',
  !M.cardsHtml({ workDetail: wd, requiredDeliveryMemo: '' }, {}).includes('필수 배송메세지')
  && !M.cardsHtml({ workDetail: wd, requiredDeliveryMemo: '   ' }, {}).includes('필수 배송메세지')
  && !M.cardsHtml({ workDetail: wd }, {}).includes('필수 배송메세지'));
ok('필수 배송메세지가 없으면 HTML 이 종전과 한 글자도 같다',
  M.cardsHtml({ workDetail: wd }, { showOption: false }) === M.cardsHtml({ workDetail: wd, requiredDeliveryMemo: '' }, { showOption: false }));

console.log('\n[③ Q&A · 개편 배치]');
ok('Q&A(showProduct:false)에는 안 보인다',
  !M.cardsHtml({ workDetail: wd, requiredDeliveryMemo: '00' }, { showProduct: false, showInflow: false }).includes('필수 배송메세지'));
const cwd = read('frontend/js/campaign-workdetail.js');
ok('카드 제목이 개편 배치의 접는 카드 표식(📦·🧭·📝·📌)으로 시작하지 않는다 — 접히거나 상품 카드로 오인되지 않게',
  /'<div class="cwd-tt"[^>]*>🚚 필수 배송메세지<\/div>'/.test(cwd));

console.log('\n[④ 화면 연결]');
const camp = read('frontend/campaign.html');
ok('리뷰어 작업가이드가 응답 값을 렌더러에 넘긴다', /requiredDeliveryMemo:\s*j\.requiredDeliveryMemo/.test(camp));
const rec = read('frontend/js/index-recruit.js');
ok('공고 창 미리보기도 입력칸 값을 넘긴다', /requiredDeliveryMemo:\s*_v\("rf_required_delivery_memo"\)/.test(rec));
// Codex 리뷰 #1846 — 입력칸을 고치거나 지우면 열린 미리보기가 바로 다시 그려져야 한다(목록에 없으면 다른 칸을 건드릴 때까지 옛 카드가 남는다)
const inputsLit = rec.match(/const _PREVIEW_INPUTS = (\[[\s\S]*?\]);/);
ok('필수 배송메세지 입력칸이 미리보기 다시 그리기 목록에 있다',
  !!inputsLit && JSON.parse(inputsLit[1]).includes('rf_required_delivery_memo'), inputsLit && inputsLit[1]);

console.log(`\n✅ requiredMemoGuide: ${passed}개 통과`);
