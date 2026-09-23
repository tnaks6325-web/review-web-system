'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sessionSvc = require('../src/services/purchaseSubmissionSession.service');

const root = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

function issueDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ id: SESSION_ID, orderSubmissionId: ORDER_ID, expiresAt: new Date(Date.now() + 3600000) }] };
    },
  };
}

function inspectDb(row) {
  return { query: async () => ({ rows: row ? [row] : [] }) };
}

function completeDb({ existing = '' } = {}) {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (/SELECT ps\.id/.test(sql)) return { rows: [{ id: SESSION_ID, orderFileId: existing }] };
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  return { calls, connect: async () => client };
}

(async () => {
  console.log('\n[A] 제출 세션 발급');
  await t('토큰 원문은 DB에 저장하지 않고 SHA-256 해시만 저장한다', async () => {
    const db = issueDb(); sessionSvc.__setPoolForTest(db);
    const out = await sessionSvc.issueForOrder({ orderSubmissionId: ORDER_ID, captureSheetId: 'wt-a', captureTabName: 'T' });
    assert.equal(out.id, SESSION_ID);
    assert.ok(out.token && out.token.length >= 40);
    assert.notEqual(db.calls[0].params[1], out.token);
    assert.equal(db.calls[0].params[1], sessionSvc._hash(out.token));
  });
  await t('세션은 살아 있는 주문에서만 INSERT SELECT로 발급된다', async () => {
    const db = issueDb(); sessionSvc.__setPoolForTest(db);
    await sessionSvc.issueForOrder({ orderSubmissionId: ORDER_ID });
    assert.match(db.calls[0].sql, /FROM order_submissions os/);
    assert.match(db.calls[0].sql, /os\.deleted_at IS NULL/);
  });

  console.log('\n[B] 업로드 입구 검증');
  await t('세션·토큰·주문ID 중 하나라도 없으면 Drive 전에 거부한다', async () => {
    assert.equal((await sessionSvc.inspectForUpload({ orderSubmissionId: ORDER_ID })).code, 'capture_session_required');
  });
  await t('위조 토큰 또는 다른 주문ID는 일치 행이 없어 거부한다', async () => {
    sessionSvc.__setPoolForTest(inspectDb(null));
    const out = await sessionSvc.inspectForUpload({ sessionId: SESSION_ID, sessionToken: 'bad', orderSubmissionId: ORDER_ID });
    assert.equal(out.code, 'capture_session_invalid');
  });
  await t('유효 세션은 서버에 고정된 작업 좌표만 반환한다', async () => {
    sessionSvc.__setPoolForTest(inspectDb({
      id: SESSION_ID, status: 'prepared', captureSheetId: 'wt-server', captureTabName: 'server-tab',
      sessionFileId: null, orderSubmissionId: ORDER_ID, orderFileId: null,
    }));
    const out = await sessionSvc.inspectForUpload({ sessionId: SESSION_ID, sessionToken: 'ok', orderSubmissionId: ORDER_ID });
    assert.equal(out.captureSheetId, 'wt-server');
    assert.equal(out.captureTabName, 'server-tab');
  });
  await t('이미 연결된 주문 재시도는 Drive 재업로드 없이 완료로 판정한다', async () => {
    sessionSvc.__setPoolForTest(inspectDb({
      id: SESSION_ID, captureSheetId: 's', captureTabName: 't', sessionFileId: null,
      orderSubmissionId: ORDER_ID, orderFileId: 'FILE-OLD',
    }));
    const out = await sessionSvc.inspectForUpload({ sessionId: SESSION_ID, sessionToken: 'ok', orderSubmissionId: ORDER_ID });
    assert.equal(out.alreadyCompleted, true); assert.equal(out.captureFileId, 'FILE-OLD');
  });
  await t('업로드 lease는 동시 실행을 막고 장시간 업로드 동안 만료를 연장한다', async () => {
    const calls = [];
    sessionSvc.__setPoolForTest({ query: async (sql) => { calls.push(String(sql)); return { rows: [{ id: SESSION_ID }] }; } });
    assert.equal(await sessionSvc.markUploading({ sessionId: SESSION_ID, orderSubmissionId: ORDER_ID }), true);
    assert.match(calls[0], /status <> 'uploading'/);
    assert.match(calls[0], /GREATEST\(expires_at, NOW\(\)\+INTERVAL '15 minutes'\)/);
  });

  console.log('\n[C] DB 확정·동시성');
  await t('주문 단위 advisory lock 뒤 주문과 세션을 같은 트랜잭션으로 완료한다', async () => {
    const db = completeDb(); sessionSvc.__setPoolForTest(db);
    const out = await sessionSvc.completeCapture({ sessionId: SESSION_ID, sessionToken: 'ok', orderSubmissionId: ORDER_ID, captureFileId: 'FILE-1' });
    assert.equal(out.ok, true);
    const joined = db.calls.map(x => x.sql).join('\n');
    assert.match(joined, /BEGIN/); assert.match(joined, /pg_advisory_xact_lock/);
    assert.match(joined, /UPDATE order_submissions/); assert.match(joined, /UPDATE purchase_submission_sessions/);
    assert.match(joined, /COMMIT/);
  });
  await t('동시 업로드에서 먼저 연결된 다른 파일을 덮어쓰지 않는다', async () => {
    const db = completeDb({ existing: 'FILE-FIRST' }); sessionSvc.__setPoolForTest(db);
    const out = await sessionSvc.completeCapture({ sessionId: SESSION_ID, sessionToken: 'ok', orderSubmissionId: ORDER_ID, captureFileId: 'FILE-LATE' });
    assert.equal(out.alreadyCompleted, true); assert.equal(out.captureFileId, 'FILE-FIRST');
    assert.ok(!db.calls.some(x => /UPDATE order_submissions/.test(x.sql)));
    assert.ok(db.calls.some(x => /ROLLBACK/.test(x.sql)));
  });

  console.log('\n[D] 구형·신규·외부·보완 경로 계약');
  const modern = read('frontend/js/search-app.js');
  const legacy = read('frontend/js/index-app.js');
  const manual = read('frontend/js/manual-order.js');
  const home = read('frontend/index.html');
  for (const [label, src] of [['신규', modern], ['구형', legacy], ['외부수동', manual], ['홈보완', home]]) {
    await t(`${label} 경로가 주문ID+세션ID+세션토큰을 함께 보낸다`, async () => {
      assert.match(src, /orderSubmissionId/);
      assert.match(src, /captureSessionId/);
      assert.match(src, /captureSessionToken/);
    });
  }
  await t('실시간 업로드 경로에서 이름·최근 24시간 폴백을 제거했다', async () => {
    const diag = read('server/src/routes/diag.routes.js');
    const a = diag.indexOf("router.post('/image-upload'");
    const b = diag.indexOf("router.post('/review-precheck'", a);
    const segment = diag.slice(a, b);
    assert.ok(!/최근 24h 동일 수취인|nameBase/.test(segment));
    assert.match(segment, /inspectForUpload/);
    assert.match(segment, /completeCapture/);
  });
  await t('캡처 폴더 저장 필드는 captureFolderUrl과 folderUrl을 모두 수용한다', async () => {
    const drive = read('server/src/routes/drive.routes.js');
    assert.match(drive, /req\.body\.folderUrl \|\| req\.body\.captureFolderUrl/);
  });
  await t('세션 테이블 마이그레이션 누락 시 운영 부팅을 차단한다', async () => {
    const boot = read('server/index.js');
    const requiredTables = (boot.match(/const REQUIRED_TABLES = \[([\s\S]*?)\];/) || [])[1] || '';
    assert.match(requiredTables, /'purchase_submission_sessions'/);
  });

  sessionSvc.__setPoolForTest(null);
  console.log(`\n✅ purchaseSubmissionSession: ${passed}개 통과`);
})().catch(err => { sessionSvc.__setPoolForTest(null); console.error('\n❌ ' + err.stack); process.exit(1); });
