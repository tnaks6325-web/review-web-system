'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { EventEmitter } = require('events');

const affinity = require('../src/services/workboardSlotAffinity.service');
const sheetlessOrder = require('../src/services/sheetlessOrder.service');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WB = '11111111-1111-4111-8111-111111111111';
const OS = '22222222-2222-4222-8222-222222222222';

test('활성 작업의 아직 미연결된 같은 탭 행만 보정한다', async () => {
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql: String(sql), params });
    return { rows: [{ workboard_id: WB, bound: 5 }] };
  } };
  const out = await affinity.bindUnassignedRowsToActiveWorkboard(client, {
    sheetId: 'wt-a', tabName: 'T1', expectedWorkboardId: WB,
  });
  assert.deepStrictEqual(out, { workboardId: WB, bound: 5 });
  const q = calls[0];
  assert.deepStrictEqual(q.params, ['wt-a', 'T1', WB]);
  assert.match(q.sql, /w\.state = 'active'/);
  assert.match(q.sql, /tc\.sheet_id = \$1 AND tc\.tab_name = \$2/);
  assert.match(q.sql, /tc\.workboard_id = \$3::uuid/);
  assert.match(q.sql, /cp\.deleted_at IS NULL AND cp\.active = TRUE AND cp\.workboard_id IS NULL/);
  assert.doesNotMatch(q.sql, /cp\.workboard_id\s*<>|cp\.workboard_id\s*!=/);
});

test('잘못된 대상이거나 대상이 없으면 연결하지 않는다', async () => {
  const client = { query: async () => ({ rows: [{ workboard_id: null, bound: 0 }] }) };
  const out = await affinity.bindUnassignedRowsToActiveWorkboard(client, {
    sheetId: 'wt-a', tabName: 'T1', expectedWorkboardId: WB,
  });
  assert.deepStrictEqual(out, { workboardId: null, bound: 0 });
});

test('기존 미연결 빈자리도 실제 주문 기록 전에 안전하게 회복한다', async () => {
  const slot = { id: 'slot-1', seq: 202, workboard_id: null, order_submission_id: null, row_json: { 번호: '197', 수취인: '', 연락처: '' } };
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql).trim();
      calls.push({ sql: text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (/pg_advisory_xact_lock/.test(text)) return { rows: [{}], rowCount: 1 };
      if (/WITH target AS/.test(text) && /UPDATE campaign_participants cp/.test(text)) {
        slot.workboard_id = WB;
        return { rows: [{ workboard_id: WB, bound: 1 }], rowCount: 1 };
      }
      if (/SELECT \* FROM order_submissions/.test(text)) {
        return { rows: [{
          id: OS, mirror_status: 'queued', orderer: '정상리뷰어', recipient: '정상수취인',
          phone: '010-1234-5678', order_num: '', selected_opt_key: '', selected_product: '',
          price: '11800', date_str: '2026-09-08',
        }] };
      }
      if (/order_submission_id = \$3::uuid/.test(text) && /FROM campaign_participants/.test(text)) return { rows: [] };
      if (/SELECT cp\.id, cp\.seq/.test(text) && /FOR UPDATE SKIP LOCKED/.test(text)) {
        return { rows: slot.workboard_id === WB && !slot.order_submission_id ? [slot] : [] };
      }
      if (/UPDATE campaign_participants\s+SET row_json/.test(text)) {
        assert.strictEqual(params[9], WB, '선점한 행에 현재 작업 연결을 함께 저장해야 한다');
        slot.order_submission_id = OS;
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT id FROM campaign_participants/.test(text) && /order_submission_id = \$4::uuid/.test(text)) {
        return { rows: slot.order_submission_id === OS && slot.workboard_id === WB ? [{ id: slot.id }] : [] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const db = {
    async query(sql) {
      const text = String(sql);
      if (/FROM workboards w/.test(text) && /JOIN tab_configs/.test(text)) {
        return { rows: [{ sheet_id: 'wt-a', tab_name: 'T1', tab_gid: '7' }] };
      }
      if (/owner_reviewer_id/.test(text) && /FROM order_submissions/.test(text)) return { rows: [{}] };
      return { rows: [], rowCount: 1 };
    },
    async connect() { return client; },
  };

  const ledger = require('../src/services/orderLedger.service');
  const ledgers = require('../src/services/sheetlessLedger.service');
  const participation = require('../src/services/participation.service');
  const numbering = require('../src/services/rowNumbering.service');
  const saved = {
    load: ledger.loadRawTabContext, written: ledger.markOrderWritten, identity: ledger.recordReviewIdentity,
    rebuild: ledgers.rebuildLedgers, link: participation.recordParticipationLink, renumber: numbering.renumberTabInTx,
  };
  ledger.loadRawTabContext = async () => ({ headers: ['번호', '수취인', '연락처'], tabGid: '7' });
  ledger.markOrderWritten = async () => {};
  ledger.recordReviewIdentity = async () => {};
  ledgers.rebuildLedgers = async () => ({ mirrorRows: 1, indexRows: 1 });
  participation.recordParticipationLink = async () => {};
  numbering.renumberTabInTx = async () => ({ ok: true });
  sheetlessOrder.__setPoolForTest(db);
  try {
    const out = await sheetlessOrder.writeOrderToWorktable({
      sheetId: 'wt-a', tabName: 'T1', tabGid: '7', orderSubmissionId: OS, workboardId: WB,
      orderData: {}, loginName: '정상리뷰어', loginPhone8: '12345678',
    });
    assert.equal(out.ok, true);
    assert.equal(out.written, true);
    assert.equal(out.seq, 202);
    assert.equal(slot.workboard_id, WB);
    assert.equal(slot.order_submission_id, OS);
    const bindAt = calls.findIndex(c => /WITH target AS/.test(c.sql));
    const claimAt = calls.findIndex(c => /FOR UPDATE SKIP LOCKED/.test(c.sql));
    assert.ok(bindAt > -1 && claimAt > bindAt, '탭 잠금 뒤 연결 보정이 먼저, 빈자리 선점이 나중이어야 한다');
  } finally {
    sheetlessOrder.__setPoolForTest(null);
    ledger.loadRawTabContext = saved.load;
    ledger.markOrderWritten = saved.written;
    ledger.recordReviewIdentity = saved.identity;
    ledgers.rebuildLedgers = saved.rebuild;
    participation.recordParticipationLink = saved.link;
    numbering.renumberTabInTx = saved.renumber;
  }
});

test('정원·날짜조절로 새로 만드는 모든 준비 행이 활성 작업 연결을 상속한다', () => {
  const quota = read('src/services/linkedRecruitQuota.service.js');
  const daily = read('src/services/sheetlessDailyPlan.service.js');
  assert.match(quota, /INSERT INTO campaign_participants[\s\S]*?row_json, workboard_id, source[\s\S]*?JOIN workboards w ON w\.id=tc\.workboard_id AND w\.state='active'/);
  assert.equal((daily.match(/INSERT INTO campaign_participants/g) || []).length, 2);
  assert.equal((daily.match(/row_json, workboard_id, source/g) || []).length, 2);
  assert.equal((daily.match(/JOIN workboards w ON w\.id=tc\.workboard_id AND w\.state='active'/g) || []).length, 2);
});

test('동시 제출과 다른 작업 보호 규칙을 유지한다', () => {
  const source = read('src/services/sheetlessOrder.service.js');
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /AND \(\$3::uuid IS NULL OR cp\.workboard_id = \$3\)/);
  assert.match(source, /if \(order\.source === 'admin_external'\) return true/);
});

test('열린 직원 작업보드는 같은 작업의 구매제출만 자동 갱신하고 입력 중에는 미룬다', () => {
  const workdesk = read('../frontend/workdesk.html');
  const trackb = read('src/routes/trackB.routes.js');
  const sse = read('src/utils/sse.js');
  assert.match(trackb, /router\.get\('\/events', authMiddleware, internalMiddleware/);
  assert.match(trackb, /addSseClient\(req, res, \{ role: 'workdesk' \}\)/);
  assert.match(sse, /function emitOrderSubmit[\s\S]*?role === 'admin' \|\| role === 'workdesk'/);
  assert.match(workdesk, /\/api\/trackb\/events\?token=/);
  assert.doesNotMatch(workdesk, /\/api\/diag\/events\?token=/);
  assert.match(workdesk, /addEventListener\('order_submit'/);
  assert.match(workdesk, /String\(data\.sheetId\|\|''\).*String\(t\.sheetId\|\|''\)/);
  assert.match(workdesk, /String\(data\.tabName\|\|''\).*String\(t\.tabName\|\|''\)/);
  assert.match(workdesk, /_wbOrderEditing\(\)/);
  assert.match(workdesk, /querySelector\('\.sheetgrid td\.gedit input\.einp, #wdDatePick'\)/);
  assert.doesNotMatch(workdesk, /function _wbOrderEditing\(\)\{[\s\S]{0,160}document\.activeElement/);
  assert.match(workdesk, /document\.visibilityState!=='visible'/);
  assert.match(workdesk, /_wbOrderLiveSchedule\(data,1800,!!data\.queued\)/);
  assert.match(workdesk, /_wbOrderReloadIfCurrent\(key, version, sessionToken\)[\s\S]*?await api\('\/api\/trackb\/workdesk\?'\+q,[\s\S]*?_wbOrderLiveVersion!==version\|\|token\(\)!==sessionToken[\s\S]*?renderWorkdesk\(data\)/);
  assert.match(workdesk, /function logout\(\)\{[\s\S]*?_wbOrderLiveStop\(\)/);
  assert.match(workdesk, /_wbOrderLiveVersion!==version\|\|_wbOrderCurrentKey\(STATE\.cur\)!==key/);
  assert.match(workdesk, /_wbOrderLiveBusyVersion===version/);
  assert.match(workdesk, /_wbOrderLiveSchedule\(data,0,false\),35000/);
  assert.match(workdesk, /\['master','admin','staff'\]\.includes\(STATE\.role\)/);
  assert.doesNotMatch(workdesk, /\['master','admin','staff','advertiser'\]/);
});

test('구매제출 알림은 관리자와 직원 작업보드에만 전달한다', () => {
  const sse = require('../src/utils/sse');
  const makeClient = role => {
    const req = new EventEmitter();
    req.ip = '127.0.0.1';
    const writes = [];
    const res = { writeHead() {}, write(v) { writes.push(String(v)); }, end() {} };
    sse.addClient(req, res, { role });
    return { req, writes };
  };
  const admin = makeClient('admin');
  const workdesk = makeClient('workdesk');
  const reviewer = makeClient('reviewer');
  try {
    sse.emitOrderSubmit({ sheetId: 'S1', tabName: 'T1', orderer: '테스트' });
    assert.ok(admin.writes.some(v => v.includes('event: order_submit')));
    assert.ok(workdesk.writes.some(v => v.includes('event: order_submit')));
    assert.ok(!reviewer.writes.some(v => v.includes('event: order_submit')));
  } finally {
    admin.req.emit('close');
    workdesk.req.emit('close');
    reviewer.req.emit('close');
  }
});

test('참여형 구매 알림은 요청의 빈 좌표가 아니라 서버가 확정한 작업표를 사용한다', () => {
  const submit = read('src/routes/submit.routes.js');
  assert.match(submit, /const liveWorktable = captureTarget \|\| orderScope;/);
  assert.match(submit, /emitOrderSubmit\(\{[\s\S]*?tabName: liveWorktable\.tabName, sheetId: liveWorktable\.sheetId,[\s\S]*?workboardId: liveWorktable\.workboardId \|\| null/);
  assert.doesNotMatch(submit, /emitOrderSubmit\(\{\s*tabName, sheetId,/);
});
