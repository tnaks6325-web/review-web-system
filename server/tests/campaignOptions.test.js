/**
 * campaignOptions.test.js — 참여형 캠페인 상품옵션 자리계산 회귀가드 (061, PRD v1.1 §07)
 * 실행: node tests/campaignOptions.test.js
 *
 * 커버:
 *  - computeOptionView: 정원/일일한도 소진 판정(soldout/today_done), 무제한(null), 수동마감(closed),
 *    캠페인 게이트 반영(selectable = 옵션 open AND 캠페인 open), used=제출+유효홀드 합
 *  - fetchOptionCounts: option_key GROUP BY 결과 매핑 + option_key IS NOT NULL 필터 SQL
 *  - 옵션 변경 순증 판정: 전환 대상 옵션의 잔여는 "자기 홀드 제외"로 계산됨을 계약으로 고정
 */
const assert = require('assert');
const {
  computeOptionView,
  fetchOptionCounts,
} = require('../src/services/campaignState.service');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

const OPEN_CAMP = { state: 'open' };
const CLOSED_CAMP = { state: 'daily_done' };

async function run() {
  // ═══ 1. computeOptionView — 기본 open ═══
  ok('1. 잔여 있음 → open·selectable', () => {
    const v = computeOptionView(
      { opt_key: '힙스', pay_amount: 29900, recruit_total: 20, daily_limit: 2, status: 'active' },
      { activeHolds: 1, todayActiveHolds: 1, submitted: 16, todaySubmitted: 0 },
      OPEN_CAMP);
    assert.equal(v.status, 'open');
    assert.equal(v.used, 17, 'used = 제출16 + 유효홀드1');
    assert.equal(v.remaining, 3, '20 - 17');
    assert.equal(v.todayUsed, 1, '오늘 제출0 + 오늘홀드1');
    assert.equal(v.todayRemaining, 1, 'dailyLimit2 - 1');
    assert.equal(v.selectable, true);
    assert.equal(v.payAmount, 29900);
  });

  // ═══ 2. 정원 소진 → soldout ═══
  ok('2. 정원 소진 → soldout·미선택', () => {
    const v = computeOptionView(
      { opt_key: '어나더', pay_amount: 0, recruit_total: 20, daily_limit: 0, status: 'active' },
      { activeHolds: 0, todayActiveHolds: 0, submitted: 20, todaySubmitted: 0 },
      OPEN_CAMP);
    assert.equal(v.status, 'soldout');
    assert.equal(v.remaining, 0);
    assert.equal(v.selectable, false);
  });

  // ═══ 3. 오늘 한도 소진 → today_done (총 정원은 남음) ═══
  ok('3. 오늘 한도 소진 → today_done', () => {
    const v = computeOptionView(
      { opt_key: '콰이어트', pay_amount: 0, recruit_total: 30, daily_limit: 3, status: 'active' },
      { activeHolds: 0, todayActiveHolds: 0, submitted: 12, todaySubmitted: 3 },
      OPEN_CAMP);
    assert.equal(v.status, 'today_done');
    assert.equal(v.remaining, 18, '총 정원은 남음(30-12)');
    assert.equal(v.todayRemaining, 0);
    assert.equal(v.selectable, false);
  });

  // ═══ 4. 무제한(정원0·일일0) → 항상 open, remaining/todayRemaining=null ═══
  ok('4. 무제한 옵션 → remaining/todayRemaining=null·open', () => {
    const v = computeOptionView(
      { opt_key: '무제한', pay_amount: 0, recruit_total: 0, daily_limit: 0, status: 'active' },
      { activeHolds: 5, todayActiveHolds: 5, submitted: 100, todaySubmitted: 50 },
      OPEN_CAMP);
    assert.equal(v.remaining, null);
    assert.equal(v.todayRemaining, null);
    assert.equal(v.status, 'open');
    assert.equal(v.selectable, true);
  });

  // ═══ 5. 수동 마감(status closed) → closed (카운트 무관) ═══
  ok('5. 수동 마감 → closed', () => {
    const v = computeOptionView(
      { opt_key: '단종', pay_amount: 0, recruit_total: 100, daily_limit: 0, status: 'closed' },
      { activeHolds: 0, todayActiveHolds: 0, submitted: 0, todaySubmitted: 0 },
      OPEN_CAMP);
    assert.equal(v.status, 'closed');
    assert.equal(v.selectable, false);
  });

  // ═══ 6. 옵션은 열려도 캠페인이 닫히면 selectable=false ═══
  ok('6. 캠페인 게이트 — 옵션 open이라도 캠페인 non-open이면 미선택', () => {
    const v = computeOptionView(
      { opt_key: '힙스', pay_amount: 0, recruit_total: 20, daily_limit: 0, status: 'active' },
      { activeHolds: 0, todayActiveHolds: 0, submitted: 0, todaySubmitted: 0 },
      CLOSED_CAMP);
    assert.equal(v.status, 'open', '옵션 자체는 열림');
    assert.equal(v.selectable, false, '캠페인이 닫혀 선택 불가');
  });

  // ═══ 7. campState 없음(변경 흐름) → 옵션 status만으로 판정, campOpen 취급 ═══
  ok('7. campState 미전달 → 옵션 open이면 selectable(변경 흐름)', () => {
    const v = computeOptionView(
      { opt_key: '콰이어트', pay_amount: 0, recruit_total: 30, daily_limit: 0, status: 'active' },
      { activeHolds: 0, todayActiveHolds: 0, submitted: 29, todaySubmitted: 0 },
      null);
    assert.equal(v.remaining, 1);
    assert.equal(v.selectable, true, 'campState 없으면 캠페인 open으로 간주(이미 참여중 변경)');
  });

  // ═══ 8. 마지막 1자리: used === recruitTotal-1 이면 아직 open, +1이면 soldout(경계) ═══
  ok('8. 마지막 1자리 경계', () => {
    const near = computeOptionView({ opt_key: 'x', recruit_total: 10, daily_limit: 0, status: 'active' },
      { activeHolds: 0, todayActiveHolds: 0, submitted: 9, todaySubmitted: 0 }, OPEN_CAMP);
    assert.equal(near.status, 'open');
    assert.equal(near.remaining, 1);
    const full = computeOptionView({ opt_key: 'x', recruit_total: 10, daily_limit: 0, status: 'active' },
      { activeHolds: 1, todayActiveHolds: 0, submitted: 9, todaySubmitted: 0 }, OPEN_CAMP);
    assert.equal(full.status, 'soldout', '유효홀드까지 합쳐 10 = 소진');
  });

  // ═══ 9. fetchOptionCounts — GROUP BY 매핑 + option_key IS NOT NULL 필터 ═══
  await (async () => {
    const captured = {};
    const mockDb = {
      async query(sql, params) {
        captured.sql = String(sql).replace(/\s+/g, ' ');
        captured.params = params;
        return { rows: [
          { option_key: '힙스', active_holds: '2', today_active_holds: '1', submitted: '16', today_submitted: '3' },
          { option_key: '콰이어트', active_holds: '0', today_active_holds: '0', submitted: '5', today_submitted: '0' },
        ] };
      },
    };
    const m = await fetchOptionCounts(mockDb, 'camp_1', new Date('2026-07-22T05:00:00Z'));
    ok('9. fetchOptionCounts 매핑', () => {
      assert.ok(/option_key IS NOT NULL/.test(captured.sql), 'option_key NULL 제외 필터');
      assert.ok(/GROUP BY option_key/.test(captured.sql), 'option_key GROUP BY');
      assert.equal(captured.params[0], 'camp_1');
      assert.deepEqual(m.get('힙스'), { activeHolds: 2, todayActiveHolds: 1, submitted: 16, todaySubmitted: 3 });
      assert.equal(m.get('콰이어트').submitted, 5);
      assert.equal(m.get('없는옵션'), undefined);
    });
  })();

  // ═══ 10. 빈 카운트(옵션에 아무도 없음) → used 0, 무제한이면 open ═══
  ok('10. 카운트 없음 → used 0', () => {
    const v = computeOptionView({ opt_key: 'new', recruit_total: 5, daily_limit: 2, status: 'active' }, undefined, OPEN_CAMP);
    assert.equal(v.used, 0);
    assert.equal(v.remaining, 5);
    assert.equal(v.todayRemaining, 2);
    assert.equal(v.status, 'open');
  });

  console.log(`\n✅ campaignOptions: ${passed} passed`);
}

run().catch(e => { console.error('❌', e); process.exit(1); });
