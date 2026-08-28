'use strict';

// 실행: PGTEST_URL=postgres://... node --test tests/workboardConsolidationPg.test.js
const assert = require('assert');
const test = require('node:test');

if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const pool = require('../src/db/pool');
const consolidation = require('../src/services/workboardConsolidation.service');

test('실제 PostgreSQL: sealed 백업 → 가산 연결 → legacy 복귀 → 재조회', async () => {
  if (!process.env.PGTEST_URL) {
    console.log('PGTEST_URL 미설정 — 실제 PostgreSQL 검증 건너뜀');
    return;
  }

  const sheetId = `pg-it-workboard-${Date.now()}`;
  const tabName = '실제 PG 통폐합 검증';
  const targets = Array.from({ length: 120 }, (_, i) => ({
    sheetId: i === 0 ? sheetId : `${sheetId}-${i}`,
    tabName: i === 0 ? tabName : `실제 PG 승인목록 검증 ${i}`,
  }));
  let backupId = null;
  const workboardIds = [];
  try {
    await pool.query(
      `INSERT INTO tab_configs(sheet_id, tab_name, display_name, sheetless)
       SELECT x.sheet_id, x.tab_name, x.tab_name, TRUE
         FROM jsonb_to_recordset($1::jsonb) AS x(sheet_id text, tab_name text)`,
      [JSON.stringify(targets.map(x => ({ sheet_id: x.sheetId, tab_name: x.tabName })))]
    );
    const approved = await consolidation.approveLegacyTargets({ targets, by: 'test' });
    assert.equal(approved.approved, 120, '정확히 승인한 기존 무시트 작업만 잠금');

    const pilotTargets = targets.slice(0, 2);
    const backup = await consolidation.createPreCutoverBackup({
      targets: pilotTargets, reason: 'postgres-integration-test', createdBy: 'test',
    });
    backupId = backup.backupId;
    assert.equal(backup.recordCounts.tab_configs, 2, '두 pilot 후보의 원본 작업 설정을 sealed 백업에 보관');

    const linked = await consolidation.createAdditiveMappings({
      backupId, targets: pilotTargets, by: 'test',
    });
    workboardIds.push(...linked.mappings.map(x => x.workboardId));
    const mapped = await pool.query(
      'SELECT workboard_id FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2', [sheetId, tabName]
    );
    assert.equal(mapped.rows[0].workboard_id, workboardIds[0], '새 작업보드 ID가 가산 연결됨');

    await consolidation.setControlMode({ mode: 'pilot', targets: [pilotTargets[0]], by: 'test-a' });
    await consolidation.setControlMode({ mode: 'pilot', targets: [pilotTargets[1]], by: 'test-b' });
    const pilots = await pool.query(
      `SELECT sheet_id, tab_name FROM workboard_consolidation_targets WHERE rollout_state = 'pilot'`
    );
    assert.equal(pilots.rows.length, 1, 'pilot 대상을 바꿔도 활성 시험 작업은 정확히 1건');
    assert.equal(pilots.rows[0].sheet_id, pilotTargets[1].sheetId, '마지막 선택 작업만 pilot으로 유지');

    const control = await consolidation.rollbackToLegacy({ backupId, by: 'test' });
    assert.equal(control.mode, 'legacy', '새 경로 즉시 차단');
    await consolidation.revertAdditiveMappings({ backupId, by: 'test' });

    const reread = await pool.query(
      `SELECT t.workboard_id, e.reverted_at
         FROM tab_configs t
         JOIN workboard_consolidation_link_events e
           ON e.backup_id = $3 AND e.sheet_id = t.sheet_id AND e.tab_name = t.tab_name
        WHERE t.sheet_id = $1 AND t.tab_name = $2`,
      [sheetId, tabName, backupId]
    );
    assert.equal(reread.rows[0].workboard_id, null, '원래 작업 설정의 연결 값이 복구됨');
    assert.ok(reread.rows[0].reverted_at, '변경 저널에 되돌림 시점이 남음');
  } finally {
    if (backupId) {
      await pool.query(
        'UPDATE workboard_consolidation_controls SET rollback_backup_id = NULL WHERE rollback_backup_id = $1',
        [backupId]
      );
      await pool.query('DELETE FROM workboard_consolidation_link_events WHERE backup_id = $1', [backupId]);
      await pool.query('DELETE FROM workboard_consolidation_backups WHERE id = $1', [backupId]);
    }
    await pool.query(`DELETE FROM workboard_consolidation_targets WHERE sheet_id LIKE $1`, [`${sheetId}%`]);
    if (workboardIds.length) await pool.query('DELETE FROM workboards WHERE id = ANY($1::uuid[])', [workboardIds]);
    await pool.query(`DELETE FROM tab_configs WHERE sheet_id LIKE $1`, [`${sheetId}%`]);
    await pool.end();
  }
});
