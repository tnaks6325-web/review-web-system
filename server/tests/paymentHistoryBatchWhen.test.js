'use strict';
// 결정 320 — 기록 전용(과거 이체) 대량이체는 목록에 실제 이체 시각을 보인다(만든 시각 아님) · 일반 회차는 그대로
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const pool = require('../src/db/pool');
const payment = require('../src/services/payment.service');

(async () => {
  const orig = pool.query;
  let sql = '';
  pool.query = async q => {
    sql = String(q);
    return { rows: [
      { id: 'h', seq: 88, historical_key: 'historical-fee:abc:wt_x', created_at: '2026-10-30T13:46:58Z', first_paid_at: '2026-10-27T03:42:02Z', created_by: 'historical-fee-restoration' },
      { id: 'n', seq: 87, historical_key: null, created_at: '2026-10-30T06:53:41Z', first_paid_at: '2026-10-30T07:10:00Z', created_by: '박세희' },
    ] };
  };
  try {
    const [h, n] = await payment.listBatches();
    assert.match(sql, /MIN\(i\.paid_at\)[\s\S]*AS first_paid_at/, '목록 조회가 실제 이체 시각을 읽는다');
    assert.equal(h.historyOnly, true);
    assert.equal(h.transferredAt, '2026-10-27T03:42:02Z', '기록 전용 = 은행 증빙 시각');
    assert.equal(n.transferredAt, null, '일반 회차는 이체 시각을 내보내지 않는다(만든 시각 그대로)');

    const html = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
    const grab = name => { const s = html.indexOf(`function ${name}(`); assert.ok(s >= 0, name); return html.slice(s, html.indexOf('\n}\n', s) + 2); };
    const pd = html.slice(html.indexOf('function _pmDate('), html.indexOf('\n', html.indexOf('return k.toISOString()', html.indexOf('function _pmDate('))) + 1);
    const ctx = vm.createContext({ esc: s => String(s) });
    vm.runInContext(grab('_pmBatchWhen') + pd, ctx);
    const hv = ctx._pmBatchWhen(h), nv = ctx._pmBatchWhen(n);
    assert.match(hv, /^10-27 12:42/, hv);
    assert.match(hv, /지난 이체 기록/);
    assert.match(hv, /기록한 시각 10-30 22:46/, '기록한 시각은 지우지 않고 보조로 남긴다');
    assert.equal(nv, '10-30 15:53', '일반 회차 = 만든 시각 그대로');
    assert.match(html, /esc\(b\.historyOnly\?'기록 복원':\(b\.createdBy\|\|'-'\)\)/, '담당 칸에 내부 작업 이름 대신 「기록 복원」');
    console.log('paymentHistoryBatchWhen: 9 passed');
  } finally { pool.query = orig; await pool.end().catch(() => {}); }
})().catch(e => { console.error(e); process.exit(1); });
