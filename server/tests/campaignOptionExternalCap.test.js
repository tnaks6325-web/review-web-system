'use strict';
/**
 * campaignOptionExternalCap.test.js — 결정 210 회귀가드 (사용자 확정 2026-10-08 · 누쓰쓰 50건 실측)
 *  ① 공고 하루 몫 ≤ 선택지마다 그날 받을 수 있는 수의 합 → 일정 22/18/10 (종전 22/22/6)
 *  ② 공고 밖 주문(외부모집 수동제출 등)도 작업표 줄의 상품 표기로 선택지에 귀속해 센다 → 6/5 재발 방지
 * 실행: node tests/campaignOptionExternalCap.test.js
 */
const assert = require('assert');
const st = require('../src/services/campaignState.service');
const { matchOrderOption, optionDayCapacity, computeOptionView, dailyQuota, computeCampaignState, projectDailyQuotas } = st;

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

const NU = ['1. HA-600FHC (누쓰쓰)(배송메세지00<넣어서구매)', '2. HA-MP600R (누쓰쓰)(배송메세지00<넣어서구매)',
  '3. HA-200FH (누쓰쓰)(배송메세지00<넣어서구매)', '4. HA-700FH (누쓰쓰)(배송메세지00<넣어서구매)', '5. HA-HD2200(배송메세지00<넣어서구매)'];
const NU_OPTS = NU.map(k => ({ opt_key: k, product_name: k }));

(async () => {
  // ── ② 귀속 ──
  ok('작업표 줄 상품 칸("1. HA-600FHC (누쓰쓰)")이 선택지 이름에 포함 → 그 선택지(실측 그대로)', () => {
    assert.equal(matchOrderOption(NU_OPTS, { selectedOptKey: '', optionText: '1. HA-600FHC (누쓰쓰)', rowProduct: '1. HA-600FHC (누쓰쓰)' }), NU[0]);
  });
  ok('주문에 적힌 옵션이 정확히 같으면 그것이 먼저', () => {
    assert.equal(matchOrderOption(NU_OPTS, { selectedOptKey: NU[4], optionText: '1. HA-600FHC (누쓰쓰)' }), NU[4]);
  });
  ok('여러 선택지에 걸리면 세지 않는다(모르면 세지 않음)', () => {
    assert.equal(matchOrderOption(NU_OPTS, { optionText: '누쓰쓰' }), null);
    assert.equal(matchOrderOption(NU_OPTS, { optionText: 'HA' }), null, '4글자 미만 부분 일치 금지');
    assert.equal(matchOrderOption(NU_OPTS, {}), null);
  });
  ok('같은 상품의 옵션들 — 상품명만으로는 못 정하고 옵션 칸으로 정한다', () => {
    const opts = [{ opt_key: '샴푸 · 500ml', product_name: '샴푸' }, { opt_key: '샴푸 · 1L', product_name: '샴푸' }];
    assert.equal(matchOrderOption(opts, { selectedProduct: '샴푸' }), null);
    assert.equal(matchOrderOption(opts, { selectedProduct: '샴푸', optionText: '샴푸 · 1L' }), '샴푸 · 1L');
  });
  ok('공고 밖 주문이 선택지 자리를 쓴다 — 5/5 + 1 = 소진(used 6)', () => {
    const v = computeOptionView({ opt_key: 'A', recruit_total: 5, daily_limit: 3 },
      { submitted: 5, todaySubmitted: 3, activeHolds: 0, todayActiveHolds: 0, externalOrders: 1, todayExternalOrders: 0 }, { state: 'open' });
    assert.equal(v.used, 6); assert.equal(v.status, 'soldout'); assert.equal(v.externalUsed, 1);
    const w = computeOptionView({ opt_key: 'A', recruit_total: 10, daily_limit: 3 },
      { submitted: 3, todaySubmitted: 2, externalOrders: 1, todayExternalOrders: 1 }, { state: 'open' });
    assert.equal(w.todayUsed, 3); assert.equal(w.status, 'today_done', '오늘 공고 밖 주문도 오늘 몫을 쓴다');
  });

  // ── ① 하루 몫 상한 ──
  const caps = (usedA, usedE) => [0, 1, 2, 3].map(i => ({ key: NU[i], recruitTotal: 5, dailyLimit: 3, usedBefore: usedA, todayUsed: 0 }))
    .concat([{ key: NU[4], recruitTotal: 30, dailyLimit: 10, usedBefore: usedE, todayUsed: 0 }]);
  ok('상한 = Σ min(일건수, 남은 정원): 첫날 22 · 둘째 날 18 · 셋째 날 10', () => {
    assert.equal(optionDayCapacity(caps(0, 0)), 22);
    assert.equal(optionDayCapacity(caps(3, 10)), 18);
    assert.equal(optionDayCapacity(caps(5, 20)), 10);
  });
  ok('하루 제한 없는 선택지가 있거나 재료가 없으면 상한 없음(종전)', () => {
    assert.equal(optionDayCapacity(null), null);
    assert.equal(optionDayCapacity([]), null);
    assert.equal(optionDayCapacity([{ recruitTotal: 5, dailyLimit: 0, usedBefore: 0 }]), null);
  });
  ok('dailyQuota: 공고 22 · 상한 18 → 18 / 상한 없음 → 22 / 총량 clamp 유지', () => {
    const c = { daily_limit: 22, recruit_total: 50 };
    assert.equal(dailyQuota(c, 22, null, null, null, 18), 18);
    assert.equal(dailyQuota(c, 22, null, null, null, null), 22);
    assert.equal(dailyQuota(c, 45, null, null, null, 18), 5);
  });
  const CAMP = { participation_mode: true, status: 'active', daily_limit: 22, recruit_total: 50,
    window_start: '00:00', window_end: '23:59', close_buffer_min: 0, start_date: '2026-10-07' };
  ok('computeCampaignState: 둘째 날 오늘 몫 18(종전 22)', () => {
    const now = new Date('2026-10-08T03:00:00Z');
    const counts = { submittedBeforeToday: 22, todaySubmitted: 0, activeHolds: 0, todayActiveHolds: 0, submittedAll: 22, optionCaps: caps(3, 10) };
    assert.equal(computeCampaignState(CAMP, counts, now).dailyQuota, 18);
    assert.equal(computeCampaignState(CAMP, { ...counts, optionCaps: null }, now).dailyQuota, 22, '재료 없음 = 종전');
  });
  ok('앞날 예상(작업표가 따라가는 값): 22 / 18 / 10 으로 끝난다(종전 22/22/6)', () => {
    const now = new Date('2026-10-07T03:00:00Z');   // 첫날 아침, 아무도 없음
    const counts = { submittedBeforeToday: 0, todaySubmitted: 0, activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, optionCaps: caps(0, 0) };
    const p = projectDailyQuotas(CAMP, counts, { now, maxDays: 30 });
    const q = p.days.filter(d => d.quota > 0).map(d => d.quota);
    assert.deepEqual(q, [22, 18, 10]);
    const p0 = projectDailyQuotas(CAMP, { ...counts, optionCaps: null }, { now, maxDays: 30 });
    assert.deepEqual(p0.days.filter(d => d.quota > 0).map(d => d.quota), [22, 22, 6], '재료 없음 = 종전 그대로');
  });
  ok('선택지가 전부 정원에 닿으면 빈 날을 이어 붙이지 않는다(공고 총원 > 선택지 정원 합)', () => {
    const now = new Date('2026-10-07T03:00:00Z');
    const c = { ...CAMP, recruit_total: 100 };
    const counts = { submittedBeforeToday: 0, todaySubmitted: 0, activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, optionCaps: caps(0, 0) };
    const p = projectDailyQuotas(c, counts, { now, maxDays: 30 });
    assert.equal(p.truncated, false);
    assert.deepEqual(p.days.filter(d => d.quota > 0).map(d => d.quota), [22, 18, 10]);
  });

  // ── 조회 깔때기: 실패해도 종전 동작 ──
  {
    const log = [];
    const client = {
      release() {},
      async query(sql) {
        const q = String(sql); log.push(q.split('\n')[0].trim());
        if (/GROUP BY campaign_id, option_key/.test(q)) return { rows: [{ campaign_id: 'c1', option_key: 'A', active_holds: 0, today_active_holds: 0, submitted: 2, today_submitted: 0 }] };
        if (/FROM campaign_options/.test(q)) return { rows: [{ campaign_id: 'c1', opt_key: 'A', product_name: 'A상품' }] };
        if (/order_submissions/.test(q)) throw new Error('boom');
        return { rows: [] };
      },
    };
    const m = await st.fetchOptionCounts(client, 'c1', new Date('2026-10-08T03:00:00Z'));
    assert.deepEqual(m.get('A'), { activeHolds: 0, todayActiveHolds: 0, submitted: 2, todaySubmitted: 0 });
    assert(log.includes('SAVEPOINT opt_ext_orders') && log.includes('ROLLBACK TO SAVEPOINT opt_ext_orders'));
    passed++; console.log('  ✓ 공고 밖 주문 조회 실패 → 신청 수만(종전) · tx 안이면 SAVEPOINT 로 되돌린다');
  }
  {
    const client = {
      async query(sql) {
        const q = String(sql);
        if (/GROUP BY campaign_id, option_key/.test(q)) return { rows: [{ campaign_id: 'c1', option_key: NU[0], active_holds: 0, today_active_holds: 0, submitted: 5, today_submitted: 3 }] };
        if (/FROM campaign_options/.test(q)) return { rows: NU_OPTS.map(o => ({ campaign_id: 'c1', ...o })) };
        if (/order_submissions/.test(q)) return { rows: [{ campaign_id: 'c1', selected_opt_key: '', selected_product: '', option_text: '1. HA-600FHC (누쓰쓰)', row_product: '1. HA-600FHC (누쓰쓰)', is_today: false }] };
        return { rows: [] };
      },
    };
    const m = await st.fetchOptionCounts(client, 'c1', new Date('2026-10-08T03:00:00Z'));
    assert.equal(m.get(NU[0]).externalOrders, 1);
    assert.equal(computeOptionView({ opt_key: NU[0], recruit_total: 5, daily_limit: 3 }, m.get(NU[0]), null).used, 6);
    passed++; console.log('  ✓ 누쓰쓰 1번 상품 — 관리자 직접 등록 1건이 귀속되어 6/5');
  }
  console.log(`\n✅ campaignOptionExternalCap: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
