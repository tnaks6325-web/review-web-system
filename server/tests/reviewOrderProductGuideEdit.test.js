'use strict';
/**
 * 회귀가드 — 접수된 작업오더도 "상품 주소·선택지별 유입가이드"는 원본에서 고칠 수 있다
 * (사용자 확정 2026-09-21 · 1단계).
 *
 * 실행: node tests/reviewOrderProductGuideEdit.test.js
 *
 * ★★ 배경(실측 재현): 인트라넷은 **상품 주소와 선택지별 유입가이드**를 `product_options_json`
 *   한 덩어리에 담아 보낸다. 유입방식이 '유입가이드'면 유입 안내가 **그 안에만** 있다
 *   (inadd-webapp `reviewOrderBuildInflowGuide` 가 그때 undefined 를 돌려준다).
 *   그래서 그 칸을 통째로 잠갔더니, 409 문구가 "상품 주소·유입 가이드·첨부 이미지는 여기서
 *   바꿀 수 있습니다" 라고 안내하면서 **정작 그것을 고치면 막았다** — 지킬 수 없는 약속.
 *
 * ★ 이 가드가 지키는 것:
 *   ① 허용 키(url·guide)만 바뀐 요청은 통과하고 **그 칸이 실제로 저장된다**
 *   ② 금액·인원·일건수·옵션값·상품명이 바뀌면 여전히 409 — 쓰기 0건
 *   ③ 허용 키를 넓히지 않는다(url·guide 둘뿐)
 *   ④ 막을지 판정과 저장할지 판정이 **같은 함수**를 본다(갈리면 조용한 무동작)
 *   ⑤ 못 읽는 값은 잠금(fail-closed)
 *   ⑥ 정원 검증·작업표 동기화는 여전히 호출 0 · 잠기지 않은 오더는 종전 경로
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ORDER_INTAKE_KEY = 'test-intake-key';

const pool = require(path.join(ROOT, 'src/db/pool.js'));
const quotaService = require(path.join(ROOT, 'src/services/linkedRecruitQuota.service.js'));

const calls = { quota: 0, sync: 0 };
quotaService.assertWorkOrderQuota = async () => { calls.quota += 1; return null; };
quotaService.syncWorkOrderRecruitTotal = async () => { calls.sync += 1; return null; };

const orderRouter = require(path.join(ROOT, 'src/routes/order.routes.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'src/routes/order.routes.js'), 'utf8');

const layer = (orderRouter.stack || []).find(l =>
  l.route && l.route.path === '/intake/source/:sourceReviewOrderId' && l.route.methods.put);
assert.ok(layer, 'PUT /intake/source/:sourceReviewOrderId 라우트 없음');
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

/* 실제 인트라넷 payload 모양(옵션 없는 작업) — 유입가이드가 상품 안 guide 로만 온다. */
function optsNone(over = {}) {
  return JSON.stringify([Object.assign({
    name: '곰도리 부착형 하루종일 장시간 고급형 핫팩, 50개',
    url: 'https://link.coupang.com/a/AAA',
    option_schema_version: 2,
    product_mode: 'none',
    guide: '유입 경로, 검색어, 진입 순서를 적어주세요',
    base: { pay: 9190, count: 470, daily: 30, review_type_mix: [] },
    options: [],
  }, over)]);
}

/* 옵션 있는 작업 — 옵션 레벨에도 url·guide 가 있다. */
function optsWith(over = {}) {
  return JSON.stringify([{
    name: '핫팩 세트',
    url: 'https://link.coupang.com/a/BBB',
    option_schema_version: 2,
    product_mode: 'opt',
    base: { pay: 0, count: 0, daily: 0, review_type_mix: [] },
    options: [Object.assign({
      option_1: { name: '색상', value: '레드' },
      label: '레드',
      url: 'https://link.coupang.com/a/RED',
      guide: '레드 선택 후 구매',
      pay: 9190, count: 235, daily: 15, review_type_mix: [],
    }, over)],
  }]);
}

const BODY = {
  intakeKey: 'test-intake-key',
  source_review_order_id: 'ro_pg1', source_revision: 2, idempotency_key: 'ro_pg1:2',
  title: '9/9(쿠팡)자나베어_핫팩 50개_470건', start_date: '2026-09-09',
  manager_name: '김수만', work_manager: '박세희',
  product_option: '', product_options_json: optsNone(),
  pay_amount: 9190, review_fee: 0, daily_count: 30, daily_count_text: '30',
  product_distribution_mode: 'balanced',
  purchase_channel: '쿠팡', purchase_time: '13:00 ~ 18:00',
  inflow_keyword: '', inflow_type: 'guide', inflow_guide: '',
  delivery_type: '실배송', review_type: '포토', recruit_count: 470,
  review_guide: '상품에 맞게 자연스럽게 진행', special_notes: '',
  product_url: 'https://link.coupang.com/a/AAA', work_sheet_url: '',
  goods_cost_type: '계산서', work_kind: 'review',
  sales_id: 'sales-1', contract_number: 'C-1', quote_id: 'q-1',
  intranet_advertiser_id: 'adv-1', intranet_advertiser_name: '자나베어',
  intranet_advertiser_contact: '010-0000-0000', intranet_advertiser_business_number: '000-00-00000',
};

/* 접수돼 잠긴 오더 — 작업 내용은 BODY 와 같다. */
function baseOrder(extra) {
  return Object.assign({
    id: 'wo_1', source_review_order_id: 'ro_pg1', source_revision: 1,
    intake_idempotency_key: 'ro_pg1:1', status: 'reviewing', deleted_at: null,
    linked_campaign_id: null, advertiser_id: 'adv_local_1',   // ← 접수 완료(잠금 조건)
    title: BODY.title, start_date: new Date(2026, 8, 9),
    manager_name: BODY.manager_name, work_manager: '박세희',
    product_option: '', product_options_json: optsNone(),
    product_distribution_mode: 'balanced',
    pay_amount: 9190, review_fee: 0, daily_count: 30, daily_count_text: '30',
    purchase_channel: '쿠팡', purchase_time: '13:00 ~ 18:00',
    inflow_keyword: '', inflow_type: 'guide', inflow_guide: '', guide_images: '',
    delivery_type: '실배송', courier_proxy: false, review_type: '포토',
    review_type_mix: [], recruit_count: 470, review_guide: BODY.review_guide,
    special_notes: '', product_url: BODY.product_url, work_sheet_url: '',
    goods_cost_type: '계산서', skip_weekends: null, holidays: null,
    work_kind: 'review', sales_id: 'sales-1', contract_number: 'C-1', quote_id: 'q-1',
  }, extra || {});
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
}

async function call(order, body) {
  const queries = [];
  pool.query = async (sql, params) => {
    const s = String(sql);
    queries.push({ sql: s, params });
    if (/SELECT \* FROM work_orders WHERE source_review_order_id/.test(s)) return { rows: [Object.assign({}, order)] };
    if (/UPDATE work_orders SET/.test(s)) return { rows: [Object.assign({}, order, { source_revision: 2 })] };
    return { rows: [] };
  };
  calls.quota = 0; calls.sync = 0;
  const res = makeRes();
  await handler({ body, params: { sourceReviewOrderId: body.source_review_order_id }, headers: {} }, res,
    err => { throw err; });
  return { res, queries, updates: queries.filter(q => /UPDATE work_orders SET/.test(q.sql)) };
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}

async function run() {
  console.log('\n접수 후 원본 수정 — 상품 구성 안의 주소·유입가이드는 고칠 수 있다');

  await t('① 선택지별 유입가이드만 고치면 통과하고 실제로 저장된다', async () => {
    const next = optsNone({ guide: '검색어를 바꿨습니다 — 유입가이드 수정' });
    const { res, updates } = await call(baseOrder(), Object.assign({}, BODY, { product_options_json: next }));
    assert.strictEqual(res.statusCode, 200, 'status=' + res.statusCode + ' body=' + JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.edited_fields, ['product_options_json']);
    assert.strictEqual(res.body.contract_only, false);
    assert.strictEqual(updates.length, 1, '저장이 일어나지 않았다');
    assert.ok(/product_options_json = \$/.test(updates[0].sql),
      '통과는 했는데 그 칸을 안 쓴다 — 저장했다고 답하면서 값을 버린다: ' + updates[0].sql);
    assert.ok(updates[0].params.includes(next), '저장된 값이 새 값이 아니다');
  });

  await t('① 상품 주소만 고치면 통과하고 실제로 저장된다', async () => {
    const next = optsNone({ url: 'https://link.coupang.com/a/NEW' });
    const { res, updates } = await call(baseOrder(), Object.assign({}, BODY, {
      product_url: 'https://link.coupang.com/a/NEW', product_options_json: next,
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(res.body.edited_fields.includes('product_options_json'));
    assert.ok(res.body.edited_fields.includes('product_url'));
    assert.ok(/product_options_json = \$/.test(updates[0].sql));
  });

  await t('① 옵션 있는 작업도 옵션별 주소·가이드는 고칠 수 있다', async () => {
    const order = baseOrder({ product_options_json: optsWith() });
    const next = optsWith({
      option_1: { name: '색상', value: '레드' }, label: '레드',
      url: 'https://link.coupang.com/a/RED2', guide: '레드 가이드 수정',
      pay: 9190, count: 235, daily: 15, review_type_mix: [],
    });
    const { res, updates } = await call(order, Object.assign({}, BODY, { product_options_json: next }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(/product_options_json = \$/.test(updates[0].sql));
  });

  const LOCKED = {
    '결제금액': optsNone({ base: { pay: 12000, count: 470, daily: 30, review_type_mix: [] } }),
    '모집인원': optsNone({ base: { pay: 9190, count: 500, daily: 30, review_type_mix: [] } }),
    '일건수': optsNone({ base: { pay: 9190, count: 470, daily: 50, review_type_mix: [] } }),
    '상품명': optsNone({ name: '다른 상품명' }),
    '옵션 유무': optsNone({
      product_mode: 'opt',
      options: [{ option_1: { name: '색상', value: '레드' }, label: '레드', url: '', guide: '',
        pay: 9190, count: 470, daily: 30, review_type_mix: [] }],
    }),
  };
  for (const [label, next] of Object.entries(LOCKED)) {
    await t(`② 상품 구성 안의 ${label}이(가) 바뀌면 여전히 막는다 — 쓰기 0건`, async () => {
      const { res, updates } = await call(baseOrder(), Object.assign({}, BODY, { product_options_json: next }));
      assert.strictEqual(res.statusCode, 409, '조용히 통과했다: ' + JSON.stringify(res.body));
      assert.ok(res.body.blocked_fields.includes('product_options_json'), JSON.stringify(res.body.blocked_fields));
      assert.strictEqual(updates.length, 0, '거부인데 쓰기가 일어났다');
    });
  }

  await t('② 옵션값(선택지 이름)이 바뀌면 막는다 — 표의 옵션 칸에 박히는 값', async () => {
    const order = baseOrder({ product_options_json: optsWith() });
    const next = optsWith({
      option_1: { name: '색상', value: '블루' }, label: '블루',
      url: 'https://link.coupang.com/a/RED', guide: '레드 선택 후 구매',
      pay: 9190, count: 235, daily: 15, review_type_mix: [],
    });
    const { res, updates } = await call(order, Object.assign({}, BODY, { product_options_json: next }));
    assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
    assert.strictEqual(updates.length, 0);
  });

  await t('② 허용 키와 잠긴 키가 섞이면 요청 전체를 거부한다(절반 저장 금지)', async () => {
    const next = optsNone({ guide: '가이드도 고치고', base: { pay: 12000, count: 470, daily: 30, review_type_mix: [] } });
    const { res, updates } = await call(baseOrder(), Object.assign({}, BODY, { product_options_json: next }));
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(updates.length, 0, '절반만 저장됐다');
  });

  await t('② 409 문구는 무엇을 되돌려야 하는지 말한다(코드명 노출 0)', async () => {
    const { res } = await call(baseOrder(), Object.assign({}, BODY, { product_options_json: LOCKED['결제금액'] }));
    assert.match(res.body.error, /상품 구성/);
    assert.match(res.body.error, /금액|인원|옵션/, '무엇이 잠긴 부분인지 말해야 한다: ' + res.body.error);
    assert.ok(!/product_options_json/.test(res.body.error), '코드명이 샜다: ' + res.body.error);
  });

  await t('③ 고칠 수 있는 키를 넓히지 않는다(url·guide 둘뿐)', async () => {
    const line = SRC.match(/const PRODUCT_OPTION_EDITABLE_KEYS = new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(line, 'PRODUCT_OPTION_EDITABLE_KEYS 선언 없음');
    const listed = (line[1].match(/'([a-z_0-9]+)'/g) || []).map(v => v.replace(/'/g, ''));
    assert.deepStrictEqual(listed.slice().sort(), ['guide', 'url'],
      '고칠 수 있는 키가 달라졌다 — 상품명·금액·인원·옵션값은 표에 박히는 값이라 잠긴 채로 둔다');
  });

  await t('④ 막을지 판정과 저장할지 판정이 같은 함수를 본다', async () => {
    const from = SRC.indexOf('const blockedChanges = contentChanges.filter');
    assert.ok(from > 0, '차단 판정을 못 찾았다');
    assert.ok(/_sourceEditAllowedAfterAccept\(column/.test(SRC.slice(from, from + 220)),
      '차단 판정이 공용 허용 판정을 안 쓴다');
    const editFrom = SRC.indexOf('const editable = contentChanges');
    assert.ok(editFrom > 0, '저장 대상 선정을 못 찾았다');
    assert.ok(/_sourceEditAllowedAfterAccept\(column/.test(SRC.slice(editFrom, editFrom + 220)),
      '저장 대상 선정이 공용 허용 판정을 안 쓴다 — 갈리면 조용한 무동작이 된다');
  });

  await t('⑤ 못 읽는 값은 잠금(fail-closed)', async () => {
    const { res, updates } = await call(baseOrder({ product_options_json: '{깨진 값' }),
      Object.assign({}, BODY, { product_options_json: optsNone({ guide: '가이드만 수정' }) }));
    assert.strictEqual(res.statusCode, 409, '못 읽는 값을 통과시켰다: ' + JSON.stringify(res.body));
    assert.strictEqual(updates.length, 0);
  });

  await t('⑤ 상품 구성이 새로 생기면(빈 값 → 구조) 잠금', async () => {
    const { res, updates } = await call(baseOrder({ product_options_json: '' }), BODY);
    assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
    assert.strictEqual(updates.length, 0);
  });

  await t('⑥ 이 경로는 정원 검증·작업표 동기화를 건드리지 않는다', async () => {
    await call(baseOrder(), Object.assign({}, BODY, {
      product_options_json: optsNone({ guide: '가이드만 수정' }),
    }));
    assert.strictEqual(calls.quota, 0, 'assertWorkOrderQuota 가 호출됐다');
    assert.strictEqual(calls.sync, 0, 'syncWorkOrderRecruitTotal 이 호출됐다');
  });

  await t('⑥ 값이 그대로면 종전대로 계약 전용 통과(무회귀)', async () => {
    const { res } = await call(baseOrder({ sales_id: '', contract_number: '', quote_id: '' }), BODY);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.contract_only, true);
    assert.deepStrictEqual(res.body.edited_fields, []);
  });

  await t('⑥ 잠기지 않은 오더는 종전 전체 수정 경로 그대로', async () => {
    const { res, updates } = await call(baseOrder({ advertiser_id: null, linked_campaign_id: null }),
      Object.assign({}, BODY, { product_options_json: LOCKED['결제금액'] }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(/recruit_count = \$/.test(updates[0].sql), '전체 수정 경로가 아니다');
    assert.strictEqual(calls.quota, 1, '전체 경로는 정원 검증을 한다');
  });

  await t('⑥ 삭제된 오더는 주소·가이드도 못 고친다(예외 없음)', async () => {
    const { res, updates } = await call(baseOrder({ deleted_at: new Date() }),
      Object.assign({}, BODY, { product_options_json: optsNone({ guide: '가이드만 수정' }) }));
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(updates.length, 0);
  });

  console.log(`\nreviewOrderProductGuideEdit: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
