'use strict';
/**
 * 회귀가드 — 작업오더 결제금액 → 연결 모집공고 전파 (사용자 확정 2026-09-21)
 *
 * 실행: node tests/campaignPayAmountSync.test.js
 *
 * ★★ 배경: 리뷰어가 보는 결제금액은 **모집공고**에 있다. 오더만 고치면 "통과했다는데 화면은
 *   옛 금액" 이 된다. 그래서 금액을 열면서 공고까지 함께 바꾸기로 했다(작업오더→공고 자동 전파는
 *   정원 다음으로 두 번째다).
 *
 * ★ 이 가드가 지키는 것:
 *   ① **1건당 금액은 상품 구성에서만 읽는다** — `pay_amount`(합계)를 1건당 자리에 넣지 않는다
 *      (60건 작업에 9,324만원이 찍힌 2026-08-21 사고)
 *   ② 옵션 있는 공고 = 옵션명으로 짝지어 숫자 칸만 갱신 · 옵션 구성은 안 건드린다
 *   ③ 옵션 없는 공고 = 상품 안내 글의 금액 + payAmount 둘 다 (리뷰어 화면은 글자를 먼저 본다)
 *   ④ **fail-closed** — 금액이 여러 종류면 안 고치고 사유를 말한다
 *   ⑤ 쓰기 표면 = 옵션 금액 칸 · 공고 work_detail 둘뿐 (정원·옵션 구성·작업표·주문 무접촉)
 *   ⑥ 실패해도 throw 하지 않는다 (원본 수정 저장을 되돌리면 안 된다)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const svc = require(path.join(ROOT, 'src/services/campaignPayAmountSync.service.js'));
const { payAmountsFromWorkOrder } = require(path.join(ROOT, 'src/utils/workOrderPayAmounts.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'src/services/campaignPayAmountSync.service.js'), 'utf8');
const FRONT = fs.readFileSync(path.join(ROOT, '../frontend/js/work-order-detail.js'), 'utf8');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail += 1; }
}

/* 옵션 없는 단품(스크린샷의 그 오더 모양) */
const NONE = JSON.stringify([{
  name: '곰도리 핫팩, 50개', url: 'https://link.coupang.com/a/AAA',
  option_schema_version: 2, product_mode: 'none',
  base: { pay: 9190, count: 470, daily: 30, review_type_mix: [] }, options: [],
}]);
/* 옵션 둘 — 금액이 서로 다르다 */
const OPTS = JSON.stringify([{
  name: '핫팩 세트', url: 'https://x/y', option_schema_version: 2, product_mode: 'opt',
  base: { pay: 0, count: 0, daily: 0, review_type_mix: [] },
  options: [
    { option_1: { name: '색상', value: '레드' }, label: '레드', pay: 9190, count: 235, daily: 15 },
    { option_1: { name: '색상', value: '블루' }, label: '블루', pay: 12000, count: 235, daily: 15 },
  ],
}]);

/** 스텁 pool — 실행된 쿼리를 전부 기록한다. */
function stub({ campaign = { id: 'camp_1' }, liveOptions = [], workDetail = null } = {}) {
  const q = [];
  const client = {
    query: async (sql, params) => {
      const s = String(sql);
      q.push({ sql: s, params });
      if (/FROM work_orders WHERE id = \$1 FOR UPDATE/.test(s)) return { rows: [{ id: 'wo_1', linked_campaign_id: 'camp_1' }] };
      if (/FROM recruit_campaigns\s+WHERE \(id = \$1/.test(s)) return { rows: campaign ? [campaign] : [] };
      if (/FROM campaign_options/.test(s)) return { rows: liveOptions };
      if (/SELECT work_detail FROM recruit_campaigns/.test(s)) return { rows: [{ work_detail: workDetail }] };
      return { rows: [] };
    },
    release: () => {},
  };
  svc.__setPoolForTest({ connect: async () => client });
  return q;
}
const writes = q => q.filter(x => /^\s*UPDATE|INSERT|DELETE/i.test(x.sql));

async function run() {
  console.log('\n작업오더 결제금액 → 모집공고 전파');

  await t('① 1건당 금액은 상품 구성에서만 읽는다(합계를 쓰지 않는다)', () => {
    assert.strictEqual(payAmountsFromWorkOrder(NONE).single, 9190, '1건당 금액을 못 읽는다');
    // 서비스는 pay_amount(합계) 를 아예 인자로 받지 않는다 — 구조적으로 섞일 수 없다
    assert.ok(!/pay_amount\b\s*[,)]/.test(SRC.slice(SRC.indexOf('async function syncCampaignPayAmount'), SRC.indexOf('async function syncCampaignPayAmount') + 400)),
      '합계 칸이 전파 함수 인자에 섞였다');
    assert.ok(/payAmountsFromWorkOrder/.test(SRC), '1건당 추출 단일 출처를 안 쓴다');
  });

  await t('① 추출 규칙이 발행 프리필(_woOptionRows)과 같다', () => {
    // 옵션 금액 = op.pay || base.pay
    assert.ok(/Number\(op\.pay\)\s*\|\|\s*basePay/.test(FRONT), '프론트 규칙이 달라졌다(payAmount)');
    assert.ok(/_pay\(op\.pay\)\s*\|\|\s*basePay/.test(SRC.length ? fs.readFileSync(path.join(ROOT, 'src/utils/workOrderPayAmounts.js'), 'utf8') : ''),
      '서버 규칙이 프론트와 갈렸다');
    // "옵션 없음"류 판정도 글자 그대로 같은 정규식이어야 한다
    const U = fs.readFileSync(path.join(ROOT, 'src/utils/workOrderPayAmounts.js'), 'utf8');
    const pick = (text, label) => {
      const m = text.match(/\/\^\(옵션[^/]*\)\$\//);
      assert.ok(m, label + ' 에서 "옵션 없음" 판정 정규식을 못 찾았다');
      return m[0];
    };
    assert.strictEqual(pick(U, '서버'), pick(FRONT, '프론트'),
      '"옵션 없음" 판정이 서버·프론트에서 갈렸다 — 한쪽만 넓히면 금액이 엉뚱한 선택지에 붙는다');
  });

  await t('② 옵션 있는 공고 — 옵션명으로 짝지어 금액 칸만 갱신', async () => {
    const q = stub({ liveOptions: [{ opt_key: '레드', pay_amount: 8000 }, { opt_key: '블루', pay_amount: 8000 }] });
    const out = await svc.syncCampaignPayAmount({ workOrderId: 'wo_1', productOptionsJson: OPTS });
    assert.strictEqual(out.applied, true, JSON.stringify(out));
    assert.strictEqual(out.options, 2);
    const w = writes(q);
    assert.strictEqual(w.length, 2, '쓰기 횟수: ' + w.length);
    w.forEach(x => assert.ok(/UPDATE campaign_options SET pay_amount = \$3/.test(x.sql),
      '옵션 구성을 건드리는 쓰기가 섞였다: ' + x.sql));
    assert.deepStrictEqual(w.map(x => x.params[2]).sort((a, b) => a - b), [9190, 12000]);
  });

  await t('② 같은 값이면 쓰지 않는다(no-op)', async () => {
    const q = stub({ liveOptions: [{ opt_key: '레드', pay_amount: 9190 }, { opt_key: '블루', pay_amount: 12000 }] });
    const out = await svc.syncCampaignPayAmount({ workOrderId: 'wo_1', productOptionsJson: OPTS });
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.reason, 'already_same');
    assert.strictEqual(writes(q).length, 0);
  });

  await t('② 옵션명이 하나도 안 맞으면 안 고치고 사유를 말한다(fail-closed)', async () => {
    const q = stub({ liveOptions: [{ opt_key: '초록', pay_amount: 8000 }] });
    const out = await svc.syncCampaignPayAmount({ workOrderId: 'wo_1', productOptionsJson: OPTS });
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.reason, 'option_key_mismatch');
    assert.strictEqual(writes(q).length, 0, '짝을 못 지었는데 썼다');
  });

  await t('③ 옵션 없는 공고 — 안내 글의 금액과 payAmount 를 둘 다 바꾼다', async () => {
    const wd = { productLines: '곰도리 핫팩, 50개 - 결제금액 9,190원', payAmount: 9190, inflowGuideHtml: '<p>가이드</p>' };
    const next = JSON.stringify([{ name: '곰도리 핫팩, 50개', product_mode: 'none', base: { pay: 12000, count: 470 }, options: [] }]);
    const q = stub({ workDetail: JSON.stringify(wd) });
    const out = await svc.syncCampaignPayAmount({ workOrderId: 'wo_1', productOptionsJson: next });
    assert.strictEqual(out.applied, true, JSON.stringify(out));
    const w = writes(q);
    assert.strictEqual(w.length, 1);
    assert.ok(/UPDATE recruit_campaigns SET work_detail/.test(w[0].sql));
    const saved = JSON.parse(w[0].params[1]);
    assert.strictEqual(saved.payAmount, 12000, 'payAmount 를 안 바꿨다');
    assert.ok(/결제금액 12,000원/.test(saved.productLines),
      '리뷰어 화면이 먼저 보는 "글자 안 금액" 을 안 바꿨다: ' + saved.productLines);
    assert.strictEqual(saved.inflowGuideHtml, '<p>가이드</p>', '다른 칸을 잃었다');
  });

  await t('③ 글에 금액이 없으면 payAmount 만 채운다(리뷰어 화면이 별도 줄로 그린다)', async () => {
    const q = stub({ workDetail: JSON.stringify({ productLines: '곰도리 핫팩, 50개', payAmount: 0 }) });
    const out = await svc.syncCampaignPayAmount({ workOrderId: 'wo_1', productOptionsJson: NONE });
    assert.strictEqual(out.applied, true, JSON.stringify(out));
    const saved = JSON.parse(writes(q)[0].params[1]);
    assert.strictEqual(saved.payAmount, 9190);
    assert.strictEqual(saved.productLines, '곰도리 핫팩, 50개', '없던 금액을 글에 심었다');
  });

  await t('④ 작업오더 금액이 여러 종류면 글을 건드리지 않는다(fail-closed)', async () => {
    const q = stub({ workDetail: JSON.stringify({ productLines: '세트 - 결제금액 9,190원', payAmount: 9190 }) });
    const out = await svc.syncCampaignPayAmount({ workOrderId: 'wo_1', productOptionsJson: OPTS });
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.reason, 'multiple_amounts', JSON.stringify(out));
    assert.strictEqual(writes(q).length, 0);
  });

  await t('④ 공고 글에 금액이 여러 개면 건드리지 않는다(어느 글자인지 모른다)', async () => {
    const wd = { productLines: 'A - 결제금액 9,190원\nB - 결제금액 12,000원', payAmount: 9190 };
    const next = JSON.stringify([{ name: 'A', product_mode: 'none', base: { pay: 15000, count: 10 }, options: [] }]);
    const q = stub({ workDetail: JSON.stringify(wd) });
    const out = await svc.syncCampaignPayAmount({ workOrderId: 'wo_1', productOptionsJson: next });
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.reason, 'campaign_multiple_amounts', JSON.stringify(out));
    assert.strictEqual(writes(q).length, 0);
  });

  await t('⑤ 연결 공고가 없으면 아무것도 쓰지 않는다', async () => {
    const q = stub({ campaign: null });
    const out = await svc.syncCampaignPayAmount({ workOrderId: 'wo_1', productOptionsJson: NONE });
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.reason, 'no_campaign');
    assert.strictEqual(writes(q).length, 0);
  });

  await t('⑤ 쓰기 표면은 두 곳뿐 — 정원·옵션 구성·작업표·주문 무접촉', () => {
    /* ★ 구역을 **금액 전파 함수 본문**으로 좁힌다 — 같은 파일에 유입·시간창 전파가 합류했고
       그쪽 쓰기 표면은 `inflowSourceEdit` 가드가 따로 고정한다(두 가드가 겹쳐 세지 않게). */
    const PAY = SRC.slice(SRC.indexOf('async function syncCampaignPayAmount'),
      SRC.indexOf('async function syncCampaignThumbnail'));
    const THUMB = SRC.slice(SRC.indexOf('async function syncCampaignThumbnail'),
      SRC.indexOf('async function syncCampaignInflow'));
    const targets = [...(PAY + THUMB).matchAll(/UPDATE\s+(\w+)\s+SET\s+([a-z_]+)/g)].map(m => m[1] + '.' + m[2]);
    assert.deepStrictEqual([...new Set(targets)].sort(),
      // ★ 163 썸네일이 합류했다 — 셋 다 "공고에 보이는 값" 이고 표·정원·주문과는 무관하다.
      ['campaign_options.pay_amount', 'recruit_campaigns.thumbnail_url', 'recruit_campaigns.work_detail'],
      '쓰기 표면이 넓어졌다: ' + targets.join(', '));
    ['campaign_participants', 'order_submissions', 'campaign_rounds', 'recruit_total', 'INSERT INTO', 'DELETE FROM']
      .forEach(w => assert.ok(!SRC.includes(w), '건드리면 안 되는 곳을 쓴다: ' + w));
  });

  await t('⑥ 실패해도 throw 하지 않는다(원본 저장을 되돌리면 안 된다)', async () => {
    svc.__setPoolForTest({ connect: async () => { throw new Error('boom'); } });
    const out = await svc.syncCampaignPayAmount({ workOrderId: 'wo_1', productOptionsJson: NONE });
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.reason, 'db_unavailable');
    const client = {
      query: async (sql) => {
        if (/FROM work_orders/.test(String(sql))) return { rows: [{ id: 'wo_1' }] };
        throw new Error('쿼리 폭발');
      }, release: () => {},
    };
    svc.__setPoolForTest({ connect: async () => client });
    const out2 = await svc.syncCampaignPayAmount({ workOrderId: 'wo_1', productOptionsJson: NONE });
    assert.strictEqual(out2.applied, false);
    assert.strictEqual(out2.reason, 'error');
  });

  await t('⑥ 짝짓기는 정원 전파와 같은 함수를 쓴다(사본 0)', () => {
    assert.ok(/linkedCampaign/.test(SRC), '연결 공고 찾기를 따로 만들었다');
    assert.ok(!/source_work_order_id\s*=/.test(SRC), '짝짓기 SQL 사본이 생겼다');
  });

  /* ── ⑦ 배선 — 라우트가 실제로 전파를 부르는가 ────────────────────────────────
     ⚠ 문자열 검사만으로는 `if (false)` 로 죽인 변이를 놓친다(변이시험 실측) → **핸들러를 돌린다**. */
  await t('⑦ 금액을 고치면 라우트가 전파를 실제로 부른다', async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    process.env.ORDER_INTAKE_KEY = 'test-intake-key';
    const pool2 = require(path.join(ROOT, 'src/db/pool.js'));
    const q2 = require(path.join(ROOT, 'src/services/linkedRecruitQuota.service.js'));
    q2.assertWorkOrderQuota = async () => null;
    q2.syncWorkOrderRecruitTotal = async () => null;
    let called = null;
    const realSync = svc.syncCampaignPayAmount;
    svc.syncCampaignPayAmount = async (a) => { called = a; return { applied: true, campaignId: 'camp_1' }; };
    try {
      const router = require(path.join(ROOT, 'src/routes/order.routes.js'));
      const L = (router.stack || []).find(l => l.route
        && l.route.path === '/intake/source/:sourceReviewOrderId' && l.route.methods.put);
      assert.ok(L, '원본 수정 라우트가 없다');
      const handler = L.route.stack[L.route.stack.length - 1].handle;

      const optsOf = p => JSON.stringify([{ name: '핫팩', url: 'https://x/y', option_schema_version: 2,
        product_mode: 'none', base: { pay: p, count: 470, daily: 30, review_type_mix: [] }, options: [] }]);
      const ORDER = { id: 'wo_1', source_review_order_id: 'ro_x', source_revision: 1,
        intake_idempotency_key: 'ro_x:1', status: 'reviewing', deleted_at: null,
        linked_campaign_id: 'camp_1', advertiser_id: 'a1', title: 'T', start_date: new Date(2026, 8, 9),
        manager_name: 'M', work_manager: '박세희', product_option: '', product_options_json: optsOf(9190),
        product_distribution_mode: 'balanced', pay_amount: 4319300, review_fee: 0, daily_count: 30,
        daily_count_text: '30', purchase_channel: '쿠팡', purchase_time: '13:00 ~ 18:00',
        inflow_keyword: '', inflow_type: 'guide', inflow_guide: '', guide_images: '',
        delivery_type: '실배송', courier_proxy: false, review_type: '포토', review_type_mix: [],
        recruit_count: 470, review_guide: 'G', special_notes: '', product_url: 'https://x/y',
        work_sheet_url: '', goods_cost_type: '계산서', skip_weekends: null, holidays: null,
        work_kind: 'review', sales_id: 's', contract_number: 'c', quote_id: 'q' };
      const BODY = { intakeKey: 'test-intake-key', source_review_order_id: 'ro_x', source_revision: 2,
        idempotency_key: 'ro_x:2', title: 'T', start_date: '2026-09-09', manager_name: 'M',
        work_manager: '박세희', product_option: '', product_options_json: optsOf(12000),
        pay_amount: 5640000, review_fee: 0, daily_count: 30, daily_count_text: '30',
        product_distribution_mode: 'balanced', purchase_channel: '쿠팡', purchase_time: '13:00 ~ 18:00',
        inflow_keyword: '', inflow_type: 'guide', inflow_guide: '', delivery_type: '실배송',
        review_type: '포토', recruit_count: 470, review_guide: 'G', special_notes: '',
        product_url: 'https://x/y', work_sheet_url: '', goods_cost_type: '계산서', work_kind: 'review',
        sales_id: 's', contract_number: 'c', quote_id: 'q', intranet_advertiser_id: 'adv',
        intranet_advertiser_name: 'N', intranet_advertiser_contact: '010',
        intranet_advertiser_business_number: '000' };
      pool2.query = async (sql) => {
        const t2 = String(sql);
        if (/SELECT \* FROM work_orders WHERE source_review_order_id/.test(t2)) return { rows: [Object.assign({}, ORDER)] };
        if (/UPDATE work_orders SET/.test(t2)) return { rows: [Object.assign({}, ORDER, { source_revision: 2 })] };
        return { rows: [] };
      };
      const res = { statusCode: 200, body: null };
      res.status = c => { res.statusCode = c; return res; };
      res.json = b => { res.body = b; return res; };
      await handler({ body: BODY, params: { sourceReviewOrderId: 'ro_x' }, headers: {} }, res, e => { throw e; });

      assert.strictEqual(res.statusCode, 200, '금액 수정이 막혔다: ' + JSON.stringify(res.body));
      assert.ok(called, '금액을 고쳤는데 공고 전파가 불리지 않았다 — 리뷰어 화면이 옛 금액으로 남는다');
      assert.ok(res.body.campaign_pay_sync, '전파 결과를 응답에 안 싣는다 — 화면이 사실을 말할 수 없다');
      /* ★★★ 넘어간 재료가 **상품 구성**이어야 한다 — 합계(pay_amount)가 넘어가면
         1건당 자리에 합계가 들어가 9,324만원 사고가 재현된다. */
      const single = payAmountsFromWorkOrder(called.productOptionsJson).single;
      assert.strictEqual(single, 12000, '전파에 1건당 금액이 안 실렸다(합계가 섞였을 수 있다): ' + single);
      assert.ok(!Object.values(called).includes(5640000), '합계가 전파 인자에 섞였다');
    } finally {
      svc.syncCampaignPayAmount = realSync;
    }
  });

  console.log(`\ncampaignPayAmountSync: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
