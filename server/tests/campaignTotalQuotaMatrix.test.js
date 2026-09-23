/**
 * 총 모집 단일 판정 전수 경계행렬.
 *
 * 숫자 전체를 무한히 나열하는 대신 결과가 달라지는 동등분할 경계값을 직교 조합한다.
 *   - 모드: on / observe / off
 *   - 총량 출처: 공고 / 발주 폴백 / 무제한 / 시트 일정
 *   - 연결 상태: 미연결 / 연결 조회실패 / 탭 없음 / 비공유 탭 / 공유 탭
 *   - 신청·주문: 0 / 1 / 정원-2 / 정원-1 / 정원 / 정원+1
 *   - 유효 홀드: 0 / 1 / 2
 *
 * 기대값은 제품 함수의 반환값을 재사용하지 않고 이 파일의 독립 식으로 계산한다.
 * 실행: node tests/campaignTotalQuotaMatrix.test.js
 */
const assert = require('assert');

const SERVICE = require.resolve('../src/services/campaignState.service');
function load(mode) {
  process.env.CAMPAIGN_TABLE_QUOTA = mode;
  delete require.cache[SERVICE];
  return require(SERVICE);
}

const MODES = ['on', 'observe', 'off'];
const VALUES = [0, 1, 298, 299, 300, 301];
const HOLDS = [0, 1, 2];
const CAP_CASES = [
  { name: 'campaign', campaignTotal: 300, orderTotal: 0, schedule: null, cap: 300 },
  { name: 'work_order_fallback', campaignTotal: 0, orderTotal: 300, schedule: null, cap: 300 },
  { name: 'unlimited', campaignTotal: 0, orderTotal: 0, schedule: null, cap: 0 },
  {
    name: 'sheet_schedule', campaignTotal: 999, orderTotal: 0, cap: 300,
    schedule: {
      ok: true,
      dates: [
        { date: '2026-09-08', slots: 300 },
        { date: '2026-09-09', slots: 0 },
      ],
      byDate: { '2026-09-08': 300, '2026-09-09': 0 },
      totalSlots: 300,
      firstDate: '2026-09-08',
      lastDate: '2026-09-09',
      source: 'sheet',
    },
  },
];
const LINK_CASES = [
  { name: 'unlinked', expectsLinked: false, linked: null, linkedKnown: false, shared: false },
  { name: 'linked_unknown', expectsLinked: true, linked: null, linkedKnown: false, shared: false },
  { name: 'linked_no_tab', expectsLinked: true, linked: { ok: true, noTab: true }, linkedKnown: false, shared: false },
  { name: 'linked_private', expectsLinked: true, linked: { ok: true, orders: 0, ordersAll: 0, sharedTab: false }, linkedKnown: true, shared: false },
  { name: 'linked_shared', expectsLinked: true, linked: { ok: true, orders: 0, ordersAll: 0, sharedTab: true }, linkedKnown: true, shared: true },
];

let usageCases = 0;
let stateCases = 0;

for (const mode of MODES) {
  const S = load(mode);
  for (const capCase of CAP_CASES) {
    for (const linkCase of LINK_CASES) {
      for (const submitted of VALUES) {
        for (const orders of VALUES) {
          for (const holds of HOLDS) {
            const campaign = {
              id: 'matrix', participation_mode: true, status: 'active',
              recruit_total: capCase.campaignTotal, daily_limit: 9999,
              window_start: null, window_end: null,
              linked_sheet_id: linkCase.expectsLinked ? 'S' : null,
              linked_tab_name: linkCase.expectsLinked ? 'T' : null,
            };
            const linked = linkCase.linked && !linkCase.linked.noTab
              ? { ...linkCase.linked, orders, ordersAll: orders }
              : linkCase.linked;
            const counts = {
              submittedAll: submitted,
              activeHolds: holds,
              todaySubmitted: 0,
              todayActiveHolds: 0,
              submittedBeforeToday: submitted,
              orderQuota: capCase.orderTotal > 0 ? { recruitCount: capCase.orderTotal, dailyCount: 0 } : null,
              carry: null, hold: null, plans: null,
              linked,
            };

            const got = S.totalQuotaUsage(campaign, counts, capCase.schedule);
            const applicationUsed = submitted + holds;
            const tableUsed = linkCase.linkedKnown && !linkCase.shared
              ? Math.max(submitted, orders) + holds
              : applicationUsed;
            const enforced = mode === 'on';
            const known = !enforced || !linkCase.expectsLinked || linkCase.linkedKnown;
            const used = enforced ? tableUsed : applicationUsed;
            const source = enforced && linkCase.linkedKnown && !linkCase.shared
              ? 'order_ledger' : 'applications';
            const expected = {
              mode,
              cap: capCase.cap,
              submitted,
              activeHolds: holds,
              applicationUsed,
              orders: linkCase.linkedKnown ? orders : null,
              sharedTab: linkCase.linkedKnown && linkCase.shared,
              known,
              used,
              tableUsed,
              source,
              full: capCase.cap > 0 && used >= capCase.cap,
              wouldClose: capCase.cap > 0 && linkCase.linkedKnown && !linkCase.shared
                && tableUsed >= capCase.cap,
            };
            assert.deepStrictEqual(got, expected,
              `${mode}/${capCase.name}/${linkCase.name}/s${submitted}/o${orders}/h${holds}`);
            usageCases++;

            // 상태엔진까지 확인한다. 시트 일정 여부와 무관하게 총원 충족은 soft_full이며,
            // 주문 원장만 총원을 채운 경우에는 on+비공유 연결일 때만 table_over_total 이다.
            const state = S.computeCampaignState(
              { ...campaign, recruit_total: capCase.cap || 0 },
              { ...counts, orderQuota: null },
              new Date('2026-09-08T10:00:00+09:00'),
              capCase.schedule
            );
            const appFull = capCase.cap > 0 && applicationUsed >= capCase.cap;
            const tableOnlyFull = capCase.cap > 0 && !appFull && mode === 'on'
              && linkCase.linkedKnown && !linkCase.shared && tableUsed >= capCase.cap;
            const expectedState = appFull || tableOnlyFull ? 'soft_full' : 'open';
            assert.strictEqual(state.state, expectedState,
              `state ${mode}/${capCase.name}/${linkCase.name}/s${submitted}/o${orders}/h${holds}`);
            assert.strictEqual(state.stateReason || null,
              tableOnlyFull ? 'table_over_total' : null,
              `reason ${mode}/${capCase.name}/${linkCase.name}/s${submitted}/o${orders}/h${holds}`);
            stateCases++;
          }
        }
      }
    }
  }
}

// 미설정·알 수 없는 값은 안전 기본값 on 이어야 한다. 명시적인 observe/off만 완화한다.
for (const [raw, expected] of [
  ['', 'on'], ['garbage', 'on'], ['true', 'on'], ['1', 'on'],
  ['observe', 'observe'], ['dry', 'observe'], ['shadow', 'observe'],
  ['off', 'off'], ['false', 'off'], ['0', 'off'],
]) {
  assert.strictEqual(load(raw).TABLE_QUOTA_MODE, expected, `mode ${JSON.stringify(raw)}`);
}

console.log(`campaignTotalQuotaMatrix: usage ${usageCases} + state ${stateCases} = ${usageCases + stateCases} cases passed`);
