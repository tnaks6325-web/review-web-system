'use strict';
/* 결정 271 — 시트 시절 정리 1단계: 무시트 취소는 시트 큐를 타지 않고, 큐 워커·매시 복구는 작업보드 반영만 본다.
 *
 * 진짜 SQL 로 고정한다(pglite — server 의존성이라 npm test 에서도 그대로 돈다):
 *  A. 주문 취소 서비스 — 무시트 좌표(`campaign:*` · 무시트 탭 · 이름이 바뀐 무시트 탭의 gid)는
 *     order_cancel 을 넣지 않고 mirror_status='canceled' 로 끝난다(점유 기록 보존 = 시트 비우기 성공 때와 같은 상태).
 *     시트 기반 탭은 종전 그대로 order_cancel 을 넣는다.
 *  B. 비정상로그 [취소 처리] — 같은 판정(ORDER_LEDGER_WRITE_ENABLED=true 여도 무시트면 큐 없음).
 *  C. 30초 워커·즉시 펌프(processQueue) — ORDER_BATCH_AUTO 가 꺼져 있으면 작업보드 반영 타입만 집고,
 *     시트 타입 행은 pending 그대로(attempts·processed_at 무변경). 켜져 있으면 시트 타입 전부를 집는다
 *     (결정 273: order_append 를 전담하던 배치 스케줄러를 지워 단건 워커가 order_append 까지 맡는다).
 *  D. 매시 retryAllFailed — 작업보드 반영 타입만 되살린다. 시트 타입 failed·정체 processing·소진 pending 은 그대로.
 *  E. 분류 단일 출처 — _executeItem 의 모든 case 와 enqueue 되는 모든 타입이 DB_ONLY/SHEET 둘 중 하나에 있다.
 *  F. order_cancel 실행부 백스톱 — 무시트 좌표면 시트를 읽지 않고 canceled 로 끝난다(배포 중 구버전이 넣은 것 대비).
 *  G. order_append 실행부 백스톱(결정 273 — 배치 경로에서 단건 경로로 옮김) — 무시트 탭이면 RAW 메타·시트를 읽지 않고
 *     done + 사유로 끝난다(AUTO=1 로 되돌려도 무시트 작업의 옛 시트에 다시 쓰지 않는다).
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
  await t('A4 시트 기반 탭 반영 주문 취소 → 종전 그대로 order_cancel 대기 1건 · 상태는 큐가 바꾼다', async () => {
    pumpKicks.length = 0;
    const id = await newOrder({ sheetId: '1RealGoogleSheetIdXXXXXXXXXXXXXXXXXXXXXXXXX', tabName: '시트작업', tabGid: '33' });
    const out = await cancelOrderSubmission({ orderSubmissionId: id });
    assert.equal(out.cleared, true);
    assert.equal(await cancelRows(id), 1);
    assert.equal((await status(id)).mirror_status, 'written', '시트를 비운 뒤에 큐가 canceled 로 바꾼다');
    assert.equal(pumpKicks.length, 1, '시트 큐를 넣었을 때만 펌프를 깨운다');
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
  await t('B2 시트 기반 탭 주문 알림 [취소 처리] → 종전 그대로 order_cancel 대기', async () => {
    const id = await newOrder({ sheetId: '1RealGoogleSheetIdXXXXXXXXXXXXXXXXXXXXXXXXX', tabName: '시트작업' });
    await db.query(`INSERT INTO reviewer_event_logs VALUES (102, 'order_lost', $1, NULL, NULL)`, [id]);
    await relog.cancelOrderFromEvent({ id: 102 });
    assert.equal(await cancelRows(id), 1);
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

  await t('C1 ORDER_BATCH_AUTO 꺼짐 → 작업보드 반영만 처리 · 시트 타입 6건은 손대지 않음', async () => {
    delete process.env.ORDER_BATCH_AUTO;
    assert.equal(sq.sheetQueueTypesEnabled(), false);
    const r = await sq.processQueue(50, { interItemDelayMs: 0 });
    assert.equal(r.processed, 1); assert.equal(r.succeeded, 1);
    assert.equal(wbCalls.length, 1, 'workboard_apply 는 그대로 처리된다(라이브 경로)');
    assert.equal((await db.query(`SELECT status FROM sync_queue WHERE type='workboard_apply'`)).rows[0].status, 'done');
    assert.equal(await untouchedSheetRows(), SHEET_TYPES.length, '시트 타입은 pending · attempts 0 · processed_at 없음 그대로');
  });
  await t('C2 꺼짐 + onlyType=order_append(하트비트 백스톱) → 아무것도 집지 않음', async () => {
    const r = await sq.processQueue(5, { onlyType: 'order_append' });
    assert.equal(r.processed, 0);
    assert.equal(await untouchedSheetRows(), SHEET_TYPES.length);
  });
  await t('C3 ORDER_BATCH_AUTO=1 → 시트 타입 전부(order_append 포함 · 타입 허용목록 없음 — 결정 273)', async () => {
    process.env.ORDER_BATCH_AUTO = '1';
    let claimSql = null;
    intercept = (sql) => {
      if (/UPDATE sync_queue SET status = 'processing'/.test(sql)) { claimSql = String(sql); return Promise.resolve({ rows: [] }); }
      return null;
    };
    try { await sq.processQueue(10, { interItemDelayMs: 0 }); } finally { intercept = null; delete process.env.ORDER_BATCH_AUTO; }
    assert.ok(claimSql, '클레임 SQL 이 나가야 한다');
    assert.ok(!/order_append/.test(claimSql), 'AUTO=1 에서 order_append 를 빼면 이제 아무도 처리하지 않는다(배치 스케줄러 삭제)');
    assert.ok(!/ANY\(\$2::text\[\]\)/.test(claimSql), 'AUTO=1 에서는 시트 타입도 집는다');
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
  await t('E1 _executeItem 의 모든 case · 모든 enqueue 타입이 DB_ONLY/SHEET 중 정확히 하나에 있다', async () => {
    const all = new Set([...sq.DB_ONLY_QUEUE_TYPES, ...sq.SHEET_QUEUE_TYPES]);
    assert.equal(all.size, sq.DB_ONLY_QUEUE_TYPES.length + sq.SHEET_QUEUE_TYPES.length, '두 목록은 겹치지 않는다');
    const src = fs.readFileSync(path.join(SRC, 'services/syncQueue.service.js'), 'utf8');
    const body = src.slice(src.indexOf('async function _executeItem'), src.indexOf('async function _setPStatus'));
    const cases = [...body.matchAll(/case '([a-z_]+)':/g)].map(m => m[1]);
    assert.ok(cases.length >= 10, '실행부 case 를 찾았다');
    for (const c of cases) assert.ok(all.has(c), `실행부 타입 '${c}' 가 분류되지 않았다 — DB_ONLY/SHEET 에 넣어라`);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
    const enq = new Set();
    for (const f of walk(SRC)) {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(/enqueue\('([a-z_]+)'/g)) enq.add(m[1]);
      for (const m of s.matchAll(/INSERT INTO sync_queue[^;]*?VALUES \('([a-z_]+)'/g)) enq.add(m[1]);
      for (const m of s.matchAll(/SET type = '([a-z_]+)'/g)) enq.add(m[1]);
    }
    assert.ok(enq.has('workboard_apply') && enq.has('order_cancel'), '큐에 넣는 타입을 찾았다');
    for (const ty of enq) assert.ok(all.has(ty), `큐에 넣는 타입 '${ty}' 가 분류되지 않았다`);
    assert.deepEqual([...sq.DB_ONLY_QUEUE_TYPES].sort(), ['deposit_mark', 'workboard_apply', 'workboard_legacy_apply']);
  });

  // ═══ F. order_cancel 실행부 백스톱 ═══
  await t('F1 무시트 좌표 order_cancel(구버전이 넣은 것) → 시트를 읽지 않고 canceled · 큐 done', async () => {
    const id = await newOrder({ sheetId: 'campaign:45', tabName: 'campaign:45' });
    await db.query(`UPDATE order_submissions SET deleted_at = now() WHERE id=$1`, [id]);
    await db.query(`INSERT INTO sync_queue(type, payload, status) VALUES ('order_cancel', $1, 'pending')`,
      [JSON.stringify({ orderSubmissionId: id })]);
    const r = await sq.drainOrderQueue(id);
    assert.equal(r.succeeded, 1, 'raw_sheet_* 표가 없는데도 성공 = 시트 메타를 읽지 않았다');
    assert.equal((await status(id)).mirror_status, 'canceled');
  });

  // ═══ G. order_append 실행부 백스톱(결정 273) ═══
  await t('G1 AUTO=1 · 무시트 탭 order_append → RAW 메타·시트를 읽지 않고 done + 사유(주문은 그대로)', async () => {
    const id = await newOrder({ sheetId: 'wt_aaaaaaaaaaaaaaaaaaaa', tabName: '무시트작업', tabGid: '11', status: 'queued' });
    await db.query(`INSERT INTO sync_queue(type, payload, status) VALUES ('order_append', $1, 'pending')`,
      [JSON.stringify({ sheetId: 'wt_aaaaaaaaaaaaaaaaaaaa', tabName: '무시트작업', gid: '11', sheetRow: 5, orderSubmissionId: id })]);
    process.env.ORDER_BATCH_AUTO = '1';
    let r;
    try { r = await sq.drainOrderQueue(id); } finally { delete process.env.ORDER_BATCH_AUTO; }
    assert.equal(r.succeeded, 1, 'raw_sheet_* 표가 없는데도 성공 = RAW 메타(→ 자동 미러 → 구글)를 부르지 않았다');
    const row = (await db.query(`SELECT status, error_msg FROM sync_queue WHERE type='order_append' AND payload->>'orderSubmissionId'=$1`, [id])).rows[0];
    assert.equal(row.status, 'done');
    assert.ok(/sheetless tab — 시트 쓰기 생략/.test(row.error_msg || ''), '사유를 남긴다(무신호 금지)');
    assert.equal((await status(id)).mirror_status, 'queued', '주문 상태는 무시트 기록 경로가 정한다 — 큐가 건드리지 않는다');
  });
  await t('G2 시트 기반 탭 order_append 는 백스톱을 지나 종전 실행부로 간다(여기선 RAW 메타가 없어 재시도 대기)', async () => {
    const id = await newOrder({ sheetId: '1RealGoogleSheetIdXXXXXXXXXXXXXXXXXXXXXXXXX', tabName: '시트작업', tabGid: '33', status: 'queued' });
    await db.query(`INSERT INTO sync_queue(type, payload, status) VALUES ('order_append', $1, 'pending')`,
      [JSON.stringify({ sheetId: '1RealGoogleSheetIdXXXXXXXXXXXXXXXXXXXXXXXXX', tabName: '시트작업', gid: '33', sheetRow: 5, orderSubmissionId: id })]);
    const r = await sq.drainOrderQueue(id);
    assert.equal(r.succeeded, 0);
    const row = (await db.query(`SELECT status, error_msg FROM sync_queue WHERE type='order_append' AND payload->>'orderSubmissionId'=$1`, [id])).rows[0];
    assert.ok(!/sheetless tab/.test(row.error_msg || ''), '시트 기반 탭은 무시트 사유로 접히지 않는다');
  });

  console.log(`\n✅ syncQueueSheetTypesGate: ${passed}/${passed}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
