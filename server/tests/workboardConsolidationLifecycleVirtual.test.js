'use strict';

const assert = require('assert');
const test = require('node:test');
const consolidation = require('../src/services/workboardConsolidation.service');

function createVirtualDb() {
  const state = {
    backup: null, backupRecords: [], event: null, workboardId: null, workboardState: 'active', control: 'pilot', tabWorkboardId: null,
    targetState: 'approved', recoveredQueue: 0,
    queries: [],
  };
  const snapshotRows = {
    tab_configs: [{ id: 'tc-1', sheet_id: 'wt-1', tab_name: '가상 작업', sheetless: true }],
    order_submissions: [{ id: 'os-1', sheet_id: 'wt-1', tab_name: '가상 작업', mirror_status: 'written' }],
    campaign_participants: [{ id: 'cp-1', sheet_id: 'wt-1', tab_name: '가상 작업', seq: 2 }],
  };
  async function query(sql, params = []) {
    const q = String(sql); state.queries.push({ q, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(q) || /pg_advisory_xact_lock/.test(q)) return { rows: [] };
    if (/SELECT to_regclass/.test(q)) {
      const name = String(params[0] || '').replace('public.', '');
      return { rows: [{ name: Object.prototype.hasOwnProperty.call(snapshotRows, name) ? `public.${name}` : null }] };
    }
    if (/SELECT sheet_id, tab_name FROM workboard_consolidation_targets\s+WHERE \(sheet_id, tab_name\)/.test(q)) {
      return { rows: [{ sheet_id: 'wt-1', tab_name: '가상 작업' }] };
    }
    if (/INSERT INTO workboard_consolidation_backups/.test(q)) {
      state.backup = { id: 'backup-1', targets: JSON.parse(params[0]), state: 'sealed' };
      return { rows: [{ id: state.backup.id }] };
    }
    if (/SELECT to_jsonb\(t\)/.test(q)) {
      const table = Object.keys(snapshotRows).find(name => new RegExp(`FROM ${name} `).test(q));
      return { rows: (snapshotRows[table] || []).map(data => ({ data })) };
    }
    if (/INSERT INTO workboard_consolidation_backup_records/.test(q)) {
      state.backupRecords.push({ table: params[1], data: JSON.parse(params[2]) }); return { rows: [] };
    }
    if (/UPDATE workboard_consolidation_backups/.test(q)) return { rows: [] };
    if (/SELECT targets FROM workboard_consolidation_backups/.test(q)) return { rows: [state.backup] };
    if (/SELECT id FROM workboard_consolidation_backups/.test(q)) return { rows: state.backup ? [{ id: state.backup.id }] : [] };
    if (/SELECT workboard_id, COALESCE\(display_name/.test(q)) return { rows: [{ workboard_id: state.tabWorkboardId, title: '가상 작업' }] };
    if (/INSERT INTO workboards/.test(q)) { state.workboardId = 'wb-1'; return { rows: [{ id: state.workboardId }] }; }
    if (/UPDATE tab_configs SET workboard_id = \$3/.test(q)) { state.tabWorkboardId = params[2]; return { rows: [] }; }
    if (/UPDATE workboard_consolidation_targets\s+SET rollout_state = 'mapped', workboard_id/.test(q)) {
      state.targetState = 'mapped'; return { rows: [] };
    }
    if (/INSERT INTO workboard_consolidation_link_events/.test(q)) {
      state.event = { backup_id: params[0], sheet_id: params[1], tab_name: params[2], workboard_id: params[3], reverted_at: null };
      return { rows: [] };
    }
    if (/FROM workboard_consolidation_link_events/.test(q)) return { rows: state.event && !state.event.reverted_at ? [state.event] : [] };
    if (/UPDATE tab_configs SET workboard_id = NULL/.test(q)) { state.tabWorkboardId = null; return { rows: [] }; }
    if (/UPDATE workboard_consolidation_link_events SET reverted_at/.test(q)) { state.event.reverted_at = 'virtual-now'; return { rows: [] }; }
    if (/UPDATE workboards SET state = 'archived'/.test(q)) { state.workboardState = 'archived'; return { rows: [] }; }
    if (/INSERT INTO workboard_consolidation_controls/.test(q)) { state.control = 'legacy'; return { rows: [] }; }
    if (/UPDATE sync_queue q/.test(q)) { state.recoveredQueue = 0; return { rows: [], rowCount: 0 }; }
    if (/UPDATE workboard_consolidation_targets SET rollout_state = 'mapped'/.test(q)) {
      state.targetState = 'mapped'; return { rows: [] };
    }
    if (/UPDATE workboard_consolidation_targets\s+SET rollout_state = 'rolled_back'/.test(q)) {
      state.targetState = 'rolled_back'; return { rows: [] };
    }
    if (/FROM workboard_consolidation_controls/.test(q)) return { rows: [{ mode: state.control, updatedAt: null, updatedBy: 'virtual', rollbackBackupId: null }] };
    if (/UPDATE (work_orders|recruit_campaigns|order_submissions|campaign_participants) SET workboard_id/.test(q)) return { rows: [], rowCount: 1 };
    throw new Error('unexpected SQL: ' + q.slice(0, 160));
  }
  return { state, query, async connect() { return { query, release() {} }; } };
}

test('가상 수명주기: sealed 백업 → 가산 연결 → legacy 복귀·연결 제거 → 원상태 재조회', async () => {
  const db = createVirtualDb();
  consolidation.__setPoolForTest(db);
  try {
    const targets = [{ sheetId: 'wt-1', tabName: '가상 작업' }];
    const backup = await consolidation.createPreCutoverBackup({ targets, reason: 'virtual', createdBy: 'tester' });
    assert.equal(backup.backupId, 'backup-1');
    assert.deepEqual(backup.recordCounts, { tab_configs: 1, order_submissions: 1, campaign_participants: 1 });
    assert.equal(db.state.backupRecords.length, 3, '대상별 원문 스냅샷 보관');

    const linked = await consolidation.createAdditiveMappings({ backupId: backup.backupId, targets, by: 'tester' });
    assert.equal(linked.mappings[0].workboardId, 'wb-1');
    assert.equal(db.state.tabWorkboardId, 'wb-1', '가산 연결 완료');

    const control = await consolidation.rollbackToLegacy({ backupId: backup.backupId, by: 'tester' });
    assert.equal(control.mode, 'legacy', '새 경로 즉시 차단');
    const reverted = await consolidation.revertAdditiveMappings({ backupId: backup.backupId, by: 'tester' });
    assert.equal(reverted.reverted, 1);
    assert.equal(db.state.tabWorkboardId, null, '기존 작업 설정은 원상태');
    assert.ok(db.state.event.reverted_at, '변경 저널에 되돌림 기록');
    assert.equal(db.state.workboardState, 'archived', '감사 저널이 참조하는 작업보드는 보관 상태로 유지');
  } finally {
    consolidation.__setPoolForTest(null);
  }
});
