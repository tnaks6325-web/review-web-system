'use strict';
/**
 * 회귀가드 — 양방향 동기화 칸 목록·비교 정규화 (결정 274)
 *
 * 실행: node tests/sharedFields.test.js
 *
 * ★ 지키는 것:
 *   ① 같은 뜻을 다르게 적은 값은 **같다** — 2026-10-20 운영 대조에서 실제로 나온 표기 차이 전부
 *      (거짓 vs 0 · 빈 값 vs 기본값 · 포토 vs photo · 자율리뷰 vs 빈 값 · 시간 띄어쓰기 · 옛 배송 표기 · 혼합 순서 · JSON 키 순서)
 *   ② 진짜 차이는 **다르다**(리뷰비 1000 vs 1500 · 0명 vs 빈 값 · 주말 미정 vs 포함) — 가짜로 같게 접지 않는다
 *   ③ 표 무결성 — 칸 이름 중복 0 · 주인 3종만 · 정규화 이름이 실재 · 인트라넷 고유 칸(D5) 고정 · 목록 밖 칸은 던진다
 *   ④ 투입방식 정규화 = 접수 저장 규칙(order.routes `_productDistributionMode`)과 같은 문장
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SHARED_FIELDS, CANON, canon, ownerOf, stableJson } = require('../src/utils/sharedFields');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}
const same = (k, a, b) => assert.strictEqual(canon(k, a), canon(k, b), `${k}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const differ = (k, a, b) => assert.notStrictEqual(canon(k, a), canon(k, b), `${k}: ${JSON.stringify(a)} 와 ${JSON.stringify(b)} 가 같게 접혔다`);

t('① 운영 대조의 표기 차이는 같다로 판정', () => {
  same('skip_weekends', false, '0');       // 인트라넷 false / 리뷰웹 0
  same('skip_weekends', true, 'true');
  same('purchase_channel_custom', false, 0);
  same('product_distribution_mode', '', 'balanced');
  same('product_distribution_mode', undefined, 'BALANCED');
  same('work_kind', '', 'review');
  same('review_type', '포토', 'photo');
  same('review_type', '혼합(포토 3건, 텍스트 2건)', 'mixed');
  same('review_type', '자율리뷰', '');
  same('purchase_time', '13:00 ~ 18:00', '13:00~18:00');
  same('purchase_time', '2시~5시', '14:00 ~ 17:00');
  same('purchase_time', '자유시간대', ' 자유시간대 ');
  same('delivery_type', '빈택배', '빈박스');
  same('review_type_mix', [{ type: 'text', quantity: 2 }, { type: 'photo', quantity: 3 }], '[{"type":"photo","quantity":3},{"type":"text","quantity":2}]');
  same('delivery_type_mix', '[{"type":"real","quantity":0},{"type":"empty","quantity":5}]', [{ type: 'empty', quantity: 5 }]);
  same('guide_images', '[]', '');
  same('holidays', '["2026-10-03"]', ['2026-10-03']);
  same('review_guide', '첫 줄\r\n둘째 줄 ', '첫 줄\n둘째 줄');
  same('review_fee', '1,000', 1000);
  same('start_date', '2026-10-21T00:00:00.000Z', '2026-10-21');
});

t('② 진짜 차이는 다르다로 판정', () => {
  differ('review_fee', 1000, 1500);
  differ('recruit_count', 0, '');             // 0명은 값, 빈 값은 "모름"
  differ('skip_weekends', '', false);          // 미정 vs 포함
  differ('review_type', '포토', '텍스트');
  differ('purchase_time', '13:00 ~ 18:00', '자유시간대');
  differ('delivery_type', '택배발송대행', '빈박스');
  differ('product_url', 'https://a', 'https://b');
  differ('review_type_mix', '[{"type":"photo","quantity":3}]', '[{"type":"photo","quantity":4}]');
  differ('work_kind', 'blog', '');
});

t('③ 표 무결성', () => {
  const keys = SHARED_FIELDS.map(f => f.key);
  assert.strictEqual(new Set(keys).size, keys.length, '칸 이름 중복');
  for (const f of SHARED_FIELDS) {
    assert.ok(['intranet', 'shared', 'derived'].includes(f.owner), f.key);
    assert.strictEqual(typeof CANON[f.canon], 'function', `${f.key} 정규화 ${f.canon} 없음`);
    assert.ok(f.label, `${f.key} 라벨`);
  }
  for (const k of ['title', 'start_date', 'manager_name', 'work_manager', 'sales_id', 'intranet_advertiser_id']) {
    assert.strictEqual(ownerOf(k), 'intranet', `${k} 는 인트라넷 고유(사용자 확정 D5·리뷰오더 고유항목)`);
  }
  for (const k of ['review_fee', 'recruit_count', 'product_url', 'purchase_time', 'skip_weekends', 'required_delivery_memo']) {
    assert.strictEqual(ownerOf(k), 'shared', `${k} 는 양방향(사용자 확정)`);
  }
  assert.strictEqual(ownerOf('pay_amount'), 'derived', '결제금액 합계는 파생 — 직접 쓰지 않는다');
  assert.strictEqual(ownerOf('linked_campaign_id'), null);
  assert.throws(() => canon('linked_campaign_id', 'x'), /목록에 없는 칸/);
});

t('④ 투입방식 정규화 = 접수 저장 규칙', () => {
  const ROUTE = fs.readFileSync(path.join(__dirname, '../src/routes/order.routes.js'), 'utf8');
  assert.ok(/function _productDistributionMode\(v\) \{\s*return String\(v == null \? '' : v\)\.trim\(\)\.toLowerCase\(\) === 'sequential' \? 'sequential' : 'balanced';/.test(ROUTE),
    '접수 저장 규칙이 바뀌었다 — sharedFields CANON.distribution 도 함께 맞출 것');
});

t('⑤ stableJson — 키 순서 무시, 배열 순서는 유지', () => {
  assert.strictEqual(stableJson({ b: 1, a: [2, 1] }), stableJson({ a: [2, 1], b: 1 }));
  assert.notStrictEqual(stableJson([1, 2]), stableJson([2, 1]));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
