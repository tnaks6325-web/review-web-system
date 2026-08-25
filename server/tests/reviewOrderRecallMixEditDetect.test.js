'use strict';
/**
 * 회귀가드 — 회수·혼합 부속정보가 조용히 사라지지 않는다 (2026-08-25).
 *
 * 실행: node tests/reviewOrderRecallMixEditDetect.test.js
 *
 * ★ 배경: 135 로 들어온 세 칸(`delivery_type_mix`·`recall_courier`·`recall_product`)이
 *   **바뀐 칸 판정 목록(`_sourceContentNextValues`)에서 빠져 있었다**. 그래서 접수된 오더에서
 *   그 칸만 고치면 리뷰웹이 "바뀐 게 없다"로 읽어 **계약 전용 저장으로 흘려보내고**,
 *   그 값은 어디에도 안 쓰인 채 **200 ok 로 응답**했다 — 담당자는 반영된 줄 안다.
 *
 * ★ 이 가드가 지키는 것:
 *   ① 그 세 칸이 바뀌면 **감지**되고, 잠긴 칸이므로 409 + 사람이 읽는 이름을 알려준다(쓰기 0건)
 *   ② 접수 뒤 허용 목록에는 넣지 않는다 — 작업표의 열 구성·줄마다 채우는 값을 정하는 칸이다
 *   ③ **보내지 않은 요청은 비교하지 않는다** — 이 칸을 안 보내던 옛 인트라넷의 계약 후속
 *      매칭이 새로 막히면 안 된다(2026-08-20 실장애와 같은 자리)
 *   ④ 값이 같으면 종전대로 계약 전용 통과
 *   ⑤ 잠기지 않은 오더는 종전 전체 저장 경로 그대로(그 경로는 이미 세 칸을 쓴다)
 *   ⑥ **드리프트 가드** — 전체 저장이 쓰는 내용 칸 ≡ 바뀐 칸 판정 목록. 앞으로 칸이 늘 때
 *      또 한쪽에만 들어가 조용히 사라지는 일을 막는다.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ORDER_INTAKE_KEY = 'test-intake-key';

const pool = require(path.join(ROOT, 'src/db/pool.js'));
const quotaService = require(path.join(ROOT, 'src/services/linkedRecruitQuota.service.js'));
const { pickWorkManager } = require(path.join(ROOT, 'src/utils/workManager.js'));
const { workKindForStore } = require(path.join(ROOT, 'src/utils/workKind.js'));

const calls = { quota: 0, sync: 0 };
quotaService.assertWorkOrderQuota = async () => { calls.quota += 1; return null; };
quotaService.syncWorkOrderRecruitTotal = async () => { calls.sync += 1; return null; };

const orderRouter = require(path.join(ROOT, 'src/routes/order.routes.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'src/routes/order.routes.js'), 'utf8');

const layer = (orderRouter.stack || []).find(l =>
  l.route && l.route.path === '/intake/source/:sourceReviewOrderId' && l.route.methods.put);
assert.ok(layer, 'PUT /intake/source/:sourceReviewOrderId 라우트 없음');
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

const MIX = [{ type: '실배송', quantity: 20 }, { type: '빈박스', quantity: 80 }];

const BODY = {
  intakeKey: 'test-intake-key',
  source_review_order_id: 'ro_abc123', source_revision: 2, idempotency_key: 'ro_abc123:2',
  title: '8/25(네이버)회수 테스트 100건', start_date: '2026-08-25',
  manager_name: '김수만', work_manager: '박세희',
  product_option: '단품', pay_amount: 29000, review_fee: 0,
  daily_count: 10, daily_count_text: '10', purchase_channel: '네이버',
  purchase_time: '09:00 ~ 18:00', inflow_keyword: '회수', inflow_type: '검색',
  inflow_guide: '검색 후 구매', delivery_type: '회수', review_type: '포토',
  recruit_count: 100, review_guide: '사용 후 작성', special_notes: '',
  product_url: 'https://smartstore.naver.com/x', work_sheet_url: '',
  goods_cost_type: '계산서', work_kind: '리뷰체험단',
  recall_courier: 'CJ대한통운', recall_product: 'OO선크림 30ml',
  sales_id: 'sales-1', contract_number: 'C-1', quote_id: 'q-1',
  intranet_advertiser_id: 'adv-1', intranet_advertiser_name: '주식회사 어니스트캄',
  intranet_advertiser_contact: '010-0000-0000', intranet_advertiser_business_number: '000-00-00000',
};

// 접수돼 잠긴 오더 — 작업 내용은 BODY 와 같다.
function baseOrder(extra) {
  return Object.assign({
    id: 'wo_1', source_review_order_id: 'ro_abc123', source_revision: 1,
    intake_idempotency_key: 'ro_abc123:1', status: 'reviewing', deleted_at: null,
    linked_campaign_id: null, advertiser_id: 'adv_local_1',   // ← 접수 완료(잠금 조건)
    title: BODY.title, start_date: new Date(2026, 7, 25),
    manager_name: BODY.manager_name, work_manager: pickWorkManager(BODY),
    product_option: BODY.product_option, product_options_json: '',
    pay_amount: BODY.pay_amount, review_fee: 0, daily_count: BODY.daily_count,
    daily_count_text: BODY.daily_count_text, purchase_channel: BODY.purchase_channel,
    purchase_time: BODY.purchase_time, inflow_keyword: BODY.inflow_keyword,
    inflow_type: BODY.inflow_type, inflow_guide: BODY.inflow_guide, guide_images: '',
    delivery_type: '회수', courier_proxy: false, review_type: BODY.review_type,
    review_type_mix: [], recruit_count: BODY.recruit_count, review_guide: BODY.review_guide,
    special_notes: '', product_url: BODY.product_url, work_sheet_url: '',
    goods_cost_type: BODY.goods_cost_type, skip_weekends: null, holidays: null,
    work_kind: workKindForStore(BODY.work_kind),
    // 135 — 저장소 기본값은 NULL 이 아니라 '[]' / '' 다(마이그레이션 NOT NULL DEFAULT).
    delivery_type_mix: [], recall_courier: BODY.recall_courier, recall_product: BODY.recall_product,
    sales_id: BODY.sales_id, contract_number: BODY.contract_number, quote_id: BODY.quote_id,
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

const MIXBODY = Object.assign({}, BODY, {
  delivery_type: '혼합', recall_courier: undefined, recall_product: undefined,
  delivery_type_mix: MIX,
});
function mixOrder(extra) {
  return baseOrder(Object.assign({
    delivery_type: '혼합', recall_courier: '', recall_product: '', delivery_type_mix: MIX,
  }, extra || {}));
}
const drop = (body, ...keys) => {
  const out = Object.assign({}, body);
  keys.forEach(k => { delete out[k]; });
  return out;
};

async function run() {
  console.log('\n회수·혼합 부속정보 — 조용히 사라지지 않는다');

  await t('① 회수 택배사만 바꾸면 감지해 거부한다(쓰기 0건)', async () => {
    const { res, updates } = await call(baseOrder(), Object.assign({}, BODY, { recall_courier: '한진택배' }));
    assert.strictEqual(res.statusCode, 409, '조용히 통과했다: ' + JSON.stringify(res.body));
    assert.ok(res.body.changed_fields.includes('recall_courier'), '감지 못 함: ' + JSON.stringify(res.body.changed_fields));
    assert.ok(res.body.blocked_fields.includes('recall_courier'));
    assert.strictEqual(updates.length, 0, '거부인데 쓰기가 일어났다');
  });

  await t('① 회수 상품명칭만 바꿔도 감지한다', async () => {
    const { res } = await call(baseOrder(), Object.assign({}, BODY, { recall_product: '다른 상품' }));
    assert.strictEqual(res.statusCode, 409);
    assert.ok(res.body.changed_fields.includes('recall_product'));
  });

  await t('① 실배송·빈박스 건수만 바꿔도 감지한다', async () => {
    const body = Object.assign({}, MIXBODY, {
      delivery_type_mix: [{ type: '실배송', quantity: 50 }, { type: '빈박스', quantity: 50 }],
    });
    const { res, updates } = await call(mixOrder(), body);
    assert.strictEqual(res.statusCode, 409, '조용히 통과했다: ' + JSON.stringify(res.body));
    assert.ok(res.body.changed_fields.includes('delivery_type_mix'));
    assert.strictEqual(updates.length, 0);
  });

  await t('① 409 문구는 사람이 읽는 칸 이름으로 말한다(코드명 노출 0)', async () => {
    const { res } = await call(baseOrder(), Object.assign({}, BODY, { recall_courier: '한진택배' }));
    assert.ok(/회수 택배사/.test(res.body.error), '문구: ' + res.body.error);
    ['recall_courier', 'recall_product', 'delivery_type_mix'].forEach(code =>
      assert.ok(!res.body.error.includes(code), '코드명이 새어 나갔다: ' + code));
    const mix = await call(mixOrder(), Object.assign({}, MIXBODY, {
      delivery_type_mix: [{ type: '실배송', quantity: 1 }],
    }));
    assert.ok(/실배송·빈박스 건수/.test(mix.res.body.error), '문구: ' + mix.res.body.error);
  });

  await t('② 접수 뒤 허용 목록에는 이 세 칸이 없다(작업표 열·줄 값을 정하는 칸)', async () => {
    const line = SRC.match(/const SOURCE_EDIT_AFTER_ACCEPT = \[([\s\S]*?)\];/);
    assert.ok(line, 'SOURCE_EDIT_AFTER_ACCEPT 선언 없음');
    ['delivery_type_mix', 'recall_courier', 'recall_product'].forEach(col =>
      assert.ok(!line[1].includes(col), '허용 목록이 넓어졌다: ' + col));
  });

  await t('③ 그 칸을 보내지 않은 요청은 비교하지 않는다 — 옛 계약 매칭 무회귀', async () => {
    const { res } = await call(baseOrder(), drop(BODY, 'recall_courier', 'recall_product'));
    assert.strictEqual(res.statusCode, 200, '옛 인트라넷의 계약 매칭이 막혔다: ' + JSON.stringify(res.body));
    assert.strictEqual(res.body.contract_only, true);
  });

  await t('③ 혼합 오더도 조합을 안 보내면 계약 매칭이 막히지 않는다', async () => {
    const { res } = await call(mixOrder(), drop(MIXBODY, 'delivery_type_mix'));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.contract_only, true);
  });

  await t('④ 값이 그대로면 종전대로 계약 전용 통과', async () => {
    const { res } = await call(baseOrder(), BODY);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.contract_only, true);
    assert.deepStrictEqual(res.body.edited_fields, []);
  });

  await t('④ 회수가 아닌 오더는 빈 값끼리 비교돼 헛되이 바뀌지 않는다', async () => {
    const plain = baseOrder({ delivery_type: '실배송', recall_courier: '', recall_product: '' });
    const { res } = await call(plain, Object.assign({}, BODY, {
      delivery_type: '실배송', recall_courier: '', recall_product: '',
    }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.contract_only, true);
  });

  await t('④ 허용 칸과 함께 와도 잠긴 칸이 섞였으면 요청 전체를 거부한다', async () => {
    const { res, updates } = await call(baseOrder(),
      Object.assign({}, BODY, { review_guide: '새 가이드', recall_courier: '한진택배' }));
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(updates.length, 0, '절반만 저장됐다');
  });

  await t('⑤ 잠기지 않은 오더는 종전 전체 저장 경로 그대로 세 칸을 쓴다', async () => {
    const open = baseOrder({ advertiser_id: null, linked_campaign_id: null });
    const { res, updates } = await call(open, Object.assign({}, BODY, { recall_courier: '한진택배' }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    ['delivery_type_mix = $', 'recall_courier = $', 'recall_product = $'].forEach(col =>
      assert.ok(updates[0].sql.includes(col), '전체 저장이 그 칸을 안 쓴다: ' + col));
    assert.strictEqual(calls.quota, 1, '전체 경로는 정원 검증을 한다');
  });

  await t('⑤ 부분 수정도 정원 검증·작업표 동기화를 건드리지 않는다', async () => {
    await call(baseOrder(), Object.assign({}, BODY, { review_guide: '새 가이드' }));
    assert.strictEqual(calls.quota, 0);
    assert.strictEqual(calls.sync, 0);
  });

  // ★★ 드리프트 가드 — 이 사고의 재발 방지 본체.
  //   전체 저장 UPDATE 가 쓰는 "내용 칸"과 바뀐 칸 판정 목록이 어긋나면, 어긋난 그 칸은
  //   접수된 오더에서 **소리 없이 버려진다**(판정이 못 보므로 계약 전용으로 흘러간다).
  await t('⑥ 전체 저장이 쓰는 내용 칸 ≡ 바뀐 칸 판정 목록', async () => {
    const from = SRC.indexOf('await assertWorkOrderQuota({ workOrderId: current.id');
    assert.ok(from > 0, '전체 저장 경로를 못 찾았다');
    // ⚠ 끝 표시는 **시작점 뒤에서** 찾는다(파일 앞쪽 같은 문구를 먼저 잡으면 조각이 비어
    //   검사가 조용히 무의미해진다).
    const sql = SRC.slice(from, SRC.indexOf('RETURNING *', from));
    assert.ok(sql.length > 400, '전체 저장 SQL 조각을 못 잘랐다');
    // ⚠ WHERE 절(`id = $1 AND source_review_order_id = $40`)은 쓰는 칸이 아니다 — SET 만 본다.
    const setPart = sql.slice(0, sql.indexOf('WHERE id ='));
    assert.ok(setPart.length > 400, 'SET 절을 못 잘랐다');
    const written = new Set((setPart.match(/(\w+) = \$\d+/g) || []).map(m => m.split(' ')[0]));

    const fnStart = SRC.indexOf('function _sourceContentNextValues(');
    const fnBody = SRC.slice(fnStart, SRC.indexOf('\n}', fnStart));
    assert.ok(fnBody.length > 400, '판정 목록 조각을 못 잘랐다');
    const judged = new Set((fnBody.match(/^\s{4}(?:\.\.\.\([^\n]*\{ )?(\w+):/gm) || [])
      .map(m => m.trim().replace(/^\.\.\.\(.*\{ /, '').replace(':', '')));

    // 내용이 아니라 "누가 언제 보냈나"를 적는 칸 — 판정 대상이 아니다.
    const BOOKKEEPING = new Set(['sales_id', 'contract_number', 'quote_id', 'source_revision',
      'intake_idempotency_key', 'intranet_advertiser_id', 'intranet_advertiser_name',
      'intranet_advertiser_contact', 'intranet_advertiser_business_number', 'updated_at']);
    const missing = [...written].filter(c => !BOOKKEEPING.has(c) && !judged.has(c));
    assert.deepStrictEqual(missing, [],
      '전체 저장은 쓰는데 판정이 못 보는 칸 — 접수된 오더에서 소리 없이 버려진다: ' + missing.join(', '));
  });

  await t('⑥ 세 칸은 "보냈을 때만" 판정에 넣는다(형태 고정)', async () => {
    const fnStart = SRC.indexOf('function _sourceContentNextValues(');
    const fnBody = SRC.slice(fnStart, SRC.indexOf('\n}', fnStart));
    ['delivery_type_mix', 'recall_courier', 'recall_product'].forEach(col =>
      assert.ok(new RegExp('b\\.' + col + ' === undefined \\? \\{\\} :').test(fnBody),
        '미전송 예외가 사라졌다 — 옛 계약 매칭이 막힌다: ' + col));
  });

  await t('⑥ 사람이 읽는 이름표가 세 칸 모두에 있다', async () => {
    const map = SRC.match(/const SOURCE_FIELD_LABELS = \{([\s\S]*?)\n\};/);
    assert.ok(map, 'SOURCE_FIELD_LABELS 선언 없음');
    ['delivery_type_mix', 'recall_courier', 'recall_product'].forEach(col =>
      assert.ok(new RegExp(col + ':').test(map[1]), '이름표 없음(409 에 코드명이 샌다): ' + col));
  });

  console.log(`\nreviewOrderRecallMixEditDetect: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
