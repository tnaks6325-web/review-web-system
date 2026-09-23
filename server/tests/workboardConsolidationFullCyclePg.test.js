'use strict';

// 운영 배포 없이 실제 PostgreSQL에서 승인→pilot→구매반영→실패표시→재처리→롤백복구를 검증한다.
const assert = require('assert');
const test = require('node:test');

if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const pool = require('../src/db/pool');
const consolidation = require('../src/services/workboardConsolidation.service');
const syncQueue = require('../src/services/syncQueue.service');

// 일부 장부 서비스가 best-effort 백그라운드 검사를 예약한다. 검증 결과 출력 뒤 그 핸들이
// 실제 PG 테스트 프로세스를 붙잡지 않게 종료한다(운영 서버의 핸들에는 영향 없음).
test.after(() => {
  const timer = setTimeout(() => process.exit(process.exitCode || 0), 25);
  timer.unref();
});

const HEADERS = ['번호', '주문자', '수취인', '아이디', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '주문번호', '구매일자'];

async function insertBlankSlot({ sheetId, tabName, tabGid, seq, workboardId }) {
  const row = Object.fromEntries(HEADERS.map(h => [h, '']));
  await pool.query(
    `INSERT INTO campaign_participants
       (sheet_id, tab_name, tab_gid, seq, row_json, workboard_id, source, active, updated_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,'worktable',TRUE,'full-cycle-test')`,
    [sheetId, tabName, tabGid, seq, JSON.stringify(row), workboardId || null]
  );
}

async function insertOrder({ sheetId, tabName, tabGid, suffix, price }) {
  const { rows } = await pool.query(
    `INSERT INTO order_submissions
       (sheet_id, tab_name, tab_gid, gid, mirror_status, orderer, recipient, user_id,
        phone, address, bank, account, depositor, price, order_num, date_str, submitted_at)
     VALUES ($1,$2,$3,$3,'queued',$4,$4,$5,$6,$7,'신한은행',$8,$4,$9,$10,'2026-08-28',NOW())
     RETURNING id`,
    [sheetId, tabName, tabGid, `가상직원확인-${suffix}`, `tester-${suffix}`,
     `010-7000-${String(suffix).padStart(4, '0')}`, `서울 테스트주소 ${suffix}`,
     `1102018885${String(suffix).padStart(2, '0')}`, String(price), `828000${String(suffix).padStart(3, '0')}`]
  );
  return rows[0].id;
}

async function enqueueOrder({ sheetId, tabName, tabGid, orderSubmissionId, maxRetry = 1 }) {
  return syncQueue.enqueue('workboard_apply', {
    sheetId, tabName, tabGid, orderSubmissionId,
    loginPhone8: '70000000', loginName: '가상직원확인',
  }, maxRetry);
}

async function cleanup(prefix, backupId) {
  const { rows: knownBoards } = await pool.query(
    `SELECT workboard_id FROM workboard_consolidation_targets WHERE sheet_id LIKE $1
     UNION SELECT workboard_id FROM workboard_consolidation_link_events WHERE sheet_id LIKE $1`,
    [`${prefix}%`]
  );
  await pool.query(`UPDATE workboard_consolidation_controls
                       SET mode='legacy', rollback_backup_id=NULL, updated_by='full-cycle-cleanup'
                     WHERE singleton=TRUE`);
  await pool.query(`DELETE FROM sync_queue WHERE payload->>'sheetId' LIKE $1`, [`${prefix}%`]);
  const tables = [
    'participation_links', 'review_index_archive', 'review_index', 'raw_sheet_rows', 'raw_sheet_tabs',
    'index_master', 'order_submissions', 'campaign_participants', 'work_orders', 'recruit_campaigns',
  ];
  for (const table of tables) {
    const { rows } = await pool.query('SELECT to_regclass($1) AS name', [`public.${table}`]);
    if (!rows[0].name) continue;
    const col = table === 'work_orders' ? 'linked_tab_sheet_id'
      : table === 'recruit_campaigns' ? 'linked_sheet_id' : 'sheet_id';
    await pool.query(`DELETE FROM ${table} WHERE ${col} LIKE $1`, [`${prefix}%`]);
  }
  if (backupId) {
    await pool.query('DELETE FROM workboard_consolidation_link_events WHERE backup_id=$1', [backupId]);
    await pool.query('DELETE FROM workboard_consolidation_backups WHERE id=$1', [backupId]);
  }
  await pool.query(`DELETE FROM workboard_consolidation_targets WHERE sheet_id LIKE $1`, [`${prefix}%`]);
  const ids = knownBoards.map(r => r.workboard_id).filter(Boolean);
  await pool.query(`DELETE FROM tab_configs WHERE sheet_id LIKE $1`, [`${prefix}%`]);
  if (ids.length) await pool.query('DELETE FROM workboards WHERE id = ANY($1::uuid[])', [ids]);
}

test('실제 PostgreSQL 전사이클: 승인·직원수정·실패재처리·롤백 적체복구', async () => {
  if (!process.env.PGTEST_URL) {
    console.log('PGTEST_URL 미설정 — 실제 PostgreSQL 전사이클 검증 건너뜀');
    return;
  }

  const prefix = `pg-full-cycle-${Date.now()}`;
  const sheetId = prefix;
  const tabName = '전사이클 pilot 작업';
  const tabGid = '828140';
  const targets = Array.from({ length: 120 }, (_, i) => ({
    sheetId: i === 0 ? sheetId : `${prefix}-${i}`,
    tabName: i === 0 ? tabName : `전사이클 승인 작업 ${i}`,
  }));
  let backupId = null;

  try {
    await assert.rejects(
      () => consolidation.approveLegacyTargets({ targets: targets.slice(0, 119), by: 'test' }),
      err => err && err.code === 'legacy_target_count_mismatch'
    );
    const excluded = targets.map(x => ({ ...x }));
    excluded[119].tabName = '4/27(메이커스)좋은상황_상황버섯진액 98건';
    await assert.rejects(
      () => consolidation.approveLegacyTargets({ targets: excluded, by: 'test' }),
      err => err && err.code === 'excluded_target'
    );

    await pool.query(
      `INSERT INTO tab_configs(sheet_id, tab_name, tab_gid, display_name, campaign_name, sheetless)
       SELECT x.sheet_id, x.tab_name, CASE WHEN x.sheet_id=$2 THEN $3 ELSE NULL END,
              x.tab_name, x.tab_name, TRUE
         FROM jsonb_to_recordset($1::jsonb) AS x(sheet_id text, tab_name text)`,
      [JSON.stringify(targets.map(x => ({ sheet_id: x.sheetId, tab_name: x.tabName }))), sheetId, tabGid]
    );
    assert.equal((await consolidation.approveLegacyTargets({ targets, by: 'test' })).approved, 120);

    // 승인목록 확정 뒤 새로 만든 작업은 legacy_120을 건드리지 않고 별도 작업보드 소속을 자동 획득한다.
    const newSheetId = `${prefix}-future`;
    const newTabName = '앞으로 생성되는 무시트 작업';
    await pool.query(
      `INSERT INTO tab_configs(sheet_id,tab_name,tab_gid,display_name,campaign_name,sheetless)
       VALUES ($1,$2,'828141',$2,$2,TRUE)`, [newSheetId, newTabName]
    );
    const newTarget = await consolidation.ensureNewWorkTarget({ sheetId: newSheetId, tabName: newTabName, by: 'test' });
    assert.equal(newTarget.source, 'new_work');
    assert.equal(newTarget.rolloutState, 'mapped');
    const newClient = await pool.connect();
    try {
      await newClient.query('BEGIN');
      await require('../src/services/participants.service').appendSlot(newClient, {
        sheetId: newSheetId, tabName: newTabName, tabGid: '828141', workboardId: newTarget.workboardId, by: 'test',
      });
      await newClient.query('COMMIT');
    } catch (err) {
      try { await newClient.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally { newClient.release(); }
    const { rows: futureRows } = await pool.query(
      `SELECT cp.workboard_id, t.source, t.rollout_state
         FROM campaign_participants cp JOIN workboard_consolidation_targets t
           ON t.sheet_id=cp.sheet_id AND t.tab_name=cp.tab_name
        WHERE cp.sheet_id=$1`, [newSheetId]
    );
    assert.equal(String(futureRows[0].workboard_id), String(newTarget.workboardId));
    assert.deepEqual({ source: futureRows[0].source, state: futureRows[0].rollout_state },
      { source: 'new_work', state: 'mapped' });

    const backup = await consolidation.createPreCutoverBackup({
      targets: [{ sheetId, tabName }], reason: 'full-cycle', createdBy: 'test',
    });
    backupId = backup.backupId;
    const mapped = await consolidation.createAdditiveMappings({
      backupId, targets: [{ sheetId, tabName }], by: 'test',
    });
    const workboardId = mapped.mappings[0].workboardId;
    await insertBlankSlot({ sheetId, tabName, tabGid, seq: 2, workboardId });
    assert.equal((await consolidation.setControlMode({
      mode: 'pilot', targets: [{ sheetId, tabName }], by: 'test',
    })).mode, 'pilot');

    // 1. 제출 뒤 직원이 원장의 금액을 수정해도 늦은 큐가 예전 금액으로 되돌리지 않는다.
    const order1 = await insertOrder({ sheetId, tabName, tabGid, suffix: 1, price: 10000 });
    await enqueueOrder({ sheetId, tabName, tabGid, orderSubmissionId: order1 });
    await pool.query(`UPDATE order_submissions SET price='13090', last_edit_seq=COALESCE(last_edit_seq,0)+1 WHERE id=$1`, [order1]);
    const firstDrain = await syncQueue.drainOrderQueue(order1);
    assert.equal(firstDrain.succeeded, 1);
    const { rows: firstRows } = await pool.query(
      `SELECT cp.workboard_id, cp.row_json->>'결제금액' AS price, os.mirror_status
         FROM campaign_participants cp JOIN order_submissions os ON os.id=cp.order_submission_id
        WHERE os.id=$1`, [order1]
    );
    assert.equal(firstRows[0].price, '13090', '직원이 고친 최신 금액이 작업보드 원본에 반영');
    assert.equal(String(firstRows[0].workboard_id), String(workboardId));
    assert.equal(firstRows[0].mirror_status, 'written');

    // 2. 빈자리가 없으면 최종 실패가 주문에도 표시되고, 자리 보충 뒤 같은 큐를 재처리한다.
    const order2 = await insertOrder({ sheetId, tabName, tabGid, suffix: 2, price: 22000 });
    const queue2 = await enqueueOrder({ sheetId, tabName, tabGid, orderSubmissionId: order2 });
    const failedDrain = await syncQueue.drainOrderQueue(order2);
    assert.equal(failedDrain.failed, 1);
    let { rows: failedRows } = await pool.query(
      `SELECT sq.status AS queue_status, os.mirror_status, os.sheet_error
         FROM sync_queue sq JOIN order_submissions os ON os.id=(sq.payload->>'orderSubmissionId')::uuid
        WHERE sq.id=$1`, [queue2]
    );
    assert.equal(failedRows[0].queue_status, 'failed');
    assert.equal(failedRows[0].mirror_status, 'failed');
    assert.match(failedRows[0].sheet_error, /no_open_slot/);
    await insertBlankSlot({ sheetId, tabName, tabGid, seq: 3, workboardId });
    await syncQueue.retryItem(queue2);
    assert.equal((await syncQueue.drainOrderQueue(order2)).succeeded, 1);

    // 3. 전환 도중 남은 pending은 legacy 복구 큐로 바뀌고 연결 제거 뒤에도 종전 경로로 완결된다.
    await insertBlankSlot({ sheetId, tabName, tabGid, seq: 4, workboardId });
    const order3 = await insertOrder({ sheetId, tabName, tabGid, suffix: 3, price: 33000 });
    const queue3 = await enqueueOrder({ sheetId, tabName, tabGid, orderSubmissionId: order3 });
    const rolled = await consolidation.rollbackToLegacy({ backupId, by: 'test' });
    assert.equal(rolled.mode, 'legacy');
    assert.equal(rolled.recoveredQueue, 1);
    let { rows: recoveredQueue } = await pool.query('SELECT type,status FROM sync_queue WHERE id=$1', [queue3]);
    assert.deepEqual(recoveredQueue[0], { type: 'workboard_legacy_apply', status: 'pending' });
    await consolidation.revertAdditiveMappings({ backupId, by: 'test' });
    assert.equal((await syncQueue.drainOrderQueue(order3)).succeeded, 1);

    const { rows: finalRows } = await pool.query(
      `SELECT os.id, os.mirror_status, cp.seq, cp.row_json->>'결제금액' AS price
         FROM order_submissions os
         JOIN campaign_participants cp ON cp.order_submission_id=os.id
        WHERE os.id=ANY($1::uuid[]) ORDER BY cp.seq`, [[order1, order2, order3]]
    );
    assert.equal(finalRows.length, 3);
    assert.ok(finalRows.every(r => r.mirror_status === 'written'));
    const { rows: visible } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM review_index WHERE sheet_id=$1 AND tab_name=$2)::int AS reviewers,
              (SELECT COUNT(*) FROM index_master WHERE sheet_id=$1 AND tab_name=$2 AND status='active')::int AS boards`,
      [sheetId, tabName]
    );
    assert.equal(visible[0].reviewers, 3, '리뷰내역 검색 원장에 3건 노출');
    assert.equal(visible[0].boards, 1, '작업 목록 원장에 작업 1건 노출');
  } finally {
    await cleanup(prefix, backupId);
    await pool.end();
  }
});
