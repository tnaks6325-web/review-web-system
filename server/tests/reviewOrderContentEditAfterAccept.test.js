'use strict';
/**
 * 회귀가드 — 접수된 작업오더도 "안내 문구·사진·이름"은 원본에서 고칠 수 있다
 * (사용자 확정 2026-08-25).
 *
 * 실행: node tests/reviewOrderContentEditAfterAccept.test.js
 *
 * ★ 배경: 접수(광고주 확정)·게시가 끝나면 원본 수정이 **전부** 409 로 막혀, 가이드 오타
 *   하나를 고치려 해도 인트라넷에는 저장되고 리뷰웹에는 안 붙는 어긋남만 쌓였다.
 *
 * ★ 이 가드가 지키는 것:
 *   ① 허용 칸만 바뀐 요청은 통과하고 **그 칸만** UPDATE 된다
 *   ② 잠긴 칸이 하나라도 섞이면 409 — 쓰기 0건, 사람이 읽는 칸 이름을 알려준다
 *   ③ 허용 목록을 넓히지 않는다(정원·일정·열 구성·금액·시트는 잠긴 채로)
 *   ④ 값 계산은 전체 수정 경로와 같은 함수(_sourceContentNextValues) 하나에서 나온다
 *   ⑤ 부분 수정도 정원 검증·작업표 동기화를 건드리지 않는다(접수 상태 보존)
 *   ⑥ 삭제된 오더·계약 후속 매칭·잠기지 않은 오더는 종전 그대로
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

const BODY = {
  intakeKey: 'test-intake-key',
  source_review_order_id: 'ro_abc123', source_revision: 2, idempotency_key: 'ro_abc123:2',
  title: '8/19(네이버)좋은상황 상황버섯진액 10포 300건 실배송',
  start_date: '2026-08-19', manager_name: '김수만', work_manager: '박세희',
  product_option: '10포', pay_amount: 29000, review_fee: 0,
  daily_count: 10, daily_count_text: '10', purchase_channel: '네이버',
  purchase_time: '09:00 ~ 18:00', inflow_keyword: '상황버섯진액', inflow_type: '검색',
  inflow_guide: '검색 후 구매', delivery_type: '실배송', review_type: '포토',
  recruit_count: 300, review_guide: '직접 사용 후 작성', special_notes: '',
  product_url: 'https://smartstore.naver.com/x', work_sheet_url: '',
  goods_cost_type: '계산서', work_kind: '리뷰체험단',
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
    title: BODY.title, start_date: new Date(2026, 7, 19),
    manager_name: BODY.manager_name, work_manager: pickWorkManager(BODY),
    product_option: BODY.product_option, product_options_json: '',
    product_distribution_mode: 'balanced',
    pay_amount: BODY.pay_amount, review_fee: 0, daily_count: BODY.daily_count,
    daily_count_text: BODY.daily_count_text, purchase_channel: BODY.purchase_channel,
    purchase_time: BODY.purchase_time, inflow_keyword: BODY.inflow_keyword,
    inflow_type: BODY.inflow_type, inflow_guide: BODY.inflow_guide, guide_images: '',
    delivery_type: '실배송', courier_proxy: false, review_type: BODY.review_type,
    review_type_mix: [], recruit_count: BODY.recruit_count, review_guide: BODY.review_guide,
    special_notes: '', product_url: BODY.product_url, work_sheet_url: '',
    goods_cost_type: BODY.goods_cost_type, skip_weekends: null, holidays: null,
    work_kind: workKindForStore(BODY.work_kind),
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

const ALLOWED = ['title', 'manager_name', 'product_url', 'inflow_keyword',
  'inflow_guide', 'guide_images', 'review_guide', 'special_notes'];
const BLOCKED_SAMPLES = {
  recruit_count: 500, daily_count: 99, start_date: '2026-12-25', pay_amount: 1,
  review_fee: 1, purchase_channel: '쿠팡', review_type: '텍스트', delivery_type: '빈박스',
  work_sheet_url: 'https://docs.google.com/x', work_kind: '블로그체험단',
  product_option: '20포', purchase_time: '10:00 ~ 11:00',
};

async function run() {
  console.log('\n접수 후 원본 수정 — 안내 문구·사진·이름만 허용');

  await t('① 리뷰 가이드만 고친 요청은 통과한다', async () => {
    const { res } = await call(baseOrder(), Object.assign({}, BODY, { review_guide: '새 리뷰 가이드' }));
    assert.strictEqual(res.statusCode, 200, 'status=' + res.statusCode + ' body=' + JSON.stringify(res.body));
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.contract_only, false, '내용이 바뀌었는데 계약 전용으로 표시됐다');
    assert.deepStrictEqual(res.body.edited_fields, ['review_guide']);
  });

  await t('① 허용 칸 전부를 한 번에 고쳐도 통과한다', async () => {
    const body = Object.assign({}, BODY, {
      title: '새 작업명', manager_name: '박은비', product_url: 'https://x/y',
      inflow_keyword: '새 검색어', inflow_guide: '새 유입 가이드',
      guide_images: ['https://a/b.jpg'], review_guide: '새 리뷰 가이드', special_notes: '새 특이사항',
    });
    const { res } = await call(baseOrder(), body);
    assert.strictEqual(res.statusCode, 200, 'body=' + JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.edited_fields.slice().sort(), ALLOWED.slice().sort());
  });

  await t('① UPDATE 는 바뀐 칸만 쓴다 — 잠긴 칸은 SET 에 없다', async () => {
    const { updates } = await call(baseOrder(), Object.assign({}, BODY, { special_notes: '새 특이사항' }));
    assert.strictEqual(updates.length, 1, 'UPDATE 가 1회여야 한다');
    const sql = updates[0].sql;
    assert.ok(/special_notes = \$/.test(sql), 'special_notes 를 안 쓴다');
    ['recruit_count =', 'start_date =', 'daily_count =', 'pay_amount =', 'work_sheet_url =',
      'review_type =', 'delivery_type =', 'purchase_channel =', 'work_kind =',
      'skip_weekends =', 'holidays =', 'product_options_json ='].forEach(col =>
      assert.ok(!sql.includes(col), '잠긴 칸을 건드림: ' + col));
    // 안 바뀐 허용 칸도 쓰지 않는다(접수 상태 보존)
    assert.ok(!sql.includes('review_guide ='), '안 바뀐 칸까지 쓴다');
  });

  await t('① 저장되는 값은 전체 수정 경로와 같은 함수에서 나온다(사본 0)', async () => {
    const { updates } = await call(baseOrder(), Object.assign({}, BODY, { guide_images: ['https://a/b.jpg'] }));
    const sql = updates[0].sql;
    const idx = Number(sql.match(/guide_images = \$(\d+)/)[1]) - 1;
    assert.strictEqual(updates[0].params[idx], JSON.stringify(['https://a/b.jpg']),
      'guide_images 가 _guideImagesJson 을 안 거쳤다');
    const body = SRC.slice(SRC.indexOf('if (partialEdit) {'), SRC.indexOf('// 원본 리뷰오더의 목표 인원이'));
    assert.ok(body.includes('_sourceContentNextValues(b, { optionsJson, deliveryType, courierProxy })'),
      '부분 수정이 값을 따로 계산한다(사본)');
  });

  for (const [column, value] of Object.entries(BLOCKED_SAMPLES)) {
    await t(`② 잠긴 칸(${column})이 섞이면 409 — 쓰기 0건`, async () => {
      const { res, updates } = await call(baseOrder(), Object.assign({}, BODY, { [column]: value }));
      assert.strictEqual(res.statusCode, 409, 'status=' + res.statusCode);
      assert.strictEqual(updates.length, 0, '거부인데 UPDATE 가 나갔다');
      assert.ok(res.body.blocked_fields.includes(column), 'blocked_fields 에 없다: ' + JSON.stringify(res.body.blocked_fields));
    });
  }

  await t('② 허용 칸과 잠긴 칸이 함께 바뀌면 통째로 거부한다(반쪽 저장 금지)', async () => {
    const { res, updates } = await call(baseOrder(),
      Object.assign({}, BODY, { review_guide: '새 가이드', recruit_count: 500 }));
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(updates.length, 0);
    assert.deepStrictEqual(res.body.blocked_fields, ['recruit_count']);
    assert.ok(res.body.changed_fields.includes('review_guide'), '바뀐 칸 전체를 함께 알려줘야 한다');
  });

  await t('② 거부 문구는 코드명이 아니라 사람이 읽는 칸 이름을 말한다', async () => {
    const { res } = await call(baseOrder(), Object.assign({}, BODY, { recruit_count: 500, start_date: '2026-12-25' }));
    assert.match(res.body.error, /총 모집인원/);
    assert.match(res.body.error, /시작일/);
    assert.ok(!/recruit_count|start_date/.test(res.body.error), '코드명이 문구에 샜다: ' + res.body.error);
    assert.match(res.body.error, /작업보드에서 고쳐주세요/, '다음 행동을 말해야 한다');
  });

  await t('③ 허용 목록을 넓히지 않는다', async () => {
    const line = SRC.match(/const SOURCE_EDIT_AFTER_ACCEPT = \[([\s\S]*?)\];/);
    assert.ok(line, 'SOURCE_EDIT_AFTER_ACCEPT 선언 없음');
    const listed = line[1].match(/'([a-z_]+)'/g).map(v => v.replace(/'/g, ''));
    assert.deepStrictEqual(listed.slice().sort(), ALLOWED.slice().sort(),
      '허용 칸이 달라졌다 — 정원·일정·열 구성·금액·시트는 잠긴 채로 둔다');
  });

  await t('⑤ 부분 수정도 정원 검증·작업표 동기화를 호출하지 않는다', async () => {
    await call(baseOrder(), Object.assign({}, BODY, { review_guide: '새 가이드' }));
    assert.strictEqual(calls.quota, 0, 'assertWorkOrderQuota 가 호출됐다');
    assert.strictEqual(calls.sync, 0, 'syncWorkOrderRecruitTotal 이 호출됐다');
  });

  await t('⑥ 삭제된 오더는 안내 칸도 못 고친다(예외 없음)', async () => {
    const { res, updates } = await call(baseOrder({ deleted_at: new Date() }),
      Object.assign({}, BODY, { review_guide: '새 가이드' }));
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(updates.length, 0);
  });

  await t('⑥ 바뀐 내용이 없으면 종전대로 계약 전용 응답', async () => {
    const { res } = await call(baseOrder({ sales_id: '', contract_number: '', quote_id: '' }), BODY);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.contract_only, true);
    assert.deepStrictEqual(res.body.edited_fields, []);
  });

  await t('⑥ 잠기지 않은 오더는 종전 전체 수정 경로 그대로', async () => {
    const { res, updates } = await call(baseOrder({ advertiser_id: null, linked_campaign_id: null }),
      Object.assign({}, BODY, { recruit_count: 500 }));
    assert.strictEqual(res.statusCode, 200);
    assert.ok(/recruit_count = \$/.test(updates[0].sql), '전체 수정 경로가 아니다');
    assert.strictEqual(calls.quota, 1, '전체 경로는 정원 검증을 한다');
  });

  await t('⑥ 순번이 어긋나면 잠금과 무관하게 거부한다', async () => {
    const { res, updates } = await call(baseOrder(),
      Object.assign({}, BODY, { source_revision: 5, idempotency_key: 'ro_abc123:5', review_guide: '새 가이드' }));
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(updates.length, 0);
  });

  // ★★ 아래 둘은 **위 게이트에서 이미 걸러져 도달하지 않는 2차 방어선**이다(변이시험 실측 —
  //   핸들러를 아무리 돌려도 이 줄을 지운 변이가 잡히지 않는다). 그렇다고 지우면 위 게이트가
  //   한 번 헐거워지는 순간 그대로 시트·정원 칸이 쓰기에 실린다. 존재 자체를 고정한다.
  await t('⑦ 저장 직전에도 허용목록을 한 번 더 본다(2차 방어선 — 지우지 말 것)', async () => {
    // ⚠ 끝 표시는 **시작점 뒤에서** 찾는다 — 파일 앞쪽에 같은 문구가 있어 그냥 찾으면
    //   잘라낸 조각이 빈 문자열이 되고 검사가 조용히 무의미해진다(개발 중 실제로 밟았다).
    const from = SRC.indexOf('if (partialEdit) {');
    const block = SRC.slice(from, SRC.indexOf('RETURNING *', from));
    assert.ok(block.length > 200, '검사할 조각을 못 잘랐다');
    assert.ok(/\.filter\(column =>[^\n]*SOURCE_EDIT_AFTER_ACCEPT\.includes\(column\)/.test(block),
      '쓰기 칸 목록을 만들 때 허용목록 검사가 사라졌다');
  });

  await t('⑦ 칸 이름은 형식 검사를 통과한 것만 SQL 에 넣는다(주입 차단 — 지우지 말 것)', async () => {
    // ⚠ 끝 표시는 **시작점 뒤에서** 찾는다 — 파일 앞쪽에 같은 문구가 있어 그냥 찾으면
    //   잘라낸 조각이 빈 문자열이 되고 검사가 조용히 무의미해진다(개발 중 실제로 밟았다).
    const from = SRC.indexOf('if (partialEdit) {');
    const block = SRC.slice(from, SRC.indexOf('RETURNING *', from));
    assert.ok(block.length > 200, '검사할 조각을 못 잘랐다');
    assert.ok(/\/\^\[a-z_\]\+\$\/\.test\(column\)/.test(block),
      '칸 이름 형식 검사가 사라졌다 — 칸 이름은 문자열로 조립되므로 주입 경로가 열린다');
  });

  console.log(`\nreviewOrderContentEditAfterAccept: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
