'use strict';

const assert = require('assert');
const test = require('node:test');
const consolidation = require('../src/services/workboardConsolidation.service');
const queueApply = require('../src/services/workboardQueueApply.service');
const sheetlessOrder = require('../src/services/sheetlessOrder.service');

function fakePool(mode = 'pilot') {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/FROM workboard_consolidation_controls/.test(sql)) {
        return { rows: [{ mode, updatedAt: null, updatedBy: 'test', rollbackBackupId: null }] };
      }
      if (/FROM tab_configs/.test(sql)) return { rows: [{ workboardId: 'wb-1', sheetless: true, rolloutState: mode }] };
      if (/FROM order_submissions WHERE id = \$1/.test(sql)) {
        return { rows: [{
          id: params[0], deleted_at: null, mirror_status: 'queued', sheet_id: 'wt-a', tab_name: 'A', tab_gid: '7', gid: '7',
          orderer: '가상리뷰어', recipient: '가상수취인', user_id: 'virtual-id', phone: '010-0000-0000', address: '가상주소',
          bank: '가상은행', account: '111', depositor: '가상예금주', price: '10000', order_num: '123456', memo: '',
          date_str: '2026-08-28', selected_opt_key: '', selected_product: '', blog_url: '',
        }] };
      }
      if (/UPDATE order_submissions SET workboard_id/.test(sql)) return { rowCount: 1, rows: [] };
      throw new Error('unexpected query: ' + String(sql).slice(0, 100));
    },
  };
}

test('가상 통합: pilot 주문은 작업보드 기록 함수로 1회 전달된다', async () => {
  const db = fakePool('pilot');
  consolidation.__setPoolForTest(db);
  queueApply.__setPoolForTest(db);
  const original = sheetlessOrder.writeOrderToWorktable;
  let captured = null;
  sheetlessOrder.writeOrderToWorktable = async input => { captured = input; return { ok: true, written: true, seq: 2 }; };
  try {
    const out = await queueApply.applyQueuedWorkboardOrder({
      sheetId: 'wt-a', tabName: 'A', tabGid: '7', orderSubmissionId: 'os-1', loginPhone8: '00000000', loginName: '가상리뷰어',
    });
    assert.equal(out.ok, true);
    assert.equal(out.workboardId, 'wb-1');
    assert.equal(captured.orderSubmissionId, 'os-1');
    assert.equal(captured.sheetId, 'wt-a');
    assert.equal(captured.orderData.price, '10000');
    assert.ok(db.calls.some(x => /UPDATE order_submissions SET workboard_id/.test(x.sql)), '원장에 workboard_id 연결');
  } finally {
    sheetlessOrder.writeOrderToWorktable = original;
    consolidation.__setPoolForTest(null);
    queueApply.__setPoolForTest(null);
  }
});

test('가상 통합: legacy 모드에서는 큐 소비를 보류해 기존 경로와 섞지 않는다', async () => {
  const db = fakePool('legacy');
  consolidation.__setPoolForTest(db);
  queueApply.__setPoolForTest(db);
  try {
    await assert.rejects(
      () => queueApply.applyQueuedWorkboardOrder({ sheetId: 'wt-a', tabName: 'A', orderSubmissionId: 'os-1' }),
      err => err && err.__defer === true && /legacy/.test(err.message)
    );
    assert.equal(db.calls.some(x => /FROM order_submissions/.test(x.sql)), false, '원장·작업보드를 건드리지 않는다');
  } finally {
    consolidation.__setPoolForTest(null);
    queueApply.__setPoolForTest(null);
  }
});
