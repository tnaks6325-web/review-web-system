/**
 * 결정 239 — "이미 쓴 자리" 하한이 바로 구매(공고 밖 주문)까지 센다. 실제 DB 비교(옛/새 코드)는 PR 본문에 기록.
 * 여기서는 단일 출처(quotaFloor.service = 정원 엔진 셈)와 각 하한 배선이 다시 공고 참여만 세는 쪽으로 돌아가지 않게 고정한다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

(async () => {
  // ① 단일 출처 — 정원 엔진(fetchCampaignCounts.linked) 셈: max(확정, 연결 주문) + 홀드, 공유 작업표는 귀속 안 함
  const stPath = require.resolve('../src/services/campaignState.service');
  const real = require(stPath);
  const fake = (linked, extra = {}) => {
    require.cache[stPath].exports = {
      ...real,
      fetchCampaignCounts: async () => new Map([['c1', { submittedAll: 2, activeHolds: 1, todaySubmitted: 1, todayActiveHolds: 1, linked, ...extra }]]),
      TABLE_QUOTA_MODE: extra.__mode || 'on',
      loadDirectOrderCounts: async () => (extra.__direct ? new Map([['c1', extra.__direct]]) : null),
      loadExternalOptionOrders: async (_db, _ids, _now, opts) => {
        assert.ok(opts && opts.excludeApplicationDuplicates, 'floor drops manual duplicates of participation purchases');
        return extra.__extFail ? null : new Map([['c1', new Map([['A', { n: 3, today: 1 }], ['B', { n: 0, today: 0 }]])]]);
      },
    };
    delete require.cache[require.resolve('../src/services/quotaFloor.service')];
    return require('../src/services/quotaFloor.service');
  };
  const row = { id: 'c1', participation_mode: true, linked_sheet_id: 'S', linked_tab_name: 'T', recruit_total: 10 };
  const db = { query: async () => ({ rows: [row] }) };
  let f = await fake({ ok: true, orders: 7, ordersToday: 4 }).campaignUsedFloor(db, 'c1');
  assert.deepEqual([f.total, f.today, f.known], [8, 5, true], 'max(submitted 2, orders 7) + holds 1 / max(1, 4) + 1');
  f = await fake({ ok: true, orders: 7, ordersToday: 4, sharedTab: true }).campaignUsedFloor(db, 'c1');
  assert.deepEqual([f.total, f.sharedTab], [3, true], 'shared worktable: orders are not attributed (applications only)');
  f = await fake({ ok: false }).campaignUsedFloor(db, 'c1');
  assert.equal(f.known, false, 'order lookup failure is reported as unknown (callers block reductions)');
  f = await fake({ ok: false }, { __mode: 'observe' }).campaignUsedFloor(db, 'c1');
  assert.equal(f.known, false, 'observe mode does not turn a failed lookup into known');
  f = await fake(null, { __mode: 'off' }).campaignUsedFloor(db, 'c1');
  assert.equal(f.known, true, 'operator kill switch off = applications only, reductions not blocked forever');
  row.participation_mode = false;
  f = await fake({ ok: true, noTab: true }).campaignUsedFloor(db, 'c1');
  assert.equal(f.known, true, 'legacy (non-participation) campaign has no linked orders to count — deletable');
  row.participation_mode = true;
  const m = await fake({ ok: true, orders: 0 }).optionDirectOrders(db, 'c1');
  assert.deepEqual([...m], [['A', 3]], 'per-option direct purchases come from the engine attribution (externalOrders)');
  const qfFail = fake({ ok: true, orders: 0 }, { __extFail: true });
  assert.equal(await qfFail.optionDirectOrderStats(db, 'c1'), null, 'option lookup failure is unknown (null), not zero');
  assert.deepEqual([...(await qfFail.optionDirectOrders(db, 'c1'))], [], 'floor falls back to applications only on failure');
  // 확정 + 바로 구매 — 주문 없이 수동 확정한 참여가 있어도 과소하지 않게(Codex PR #1626)
  f = await fake({ ok: true, orders: 13, ordersToday: 0 }, { submittedAll: 10, todaySubmitted: 0, __direct: { n: 5, today: 2 } }).campaignUsedFloor(db, 'c1');
  assert.deepEqual([f.total, f.direct], [16, 5], '10 confirmations (2 without orders) + 5 direct + 1 hold');
  require.cache[stPath].exports = real;

  // ② 잠금 트랜잭션 안 호출은 SAVEPOINT 로 격리(실패해도 트랜잭션을 죽이지 않는다)
  const qf = read('src/services/quotaFloor.service.js');
  assert.ok(/SAVEPOINT \$\{name\}/.test(qf) && /ROLLBACK TO SAVEPOINT \$\{name\}/.test(qf));

  // ③ 하한 배선 — 각 자리가 단일 출처를 탄다
  const lrq = read('src/services/linkedRecruitQuota.service.js');
  assert.equal((lrq.match(/await _assertTotalFloor\(client, campaign\.id/g) || []).length, 3, '작업오더 검사·공고 수정 검사·작업오더 동기화 세 곳');
  assert.ok(/recruit_quota_unknown/.test(lrq), '주문 기록을 모르면 줄이기를 막는다');
  assert.ok(/optionDirectOrders\(client, campaignId\)/.test(lrq), '상품별 재배분 하한에 바로 구매');
  const plan = read('src/services/campaignPlan.service.js');
  assert.ok(/Math\.max\(apps, f\.today\)/.test(plan), '오늘 계획 하한 = max(공고 참여, 오늘 바로 구매 포함)');
  assert.ok(/used = Math\.max\(used, f\.total\)/.test(plan) && /code = 'quota_unknown'/.test(plan), '회차 빼기 하한 + 모르면 막음');
  const routes = read('src/routes/campaign.routes.js');
  assert.ok(/used\.length \|\| directByOpt\.get\(e\.opt_key\) > 0/.test(routes), '바로 구매만 있는 상품은 지우지 않고 닫는다');
  assert.ok(/바로 구매 \$\{f\.direct\}건이 있어 삭제할 수 없습니다/.test(routes), '바로 구매만 있는 공고 삭제 금지');
  assert.ok(/if \(!f\.known\) throw new Error\('연결 작업표 주문 조회 실패'\)/.test(routes), '공고 삭제: 모르면 지우지 않는다');
  assert.ok(/campaignUsedFloor\(fc, id\)/.test(routes), '공고 삭제 확인은 체크아웃 커넥션(주문 수 캐시 우회)');
  assert.ok(/displayRecruitTotal\(cur\[0\]\?\.recruit_total, cur\[0\]\?\.wo_total\)/.test(lrq), '모를 때 비교 기준 = 지금 적용 중인 정원(작업오더 대체값 포함)');
  assert.ok(/campaignUsedFloor\(client, id\)\)\.total/.test(routes) && /optionDirectOrders\(client, id\)\)\.get\(a\.option_key\)/.test(routes),
    '블로그 승인 자리 확인(공고·상품)');

  console.log('quotaFloorDirectPurchase: passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
