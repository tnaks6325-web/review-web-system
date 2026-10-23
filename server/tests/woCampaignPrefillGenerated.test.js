'use strict';
/**
 * 회귀가드 — 발행 프리필 서버 사본(`src/utils/woCampaignPrefill.generated.js`)이 화면 원본과 같다 (결정 274)
 *
 * 실행: node tests/woCampaignPrefillGenerated.test.js
 *
 * ★ 지키는 것:
 *   ① 저장된 사본 = 생성기를 지금 다시 돌린 결과(한 글자라도 다르면 실패) — 화면만 고치고 사본을 안 만들면 여기서 걸린다
 *   ② 같은 입력을 화면 원본(vm 실행)과 서버 사본에 넣으면 **결과가 완전히 같다** — 실행 환경 차이(엄격 모드·전역)까지 잡는다
 *   ③ 변이: 화면 원본을 한 글자 바꾸면 ① 이 실제로 실패한다(가드가 장식이 아님)
 *   ④ 사본에 브라우저 전역(document·window…)이 없다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const gen = require(path.join(ROOT, 'scripts/gen-wo-campaign-prefill.js'));
const generated = require(path.join(ROOT, 'src/utils/woCampaignPrefill.generated.js'));
const WOD = fs.readFileSync(gen.SRC, 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}

function frontPrefill() {
  const stub = new Proxy(function () {}, { get: (x, k) => (k === Symbol.toPrimitive ? () => '' : stub), apply: () => stub, construct: () => stub });
  const sandbox = { console, window: {}, document: stub, localStorage: stub, navigator: stub, URL, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(WOD, sandbox);
  assert.strictEqual(typeof sandbox.window._woCampaignPrefill, 'function', '화면 원본이 _woCampaignPrefill 을 내보내지 않는다');
  return sandbox.window._woCampaignPrefill;
}

const P = (v) => JSON.stringify(v);
const PROXY_IMG = 'https://review-api.example.com/api/order/guide-image/abcdefghijklmnopqrstuvwxyz012345';
const FIXTURES = [
  {},
  { title: '옛 오더', purchase_time: '자유시간대', review_fee: '', recruit_count: 30, delivery_type: '빈택배', review_type: '포토' },
  { title: '복합', product_url: 'https://www.coupang.com/vp/products/1?src=naver_ad', inflow_type: 'link', review_fee: 1000, skip_weekends: true,
    daily_count_text: '일 10건', work_kind: 'review', review_type: '혼합(포토 3건, 텍스트 2건)', review_type_mix: [{ type: 'photo', quantity: 3 }, { type: 'text', quantity: 2 }],
    product_options_json: P([
      { name: 'A', url: 'https://smartstore.naver.com/a', product_mode: 'opt', base: { pay: 9000 },
        options: [{ option_1: { name: '색', value: '빨강' }, label: '빨강', pay: 10000, count: 3, daily: 1, review_type_mix: [{ type: 'photo', quantity: 3 }] },
                  { option_1: { name: '색', value: '파랑' }, label: '파랑', count: 2, guide: { text: '파랑 가이드 "따옴표"', images: [PROXY_IMG] } }] },
      { name: 'B', product_mode: 'none', base: { pay: 5000, count: 4, daily: 2, guide: { text: 'B 전용 <안내>' } }, options: [] },
    ]) },
  { title: '블로그', work_kind: 'blog', review_type: '포토', review_type_mix: [{ type: 'photo', quantity: 1 }], inflow_type: 'guide',
    inflow_guide: '검색창에 상품명\n' + PROXY_IMG, review_guide: '[리뷰등록 가이드]\n사진 3장\n[특이사항]\n없음', special_notes: '주의' },
  { title: '회수', delivery_type: '회수(회수택배사: CJ 대한통운, 회수상품명칭: 카메라)', recall_courier: 'CJ 대한통운', recall_product: '카메라',
    start_date: '2026-10-21T00:00:00.000Z', work_manager: '박은비', purchase_channel: '네이버 5건 / 오늘의집 20건' },
  { title: '옵션 없음 단일', product_options_json: P([{ name: '단일상품', product_mode: 'none', base: { pay: 7000, count: 10 }, options: [] }]) },
  { title: '깨진 JSON', product_options_json: '{not json' },
];

t('① 저장된 사본 = 지금 생성 결과(화면 원본과 동기)', () => {
  assert.strictEqual(fs.readFileSync(gen.OUT, 'utf8'), gen.generate(), 'node scripts/gen-wo-campaign-prefill.js 로 다시 만드세요');
});

t('② 같은 입력 → 화면 원본과 서버 사본의 결과가 완전히 같다(픽스처 ' + FIXTURES.length + '종)', () => {
  const front = frontPrefill();
  for (const [i, f] of FIXTURES.entries()) {
    const a = JSON.parse(JSON.stringify(front(JSON.parse(JSON.stringify(f)))));
    const b = JSON.parse(JSON.stringify(generated._woCampaignPrefill(JSON.parse(JSON.stringify(f)))));
    assert.deepStrictEqual(b, a, `픽스처 ${i} 결과가 다르다`);
  }
});

t('②-1 픽스처가 실제로 갈래를 탄다(옵션 줄·상품 단위 줄·가이드 사진·채널 판정)', () => {
  const p = generated._woCampaignPrefill(JSON.parse(JSON.stringify(FIXTURES[2])));
  assert.strictEqual(p.options.length, 3);
  assert.deepStrictEqual(p.options.map(o => o.unitKind), ['option', 'option', 'product']);
  assert.deepStrictEqual(p.options[1].inflowGuideImages, [PROXY_IMG]);
  assert.strictEqual(p.channel, '쿠팡', '쿼리스트링이 아니라 호스트로 판정');
  assert.strictEqual(p.skip_weekends, true);
});

t('③ 변이 — 화면 원본이 바뀌면 생성 결과가 달라진다(가드가 실제로 잡는다)', () => {
  const orig = fs.readFileSync(gen.SRC, 'utf8');
  const mutated = orig.replace('review_fee:    Number(o.review_fee ?? o.reviewFee ?? 0) || 0,', 'review_fee:    Number(o.review_fee ?? o.reviewFee ?? 0) || 1,');
  assert.notStrictEqual(mutated, orig, '변이 지점을 못 찾았다 — 프리필 리뷰비 줄이 바뀌었으면 이 시험을 갱신');
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => (p === gen.SRC ? mutated : realRead(p, ...rest));
  try { assert.notStrictEqual(gen.generate(), realRead(gen.OUT, 'utf8')); }
  finally { fs.readFileSync = realRead; }
});

t('④ 사본에 브라우저 전역이 없다 · 자동 생성 표시가 있다', () => {
  const src = fs.readFileSync(gen.OUT, 'utf8');
  assert.ok(!/\b(document|window|localStorage|sessionStorage|navigator|fetch)\s*[.[(]/.test(src));
  assert.ok(src.includes('자동 생성 파일 — 손으로 고치지 말 것'));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
