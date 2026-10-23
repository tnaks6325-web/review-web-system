'use strict';
/**
 * 회귀가드 — 양방향 대조 보고서·오더→공고 비교 (결정 274 · 읽기 전용)
 *
 * 실행: node tests/sharedDriftReport.test.js
 *
 * ★ 지키는 것:
 *   ① 쓰기 0 — 보고서는 SELECT 한 번만 보낸다(스텁 pool 이 받은 문장 전부 검사)
 *   ② 마감(보관) 공고는 비교하지 않고 `excluded_archived` 로만 센다(사용자 확정 2026-10-20 「마감된건 빼」)
 *   ③ 같은 값을 다르게 저장한 것은 같다 — 상품 단위 줄의 opt_key=상품명 · 가이드 HTML 문자 참조 · 직접입력 채널 ·
 *      오더 날짜(Date) 직렬화 — 2026-10-20 운영 대조 실측 사례
 *   ④ 진짜 차이는 diff — 리뷰비 1000 vs 1500 · 옵션 금액 · 이름이 바뀐 옵션(같은 수면 순서대로 짝, 이름 칸 diff)
 *   ⑤ 오더가 비고 공고만 값이 있으면 fill(충돌 아님) — 썸네일 자동수집
 *   ⑥ 읽기 전용 스크립트는 읽기 전용 트랜잭션에서만 돈다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildSharedDriftReport } = require('../src/services/sharedDriftReport.service');
const { compareOrderCampaign } = require('../src/utils/orderToCampaignProjection');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}

const P = (v) => JSON.stringify(v);
const order = (extra = {}) => ({
  id: 'wo_1', source_review_order_id: 'ro_1', title: '작업', purchase_time: '13:00 ~ 18:00', review_fee: 1000,
  recruit_count: 10, daily_count: 5, delivery_type: '실배송', review_type: '포토', work_kind: '', skip_weekends: false,
  product_url: 'https://www.coupang.com/vp/products/1', inflow_type: 'link', start_date: new Date('2026-10-21T00:00:00Z'),
  product_options_json: P([{ name: '상품A', product_mode: 'none', url: 'https://www.coupang.com/vp/products/1',
    base: { pay: 9000, count: 10, daily: 5, guide: { text: '"크레" 상품' } }, options: [] }]),
  ...extra,
});
const camp = (extra = {}) => ({
  id: 'camp_1', archived_at: null, time_range: '13:00 ~ 18:00', review_fee: 1000, recruit_total: 10, daily_limit: 5,
  delivery_type: '실배송', review_type: 'photo', work_kind: 'review', skip_weekends: false, channel: '쿠팡', channel_custom: '',
  landing_url: 'https://www.coupang.com/vp/products/1', thumbnail_url: '', delivery_type_mix: null, review_type_mix: [],
  recall_courier: '', recall_product: '', ...extra,
});
const optRow = (extra = {}) => ({
  product_name: '상품A', opt_key: '상품A', unit_kind: 'product', option_url: 'https://www.coupang.com/vp/products/1',
  pay_amount: 9000, recruit_total: 10, daily_limit: 5, review_type_mix: [], inflow_guide_html: '"크레" 상품', inflow_guide_images: [],
  status: 'active', ...extra,
});

(async () => {
  await t('③ 같은 값을 다르게 저장한 것은 같다(상품 단위 줄 열쇠 · HTML 문자 참조 · Date)', () => {
    const d = compareOrderCampaign(order(), camp(), [optRow()]);
    assert.deepStrictEqual(d, [], JSON.stringify(d));
  });

  await t('③-1 직접입력 채널은 직접입력 글자로 비교', () => {
    const d = compareOrderCampaign(order({ purchase_channel: '네이버 5건 / 오늘의집 20건' }),
      camp({ channel: '직접입력', channel_custom: '네이버 5건 / 오늘의집 20건' }), [optRow()]);
    assert.deepStrictEqual(d.filter(x => x.field === 'channel'), []);
  });

  await t('④ 리뷰비 1000 vs 1500 은 diff', () => {
    const d = compareOrderCampaign(order(), camp({ review_fee: 1500 }), [optRow()]);
    assert.deepStrictEqual(d.map(x => [x.field, x.kind, x.order, x.campaign]), [['review_fee', 'diff', '1000', '1500']]);
  });

  await t('④-1 옵션 금액 diff · 이름이 바뀐 줄은 같은 수면 순서대로 짝지어 이름 diff', () => {
    const d = compareOrderCampaign(order(), camp(), [optRow({ product_name: '1번 상품A', opt_key: '1번 상품A', pay_amount: 9500 })]);
    const fields = d.map(x => x.field);
    assert.ok(fields.includes('option:상품A.name'), JSON.stringify(d));
    assert.ok(fields.includes('option:상품A.pay_amount'), JSON.stringify(d));
    assert.ok(!fields.some(f => /^option:[^.]*$/.test(f)), '"있음/없음" 두 줄로 갈리지 않는다');
  });

  await t('④-2 남은 줄 수가 다르면 짝을 추측하지 않는다(있음/없음으로 보고)', () => {
    const d = compareOrderCampaign(order(), camp(), [optRow({ product_name: 'X', opt_key: 'X' }), optRow({ product_name: 'Y', opt_key: 'Y' })]);
    assert.ok(d.some(x => x.field === 'option:상품A' && x.campaign === 'missing'));
    assert.strictEqual(d.filter(x => x.order === 'missing').length, 2);
  });

  await t('⑤ 오더가 비고 공고만 값이 있으면 fill', () => {
    const d = compareOrderCampaign(order(), camp({ thumbnail_url: 'https://thumbnail.coupangcdn.com/a.jpg' }), [optRow()]);
    assert.deepStrictEqual(d.map(x => [x.field, x.kind]), [['thumbnail_url', 'fill']]);
  });

  await t('⑤-1 공고에 옵션 줄이 없으면(공고 하나로 도는 작업) 옵션 비교를 하지 않는다', () => {
    assert.deepStrictEqual(compareOrderCampaign(order(), camp(), []), []);
  });

  await t('① ② 보고서 — 쓰기 0 · 마감 공고 제외 · 공고 없음 · 칸별 집계', async () => {
    const seen = [];
    const db = { query: async (sql) => {
      seen.push(String(sql));
      return { rows: [
        { ...order(), _campaign: camp(), _options: [optRow()] },
        { ...order({ id: 'wo_2', source_review_order_id: 'ro_2' }), _campaign: camp({ id: 'camp_2', review_fee: 1500 }), _options: [optRow()] },
        { ...order({ id: 'wo_3', source_review_order_id: 'ro_3' }), _campaign: camp({ id: 'camp_3', archived_at: '2026-10-01T00:00:00Z', review_fee: 9999 }), _options: [] },
        { ...order({ id: 'wo_4', source_review_order_id: 'ro_4' }), _campaign: null, _options: null },
      ] };
    } };
    const r = await buildSharedDriftReport(db);
    assert.strictEqual(seen.length, 1, '쿼리는 한 번');
    assert.ok(/^\s*SELECT\b/i.test(seen[0]) && !/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|LOCK)\b|FOR UPDATE/i.test(seen[0]), '읽기만');
    assert.deepStrictEqual(r.counts, { same: 1, diff: 1, excluded_archived: 1, no_campaign: 1 });
    assert.strictEqual(r.rows.find(x => x.workOrderId === 'wo_3').diffs.length, 0, '마감 공고는 비교 자체를 하지 않는다');
    assert.deepStrictEqual(r.fieldCounts, { review_fee: 1 });
  });

  await t('⑥ 스크립트는 읽기 전용 트랜잭션에서만 돈다', () => {
    const s = fs.readFileSync(path.join(__dirname, '../scripts/shared-drift-report.js'), 'utf8');
    assert.ok(s.includes("SET default_transaction_read_only = on"));
    assert.ok(s.includes("BEGIN READ ONLY"));
    assert.ok(s.indexOf('BEGIN READ ONLY') < s.indexOf('buildSharedDriftReport(client)'));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
