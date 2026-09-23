'use strict';

/*
 * 구매일별 탭(18일/19일/20일)이 달라도 같은 작업명은 14일 동안 하나로 막힌다.
 * 실제 PostgreSQL 없이 SQL 계약과 결과 계산을 함께 점검한다.
 */
const assert = require('assert');
const {
  checkRepurchaseWindow,
  checkRepurchaseWindowBatch,
  checkRepurchaseStatusForAccounts,
} = require('../src/utils/repurchaseGuard');

function db(rows, seen) {
  return {
    query: async (sql, params) => {
      seen.push({ sql: String(sql), params });
      return { rows };
    },
  };
}

(async () => {
  const old = process.env.CAMPAIGN_REPARTICIPATE_DAYS;
  delete process.env.CAMPAIGN_REPARTICIPATE_DAYS;

  const seen = [];
  const at = new Date(Date.now() - 2 * 86400000);
  const single = await checkRepurchaseWindow(db([{ submitted_at: at }], seen), {
    sheetId: 'A-sheet', tabName: '18일 구매', phone8: '12345678',
  });
  assert.equal(single.blocked, true, '18일 구매 이력은 A작업의 19일/20일 구매도 막아야 한다');
  assert.equal(single.days, 14);
  assert.ok(seen[0].sql.includes('tab_configs'), '작업명으로 탭을 묶기 위해 tab_configs를 조회한다');
  assert.ok(seen[0].sql.includes('scope.work_name'), '현재 탭의 작업명을 범위 키로 사용한다');
  assert.ok(seen[0].sql.includes('os.repurchase_work_key'), '과거 탭 설정이 정리돼도 남는 주문 기준 키로 먼저 대조한다');
  assert.ok(seen[0].sql.includes('submitted_tab.campaign_name'), '작업명이 정정된 탭은 보존 키와 달라도 현재 작업명으로 다시 묶는다');
  assert.ok(!seen[0].sql.includes("NULLIF(BTRIM(os.repurchase_work_key), '') IS NULL"), '보존 키가 있어도 작업명 정정 대조를 막지 않는다');
  assert.ok(seen[0].sql.includes('scope.work_name IS NULL AND os.tab_name = $2'), '작업명 없는 레거시 탭은 종전 탭 단위로 폴백한다');

  const batchSeen = [];
  const batch = await checkRepurchaseWindowBatch(db([{ p8: '12345678', last_at: at }], batchSeen), {
    sheetId: 'A-sheet', tabName: '20일 구매', phone8List: ['12345678', '87654321'],
  });
  assert.equal(batch.get('12345678').blocked, true, '관리자 외부모집 배치도 같은 작업 전체를 막는다');
  assert.ok(batchSeen[0].sql.includes('scope.work_name'), '외부모집 배치도 같은 작업 범위를 사용한다');

  const statusSeen = [];
  const states = await checkRepurchaseStatusForAccounts(db([
    { campaign_id: 'A-20', phone8: '12345678', last_submitted_at: at },
  ], statusSeen), { campaignIds: ['A-20'], phone8List: ['12345678'] });
  assert.equal(states.get('12345678').get('A-20').status, 'locked', '홈 카드도 18일 이력을 20일 카드에 잠김으로 표시한다');
  assert.ok(statusSeen[0].sql.includes('base_tab.campaign_name'), '홈 상태 조회도 현재 작업명을 기준으로 묶는다');
  assert.ok(statusSeen[0].sql.includes('os.repurchase_work_key'), '홈 상태 조회도 보존된 작업 기준 키를 우선 사용한다');
  assert.ok(statusSeen[0].sql.includes('submitted_tab.campaign_name'), '홈 상태 조회도 작업명 정정을 반영한다');

  const fs = require('fs');
  const migration = fs.readFileSync(require('path').resolve(__dirname, '../migrations/144_repurchase_work_scope.sql'), 'utf8');
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS repurchase_work_key'), '주문 원장에 작업 기준 키를 보존한다');
  assert.ok(migration.includes('BEFORE INSERT ON order_submissions'), '모든 새 주문 기록 경로에서 기준 키를 자동 보존한다');
  assert.ok(migration.includes('campaign_participants cp'), '이미 정리된 탭의 과거 주문도 UUID 연결 기록으로만 안전하게 보정한다');
  const serverEntry = fs.readFileSync(require('path').resolve(__dirname, '../index.js'), 'utf8');
  assert.ok(serverEntry.includes("['order_submissions', 'repurchase_work_key']"), '마이그레이션이 실패하면 새 컬럼 누락 상태로 서버가 기동하지 않는다');

  if (old === undefined) delete process.env.CAMPAIGN_REPARTICIPATE_DAYS;
  else process.env.CAMPAIGN_REPARTICIPATE_DAYS = old;
  console.log('PASS repurchase work-wide virtual scenarios');
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
