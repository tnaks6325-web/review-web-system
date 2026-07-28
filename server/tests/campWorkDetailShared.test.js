/**
 * campWorkDetailShared.test.js — 작업내용 공용 렌더러(frontend/js/campaign-workdetail.js) 회귀가드.
 * 이 모듈은 실제 리뷰어 화면(campaign.html)과 관리자 미리보기가 함께 쓰므로,
 * 여기서 깨지면 "리뷰어가 보는 화면"이 곧바로 깨진다.
 * 실행: node tests/campWorkDetailShared.test.js
 */
const assert = require('assert');
const store = {};
global.window = { API_BASE_URL: 'https://api.example.com' };
global.document = {
  getElementById: id => store[id] || null,
  createElement: () => ({ set textContent(v){ this._t=v; }, get textContent(){ return this._t; } }),
  head: { appendChild(){} },
};
require('../../frontend/js/campaign-workdetail.js');
const M = global.window.CampWorkDetail;
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

ok('상품 라인 — 같은 결제금액 반복은 한 줄로 합침(실제 화면 규칙)', () => {
  const out = M.fmtProduct({ productLines: '멀티싱글 - 결제금액 78,000원\n그레이 - 결제금액 78,000원' });
  assert.strictEqual(out, '멀티싱글\n그레이\n결제금액 78,000원');
});
ok('상품 라인 — 비었으면 안내 문구', () => {
  assert.strictEqual(M.fmtProduct({}), '(등록된 상품 정보가 없어요)');
});
ok('리뷰가이드 — [리뷰등록 가이드] 섹션만 추출(유입 섹션 제거)', () => {
  const raw = '[유입방식] 유입가이드\n검색어: 장수돌침대\n[리뷰등록 가이드]\n전체 별점 5건\n- 배송이 빠르다';
  assert.strictEqual(M.pickReviewOnly(raw), '전체 별점 5건\n- 배송이 빠르다');
});
ok('리뷰가이드 — [라벨] 마커 없으면 원문 그대로', () => {
  assert.strictEqual(M.pickReviewOnly('그냥 평문 가이드'), '그냥 평문 가이드');
});
ok('첨부 이미지 — guide-image 토큰을 신뢰 베이스로 재구성', () => {
  const h = M.extractGuideImages('보기 https://evil.test/api/order/guide-image/abcdefghijklmnopqrstuvw', '', 'https://api.example.com');
  assert.ok(h.includes('https://api.example.com/api/order/guide-image/abcdefghijklmnopqrstuvw'));
  assert.ok(!h.includes('evil.test'));
});
ok('첨부 이미지 — 유입 HTML에 같은 파일ID 있으면 중복 노출 안 함', () => {
  const existing = '<img src="https://x/api/order/guide-image/abcdefghijklmnopqrstuvw">';
  assert.strictEqual(M.extractGuideImages('https://y/api/order/guide-image/abcdefghijklmnopqrstuvw', existing, ''), '');
});
ok('카드 HTML — 상품·유입가이드는 항상, 리뷰/특이사항은 값 있을 때만', () => {
  const h = M.cardsHtml({ workDetail: { productLines: 'A', reviewGuide: '[리뷰등록 가이드]\n별점 5' } });
  assert.ok(h.includes('📦 상품 · 옵션 · 결제금액'));
  assert.ok(h.includes('🧭 유입가이드'));
  assert.ok(h.includes('📝 리뷰 가이드'));
  assert.ok(!h.includes('📌 특이사항'));
});
ok('카드 HTML — 상품 텍스트는 escape(XSS 차단), 유입 HTML은 서버 sanitize본 그대로', () => {
  const h = M.cardsHtml({ workDetail: { productLines: '<img src=x onerror=alert(1)>', inflowGuideHtml: '<b>굵게</b>' } });
  assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(h.includes('<b>굵게</b>'));
});
ok('랜딩 버튼 — 링크유입/불명일 때만 노출, 가이드유입이면 숨김', () => {
  assert.ok(M.cardsHtml({ workDetail:{}, landingUrl:'https://c.kr/p/1' }).includes('data-cwd-landing'));
  assert.ok(M.cardsHtml({ workDetail:{}, landingUrl:'https://c.kr/p/1', inflowType:'link' }).includes('data-cwd-landing'));
  assert.ok(!M.cardsHtml({ workDetail:{}, landingUrl:'https://c.kr/p/1', inflowType:'guide' }).includes('data-cwd-landing'));
});
ok('옵션 카드 — showOption:false면 미출력(리뷰어 페이지는 별도 렌더)', () => {
  const d = { workDetail:{}, selectedOption:{ optKey:'멀티싱글', payAmount:78000 } };
  assert.ok(M.cardsHtml(d).includes('멀티싱글'));
  assert.ok(!M.cardsHtml(d, { showOption:false }).includes('멀티싱글'));
});

/* ── 소비처 배선 고정: 미리보기가 다시 별도 모형으로 갈라지지 않도록 ── */
const fs = require('fs'), path = require('path');
const rd = f => fs.readFileSync(path.join(__dirname, '../../frontend', f), 'utf8');

ok('리뷰어 페이지(campaign.html)가 공용 렌더러를 쓴다 — 자체 사본 부활 금지', () => {
  const s = rd('campaign.html');
  assert.ok(s.includes('js/campaign-workdetail.js'), '모듈 로드');
  assert.ok(/CampWorkDetail\.renderInto\(\$\('wdCards'\)/.test(s), 'renderInto 사용');
  for (const dead of ['function _fmtProduct', 'function _pickReviewOnly', 'function _extractGuideImages']) {
    assert.ok(!s.includes(dead), '중복 정의 부활: ' + dead);
  }
});

ok('관리자 미리보기가 같은 렌더러를 쓴다(모형 카드 아님)', () => {
  const s = rd('js/index-recruit.js');
  assert.ok(s.includes('CampWorkDetail.renderInto'), 'renderInto 사용');
  assert.ok(!s.includes('참여 신청하기'), '옛 모형 카드 잔존');
  assert.ok(rd('admin.html').includes('js/campaign-workdetail.js'), 'admin.html 모듈 로드');
});

ok('리뷰어앱 공고수정 모달: 파일 업로드 제거 + 유입가이드 미리보기 추가', () => {
  const s = rd('js/campaign-cards.js');
  assert.ok(!s.includes('cae_thumb_file'), '파일 업로드 입력 잔존');
  assert.ok(!s.includes('_caeThumbFromFile'), '업로드 핸들러 잔존');
  assert.ok(s.includes('cae_thumb'), '썸네일 URL 입력은 유지되어야 함');
  assert.ok(s.includes('_caeRenderWorkDetail'), '유입가이드 미리보기 미배선');
  assert.ok(s.includes('CampWorkDetail.renderInto') || s.includes('window.CampWorkDetail.renderInto'), '공용 렌더러 사용');
});

ok('공용 렌더러를 쓰는 모든 페이지가 스크립트를 로드한다', () => {
  for (const f of ['campaign.html', 'admin.html', 'index.html', 'recruit.html']) {
    assert.ok(rd(f).includes('js/campaign-workdetail.js'), f + ' 미로드');
  }
});

console.log(`\n✅ campaign-workdetail — ${n} cases passed`);
