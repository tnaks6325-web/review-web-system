'use strict';
/* 결정 271 → 274 — 시트 시절 정리: 시트 타입 큐는 실행부도 넣는 곳도 없다. 큐 워커·매시 복구는 작업보드 반영만 본다.
 *
 * 진짜 SQL 로 고정한다(pglite — server 의존성이라 npm test 에서도 그대로 돈다):
 *  A. 주문 취소 서비스 — **어느 좌표든**(`campaign:*` · 무시트 탭 · 이름이 바뀐 무시트 탭 · 남은 시트 기반 탭)
 *     order_cancel 을 넣지 않고 mirror_status='canceled' 로 끝난다(점유 기록 보존 = 시트 비우기 성공 때와 같은 상태).
 *     결정 274: 시트 기반 탭도 같은 길(종전엔 order_cancel 1건). 같은 주문의 시트 시절 잔여 큐 행은 지우지 않는다(기록).
 *  B. 비정상로그 [취소 처리] — 같은 규칙(ORDER_LEDGER_WRITE_ENABLED=true 여도 큐 없음 · 시트 탭 포함).
 *  C. 30초 워커·즉시 펌프(processQueue) — `ORDER_BATCH_AUTO` 값과 무관하게 작업보드 반영 타입만 집고,
 *     시트 타입 행은 pending 그대로(attempts·processed_at 무변경). 결정 274 로 그 스위치는 읽지 않는다.
 *  D. 매시 retryAllFailed — 작업보드 반영 타입만 되살린다. 시트 타입 failed·정체 processing·소진 pending 은 그대로.
 *  E. 분류 단일 출처 — _executeItem 의 모든 case 는 DB_ONLY 이고, src 어디에도 SHEET 타입을 넣는 곳이 없다.
 *  F. 주문별 드레인(drainOrderQueue) — 같은 주문의 시트 시절 잔여 행(order_cancel·order_append)을 집지 않는다.
 *  G. 수동 retryItem — 시트 타입 실패 행은 되살리지 않는다(거부 · 행 무변경).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

const SRC = path.join(__dirname, '../src');
const stub = (rel, exportsObj) => {
  const p = require.resolve(path.join(SRC, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
};

(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE sync_queue(id serial PRIMARY KEY, type text, payload jsonb, status text, attempts int DEFAULT 0,
      max_retry int DEFAULT 3, error_msg text, created_at timestamptz DEFAULT now(), processed_at timestamptz);
    CREATE TABLE order_submissions(id uuid PRIMARY KEY, deleted_at timestamptz, canceled_by text, updated_at timestamptz,
      sheet_row int, mirror_status text, sheet_id text, tab_name text, tab_gid text, gid text, dedup_key text,
      orderer text, recipient text, phone text, address text);
    CREATE TABLE tab_configs(sheet_id text, tab_name text, tab_gid text, sheetless boolean DEFAULT false);
    CREATE TABLE sheet_row_claims(id serial, order_id uuid);
    CREATE TABLE review_reminder_states(order_submission_id uuid, review_status text, updated_at timestamptz);
    CREATE TABLE campaign_applications(id serial, campaign_id text, status text, submitted_at timestamptz,
      order_submission_id uuid, late_order_id uuid);
    CREATE TABLE reviewer_event_logs(id int, event_type text, order_submission_id uuid, resolved_at timestamptz, resolved_by text);
    INSERT INTO tab_configs VALUES ('wt_aaaaaaaaaaaaaaaaaaaa', '무시트작업', '11', true);
    INSERT INTO tab_configs VALUES ('wt_bbbbbbbbbbbbbbbbbbbb', '새이름', '22', true);
    INSERT INTO tab_configs VALUES ('1RealGoogleSheetIdXXXXXXXXXXXXXXXXXXXXXXXXX', '시트작업', '33', false);
  `);
  const q = async (sql, params) => {
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
  };
  let intercept = null;           // C: AUTO=1 의 클레임 SQL 만 들여다보고 실행은 막는다
  const pool = {
    query: (sql, params) => (intercept && intercept(sql, params)) || q(sql, params),
    connect: async () => ({ query: (sql, params) => q(sql, params), release() {} }),
  };
  stub('db/pool.js', pool);
  const pumpKicks = [];
  stub('jobs/queuePump.js', { kickQueuePump: () => pumpKicks.push(1) });
  stub('utils/sse.js', { emitOrderLedger() {} });
  const wbCalls = [];
  stub('services/workboardQueueApply.service.js', {
    applyQueuedWorkboardOrder: async (p) => { wbCalls.push(p); return { ok: true }; },
    applyLegacyRecoveryOrder: async (p) => { wbCalls.push(p); return { ok: true }; },
  });

  const { cancelOrderSubmission } = require('../src/services/orderCancellation.service');
  const relog = require('../src/services/reviewerEventLog.service');
  relog.__setPoolForTest(pool);
  const sq = require('../src/services/syncQueue.service');

  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };
  let n = 0;
  const newOrder = async (o) => {
    n++;
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    await db.query(
      `INSERT INTO order_submissions(id, sheet_row, mirror_status, sheet_id, tab_name, tab_gid, gid)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, o.sheetRow === undefined ? 5 : o.sheetRow, o.status || 'written', o.sheetId, o.tabName, o.tabGid || null, o.gid || null]);
    await db.query(`INSERT INTO sheet_row_claims(order_id) VALUES ($1)`, [id]);
    return id;
  };
  const cancelRows = async (id) => (await db.query(
    `SELECT id FROM sync_queue WHERE type='order_cancel' AND payload->>'orderSubmissionId'=$1`, [id])).rows.length;
  const status = async (id) => (await db.query(`SELECT mirror_status, deleted_at FROM order_submissions WHERE id=$1`, [id])).rows[0];
  const claims = async (id) => (await db.query(`SELECT 1 FROM sheet_row_claims WHERE order_id=$1`, [id])).rows.length;

  // ═══ A. 주문 취소 서비스 ═══
  await t('A1 참여형 좌표(campaign:*) 반영 주문 취소 → order_cancel 없음 · canceled · 점유 보존', async () => {
    const id = await newOrder({ sheetId: 'campaign:42', tabName: 'campaign:42' });
    const out = await cancelOrderSubmission({ orderSubmissionId: id, canceledBy: 'tester' });
    assert.equal(out.ok, true); assert.equal(out.cleared, false, '시트 비우는 중이라고 말하지 않는다');
    assert.equal(await cancelRows(id), 0, '무시트 취소는 시트 큐에 들어가지 않는다');
    const s = await status(id);
    assert.equal(s.mirror_status, 'canceled'); assert.ok(s.deleted_at);
    assert.equal(await claims(id), 1, '시트 비우기 성공 때와 같은 상태 — 점유 기록은 지우지 않는다');
  });
  await t('A2 무시트 탭(wt_) 반영 주문 취소 → order_cancel 없음 · canceled', async () => {
    const id = await newOrder({ sheetId: 'wt_aaaaaaaaaaaaaaaaaaaa', tabName: '무시트작업', tabGid: '11' });
    const out = await cancelOrderSubmission({ orderSubmissionId: id });
    assert.equal(out.cleared, false);
    assert.equal(await cancelRows(id), 0);
    assert.equal((await status(id)).mirror_status, 'canceled');
  });
  await t('A3 이름이 바뀐 무시트 탭 — gid 로 알아본다(sheetlessScope 폴백 그대로)', async () => {
    const id = await newOrder({ sheetId: 'wt_bbbbbbbbbbbbbbbbbbbb', tabName: '옛이름', tabGid: '22' });
    await cancelOrderSubmission({ orderSubmissionId: id });
    assert.equal(await cancelRows(id), 0);
    assert.equal((await status(id)).mirror_status, 'canceled');
  });
  await t('A4 ★ 시트 기반 탭 반영 주문 취소 → order_cancel 없음 · canceled · 점유 보존 · 펌프 안 깨움(결정 274)', async () => {
    pumpKicks.length = 0;
    const id = await newOrder({ sheetId: '1RealGoogleSheetIdXXXXXXXXXXXXXXXXXXXXXXXXX', tabName: '시트작업', tabGid: '33' });
    const out = await cancelOrderSubmission({ orderSubmissionId: id });
    assert.equal(out.ok, true);
    assert.equal(out.cleared, false, '시트 비우는 중이라고 말하지 않는다');
    assert.equal(await cancelRows(id), 0, '시트 탭도 시트 큐에 들어가지 않는다');
    assert.equal((await status(id)).mirror_status, 'canceled', '큐 없이 바로 canceled');
    assert.equal(await claims(id), 1, '점유 기록은 지우지 않는다(R13)');
    assert.equal(pumpKicks.length, 0, '넣은 큐가 없으니 펌프도 안 깨운다');
  });
  await t('A4b 같은 주문의 시트 시절 잔여 큐 행(pending order_append)은 취소해도 지우지 않는다(기록)', async () => {
    const id = await newOrder({ sheetId: '1RealGoogleSheetIdXXXXXXXXXXXXXXXXXXXXXXXXX', tabName: '시트작업', tabGid: '33', status: 'queued' });
    await db.query(`INSERT INTO sync_queue(type, payload, status) VALUES ('order_append', $1, 'pending')`, [JSON.stringify({ orderSubmissionId: id })]);
    await cancelOrderSubmission({ orderSubmissionId: id });
    const left = (await db.query(`SELECT status, attempts FROM sync_queue WHERE type='order_append' AND payload->>'orderSubmissionId'=$1`, [id])).rows;
    assert.deepEqual(left, [{ status: 'pending', attempts: 0 }]);
    assert.equal((await status(id)).mirror_status, 'canceled');
  });
  await t('A5 미반영 무시트 주문 — 종전 else 경로 그대로(점유 삭제 · canceled)', async () => {
    const id = await newOrder({ sheetId: 'campaign:43', tabName: 'campaign:43', status: 'failed', sheetRow: null });
    await cancelOrderSubmission({ orderSubmissionId: id });
    assert.equal(await cancelRows(id), 0);
    assert.equal((await status(id)).mirror_status, 'canceled');
    assert.equal(await claims(id), 0);
  });

  // ═══ B. 비정상로그 [취소 처리] ═══
  process.env.ORDER_LEDGER_WRITE_ENABLED = 'true';
  await t('B1 무시트 주문 알림 [취소 처리] → order_cancel 없음 · canceled', async () => {
    const id = await newOrder({ sheetId: 'campaign:44', tabName: 'campaign:44', status: 'failed' });
    await db.query(`INSERT INTO reviewer_event_logs VALUES (101, 'order_unmirrored', $1, NULL, NULL)`, [id]);
    const out = await relog.cancelOrderFromEvent({ id: 101, by: '만두' });
    assert.equal(out.ok, true); assert.equal(out.canceled, true);
    assert.equal(await cancelRows(id), 0);
    assert.equal((await status(id)).mirror_status, 'canceled');
  });
  await t('B2 ★ 시트 기반 탭 주문 알림 [취소 처리] → order_cancel 없음 · canceled(결정 274)', async () => {
    const id = await newOrder({ sheetId: '1RealGoogleSheetIdXXXXXXXXXXXXXXXXXXXXXXXXX', tabName: '시트작업' });
    await db.query(`INSERT INTO reviewer_event_logs VALUES (102, 'order_lost', $1, NULL, NULL)`, [id]);
    const out = await relog.cancelOrderFromEvent({ id: 102 });
    assert.equal(out.ok, true); assert.equal(out.canceled, true);
    assert.equal(await cancelRows(id), 0);
    assert.equal((await status(id)).mirror_status, 'canceled');
  });
  delete process.env.ORDER_LEDGER_WRITE_ENABLED;

  // ═══ C. 30초 워커·즉시 펌프 ═══
  await db.exec(`DELETE FROM sync_queue`);
  const SHEET_TYPES = ['order_append', 'order_update', 'order_cancel', 'review_submit', 'sheet_write', 'participant_mirror'];
  for (const ty of SHEET_TYPES) {
    await db.query(`INSERT INTO sync_queue(type, payload, status) VALUES ($1, '{}', 'pending')`, [ty]);
  }
  await db.query(`INSERT INTO sync_queue(type, payload, status) VALUES ('workboard_apply', $1, 'pending')`,
    [JSON.stringify({ sheetId: 'wt_aaaaaaaaaaaaaaaaaaaa', tabName: '무시트작업', orderSubmissionId: 'x' })]);
  const untouchedSheetRows = async () => (await db.query(
    `SELECT type FROM sync_queue WHERE type = ANY($1::text[]) AND status='pending' AND attempts=0 AND processed_at IS NULL`,
    [SHEET_TYPES])).rows.length;

  await t('C1 작업보드 반영만 처리 · 시트 타입 6건은 손대지 않음', async () => {
    delete process.env.ORDER_BATCH_AUTO;
    assert.equal(sq.sheetQueueTypesEnabled, undefined, 'ORDER_BATCH_AUTO 스위치 함수는 없다(결정 274)');
    const r = await sq.processQueue(50, { interItemDelayMs: 0 });
    assert.equal(r.processed, 1); assert.equal(r.succeeded, 1);
    assert.equal(wbCalls.length, 1, 'workboard_apply 는 그대로 처리된다(라이브 경로)');
    assert.equal((await db.query(`SELECT status FROM sync_queue WHERE type='workboard_apply'`)).rows[0].status, 'done');
    assert.equal(await untouchedSheetRows(), SHEET_TYPES.length, '시트 타입은 pending · attempts 0 · processed_at 없음 그대로');
  });
  await t('C2 onlyType=order_append → 아무것도 집지 않음', async () => {
    const r = await sq.processQueue(5, { onlyType: 'order_append' });
    assert.equal(r.processed, 0);
    assert.equal(await untouchedSheetRows(), SHEET_TYPES.length);
  });
  await t('C3 ★ ORDER_BATCH_AUTO=1 이어도 작업보드 반영 타입만 집는다(스위치를 읽지 않는다 — 결정 274)', async () => {
    process.env.ORDER_BATCH_AUTO = '1';
    let claimSql = null, claimParams = null;
    intercept = (sql, params) => {
      if (/UPDATE sync_queue SET status = 'processing'/.test(sql)) { claimSql = String(sql); claimParams = params; }
      return null;   // 실제로도 실행해 본다
    };
    let r;
    try { r = await sq.processQueue(10, { interItemDelayMs: 0 }); } finally { intercept = null; delete process.env.ORDER_BATCH_AUTO; }
    assert.ok(claimSql, '클레임 SQL 이 나가야 한다');
    assert.ok(/AND type = ANY\(\$2::text\[\]\)/.test(claimSql), '타입 허용목록이 언제나 붙는다');
    assert.deepEqual([...claimParams[1]].sort(), [...sq.DB_ONLY_QUEUE_TYPES].sort(), '허용목록 = DB_ONLY 만');
    assert.equal(r.processed, 0, '남은 작업보드 반영이 없으니 처리 0');
    assert.equal(await untouchedSheetRows(), SHEET_TYPES.length, 'AUTO=1 이어도 시트 타입은 그대로');
  });

  // ═══ D. 매시 retryAllFailed ═══
  await db.exec(`DELETE FROM sync_queue`);
  await db.exec(`
    INSERT INTO sync_queue(type, payload, status, attempts, error_msg, processed_at) VALUES
      ('order_append','{}','failed',3,'RAW 미러 헤더 메타를 찾을 수 없음', now()),
      ('review_submit','{}','failed',3,'boom', now()),
      ('sheet_write','{}','failed',3,'boom', now()),
      ('order_cancel','{}','failed',3,'RAW 메타 없음', now()),
      ('order_update','{}','processing',1,NULL, now() - interval '90 days'),
      ('order_append','{}','processing',1,NULL, now() - interval '90 days'),
      ('order_append','{}','pending',3,'exhausted', now()),
      ('workboard_apply','{}','failed',3,'작업보드 반영 실패', now()),
      ('workboard_legacy_apply','{}','failed',3,'x', now()),
      ('workboard_apply','{}','processing',1,NULL, now() - interval '1 hour'),
      ('workboard_apply','{}','pending',3,'exhausted', now());
  `);
  const before = (await db.query(`SELECT id, type, status, attempts, error_msg, processed_at FROM sync_queue WHERE type NOT LIKE 'workboard%' ORDER BY id`)).rows;
  await t('D1 작업보드 반영 타입만 되살린다(failed 2 · 정체 processing 1 · 소진 pending 1)', async () => {
    const r = await sq.retryAllFailed();
    assert.deepEqual({ retried: r.retried, unstuck: r.unstuck, resetExhausted: r.resetExhausted },
      { retried: 2, unstuck: 1, resetExhausted: 1 });
    const wb = (await db.query(`SELECT status, attempts FROM sync_queue WHERE type LIKE 'workboard%'`)).rows;
    assert.ok(wb.every(x => x.status === 'pending' && x.attempts === 0), '작업보드 반영 행은 전부 다시 대기');
  });
  await t('D2 시트 타입 실패·정체·소진 행은 한 글자도 바뀌지 않는다(기록으로 보존)', async () => {
    const after = (await db.query(`SELECT id, type, status, attempts, error_msg, processed_at FROM sync_queue WHERE type NOT LIKE 'workboard%' ORDER BY id`)).rows;
    assert.deepEqual(after, before);
  });

  // ═══ E. 분류 단일 출처 ═══
  await t('E1 _executeItem 의 모든 case 는 DB_ONLY · src 어디에도 SHEET 타입을 큐에 넣는 곳이 없다', async () => {
    const all = new Set([...sq.DB_ONLY_QUEUE_TYPES, ...sq.SHEET_QUEUE_TYPES]);
    assert.equal(all.size, sq.DB_ONLY_QUEUE_TYPES.length + sq.SHEET_QUEUE_TYPES.length, '두 목록은 겹치지 않는다');
    const src = fs.readFileSync(path.join(SRC, 'services/syncQueue.service.js'), 'utf8');
    const body = src.slice(src.indexOf('async function _executeItem'), src.indexOf('async function retryItem'));
    const cases = [...body.matchAll(/case '([a-z_]+)':/g)].map(m => m[1]);
    assert.ok(cases.length >= 3, '실행부 case 를 찾았다');
    for (const c of cases) assert.ok(sq.DB_ONLY_QUEUE_TYPES.includes(c), `실행부 타입 '${c}' 가 DB_ONLY 가 아니다 — 시트 실행부가 되살아났다`);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
    const enq = new Map();
    for (const f of walk(SRC)) {
      const s = fs.readFileSync(f, 'utf8');
      const add = (ty) => enq.set(ty, [...(enq.get(ty) || []), path.relative(SRC, f)]);
      for (const m of s.matchAll(/enqueue\('([a-z_]+)'/g)) add(m[1]);
      for (const m of s.matchAll(/INSERT INTO sync_queue[^;]*?VALUES \('([a-z_]+)'/g)) add(m[1]);
      for (const m of s.matchAll(/SET type = '([a-z_]+)'/g)) add(m[1]);
    }
    assert.ok(enq.has('workboard_apply'), '큐에 넣는 타입을 찾았다');
    for (const [ty, files] of enq) {
      assert.ok(all.has(ty), `큐에 넣는 타입 '${ty}' 가 분류되지 않았다`);
      assert.ok(!sq.SHEET_QUEUE_TYPES.includes(ty), `시트 타입 '${ty}' 를 다시 넣는 곳이 생겼다: ${files.join(', ')}`);
    }
    assert.deepEqual([...sq.DB_ONLY_QUEUE_TYPES].sort(), ['deposit_mark', 'workboard_apply', 'workboard_legacy_apply']);
  });

  // ═══ F. 주문별 드레인 — 시트 시절 잔여 행을 집지 않는다 ═══
  await t('F1 같은 주문의 잔여 order_cancel·order_append(pending) → 드레인이 집지 않음 · 행 무변경', async () => {
    const id = await newOrder({ sheetId: '1RealGoogleSheetIdXXXXXXXXXXXXXXXXXXXXXXXXX', tabName: '시트작업', tabGid: '33', status: 'queued' });
    for (const ty of ['order_cancel', 'order_append']) {
      await db.query(`INSERT INTO sync_queue(type, payload, status) VALUES ($1, $2, 'pending')`, [ty, JSON.stringify({ orderSubmissionId: id, sheetId: '1RealGoogleSheetIdXXXXXXXXXXXXXXXXXXXXXXXXX', tabName: '시트작업' })]);
    }
    process.env.ORDER_BATCH_AUTO = '1';
    let r;
    try { r = await sq.drainOrderQueue(id); } finally { delete process.env.ORDER_BATCH_AUTO; }
    assert.deepEqual(r, { processed: 0, succeeded: 0, failed: 0 });
    const rows = (await db.query(`SELECT status, attempts, processed_at FROM sync_queue WHERE payload->>'orderSubmissionId'=$1`, [id])).rows;
    assert.ok(rows.length === 2 && rows.every(x => x.status === 'pending' && x.attempts === 0 && x.processed_at === null), '잔여 행은 기록 그대로');
    assert.equal((await status(id)).mirror_status, 'queued', '주문 상태도 그대로');
  });
  await t('F2 같은 주문의 작업보드 반영은 드레인이 그대로 처리한다(라이브 경로 무회귀)', async () => {
    const id = await newOrder({ sheetId: 'wt_aaaaaaaaaaaaaaaaaaaa', tabName: '무시트작업', tabGid: '11', status: 'queued' });
    await db.query(`INSERT INTO sync_queue(type, payload, status) VALUES ('order_append', $1, 'pending')`, [JSON.stringify({ orderSubmissionId: id })]);
    await db.query(`INSERT INTO sync_queue(type, payload, status) VALUES ('workboard_apply', $1, 'pending')`, [JSON.stringify({ orderSubmissionId: id })]);
    const r = await sq.drainOrderQueue(id);
    assert.equal(r.processed, 1); assert.equal(r.succeeded, 1);
    const left = (await db.query(`SELECT type, status FROM sync_queue WHERE payload->>'orderSubmissionId'=$1 ORDER BY type`, [id])).rows;
    assert.deepEqual(left, [{ type: 'order_append', status: 'pending' }, { type: 'workboard_apply', status: 'done' }]);
  });

  // ═══ G. 수동 retryItem ═══
  await t('G1 시트 타입 실패 행은 retryItem 이 되살리지 않는다(거부 · 행 무변경) · 작업보드 반영은 되살린다', async () => {
    const { rows: [sheetRow] } = await db.query(`INSERT INTO sync_queue(type, payload, status, attempts, error_msg) VALUES ('order_update','{}','failed',3,'x') RETURNING id`);
    await assert.rejects(() => sq.retryItem(sheetRow.id), /작업보드 반영 타입만/);
    assert.deepEqual((await db.query(`SELECT status, attempts, error_msg FROM sync_queue WHERE id=$1`, [sheetRow.id])).rows[0],
      { status: 'failed', attempts: 3, error_msg: 'x' });
    const { rows: [wbRow] } = await db.query(`INSERT INTO sync_queue(type, payload, status, attempts, error_msg) VALUES ('workboard_apply','{}','failed',3,'x') RETURNING id`);
    const out = await sq.retryItem(wbRow.id);
    assert.equal(out.type, 'workboard_apply');
    assert.equal((await db.query(`SELECT status FROM sync_queue WHERE id=$1`, [wbRow.id])).rows[0].status, 'pending');
  });

  console.log(`\n✅ syncQueueSheetTypesGate: ${passed}/${passed}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
