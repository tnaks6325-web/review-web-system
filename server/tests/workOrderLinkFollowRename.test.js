'use strict';
/* 결정 325 — 작업 이름을 바꿀 때 리뷰오더 연결도 새 이름을 따라간다 · 총모집 0 리뷰오더는 막지 않고 이상로그 경고.
   ───────────────────────────────────────────────────────────────────────────
   사고 경로(운영 조사 2026-11-03): 탭 이름이 바뀌면 renameTabState 가 공고(recruit_campaigns)·장부는 옮기는데
   리뷰오더 연결 두 곳 — 직접 연결(work_orders.linked_tab_name)과 수동 발주 연결(trackb_work_order_links.tab_name) —
   은 옛 이름에 남았다. 그러면 「그 탭의 리뷰오더」 조회(workOrderForTabSql: 정원·작업 조건 카드·업체 화면 총건수)가
   새 이름으로 0건이 되어 총건수가 조용히 비고, 무시트 재접수는 옛 이름으로 탭을 다시 등록한다.

   ★ 인트라넷으로 흘러가지 않음: 이 이동은 sync_version·updated_at·shared_sync_outbox 를 건드리지 않는다
     (작업 삭제 workTabDelete 가 linked_tab_* 를 직접 비우는 것과 같은 "좌표 정리" 관례).
   실행: node tests/workOrderLinkFollowRename.test.js */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

(async () => {
  const db = new PGlite(); await db.waitReady;
  await db.exec(`
    CREATE TABLE work_orders (id TEXT PRIMARY KEY, title TEXT DEFAULT '', recruit_count INTEGER DEFAULT 0,
      linked_tab_sheet_id TEXT DEFAULT '', linked_tab_name TEXT DEFAULT '', linked_tab_gid TEXT DEFAULT '',
      sync_version BIGINT DEFAULT 7, updated_at TIMESTAMPTZ DEFAULT '2026-01-01T00:00:00Z',
      created_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ);
    CREATE TABLE shared_sync_outbox (id SERIAL PRIMARY KEY, work_order_id TEXT, sync_version BIGINT, view_scope TEXT);
    CREATE TABLE trackb_work_order_links (id BIGSERIAL PRIMARY KEY, sheet_id TEXT NOT NULL, tab_name TEXT NOT NULL,
      work_order_id TEXT NOT NULL, linked_by TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ);
    CREATE UNIQUE INDEX uq_trackb_wo_link_active ON trackb_work_order_links (sheet_id, tab_name) WHERE deleted_at IS NULL;
  `);
  const { renameTabState } = require('../src/services/tabRename.service');
  const { workOrderForTabSql } = require('../src/utils/workOrderLink');
  // 이 검사가 보는 두 표만 실 PG 로 보내고 나머지 원장 UPDATE 는 0건으로 흉내낸다(paymentHistoryRename 과 같은 방식).
  const REAL = /UPDATE (work_orders|trackb_work_order_links)\b/;
  const calls = [];
  const client = { query: async (sql, args) => {
    calls.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(String(sql).trim()) || REAL.test(sql)) return db.query(sql, args);
    return { rows: [], rowCount: 0 };
  }, release() {} };
  const pool = { connect: async () => client };
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];

  console.log('── A. 직접 연결(work_orders.linked_tab_name) ──');
  await db.exec(`
    INSERT INTO work_orders (id, linked_tab_sheet_id, linked_tab_name, linked_tab_gid, deleted_at) VALUES
      ('wo-g',     'S',  '옛이름', '111', NULL),
      ('wo-blank', 'S',  '옛이름', '',    NULL),
      ('wo-other', 'S',  '옛이름', '999', NULL),
      ('wo-s2',    'S2', '옛이름', '111', NULL),
      ('wo-del',   'S',  '옛이름', '111', '2026-10-01T00:00:00Z'),
      ('wo-keep',  'S',  '딴작업', '222', NULL);
    INSERT INTO trackb_work_order_links (sheet_id, tab_name, work_order_id, deleted_at) VALUES
      ('S',  '옛이름', 'wo-blank', NULL),
      ('S',  '옛이름', 'wo-g',     '2026-09-01T00:00:00Z'),
      ('S2', '옛이름', 'wo-s2',    NULL);
  `);
  const before = (await db.query('SELECT id, sync_version, updated_at FROM work_orders ORDER BY id')).rows;
  const r = await renameTabState(pool, { sheetId: 'S', oldTabName: '옛이름', newTabName: '새이름', tabGid: '111' });
  const name = async id => (await one('SELECT linked_tab_name n FROM work_orders WHERE id=$1', [id])).n;

  await t('같은 시트·옛 이름·같은 gid 오더는 새 이름으로 옮긴다', async () => assert.equal(await name('wo-g'), '새이름'));
  await t('gid 를 모르는 옛 오더(빈 gid)도 옮긴다', async () => assert.equal(await name('wo-blank'), '새이름'));
  await t('★ 다른 gid 로 적힌 오더는 다른 탭 것 — 건드리지 않는다', async () => assert.equal(await name('wo-other'), '옛이름'));
  await t('★ 다른 시트의 같은 이름 탭은 건드리지 않는다', async () => assert.equal(await name('wo-s2'), '옛이름'));
  await t('지운 오더도 옮긴다(「원본 오더 삭제됨」 표시가 새 이름에서도 보이게)', async () => assert.equal(await name('wo-del'), '새이름'));
  await t('무관한 작업은 그대로', async () => assert.equal(await name('wo-keep'), '딴작업'));
  await t('gid 칸은 바꾸지 않는다(이름만)', async () => {
    assert.equal((await one(`SELECT linked_tab_gid g FROM work_orders WHERE id='wo-blank'`)).g, '');
  });
  await t('★★ 인트라넷 전송 무접촉 — sync_version·updated_at 불변 · 전송 대기열 0', async () => {
    const after = (await db.query('SELECT id, sync_version, updated_at FROM work_orders ORDER BY id')).rows;
    assert.deepEqual(after, before);
    assert.equal((await one('SELECT count(*)::int n FROM shared_sync_outbox')).n, 0);
    assert(!calls.some(sql => /shared_sync_outbox|sync_version/.test(sql)), '이름 변경 SQL 에 전송 칸이 없어야 한다');
  });
  await t('결과에 옮긴 건수를 싣는다', async () => {
    assert.equal(r.workOrdersUpdated, 3);
    assert.equal(r.workOrderLinksUpdated, 2);
  });

  console.log('── B. 수동 발주 연결(trackb_work_order_links) ──');
  await t('활성 연결·지운 연결 모두 새 이름으로 · 다른 시트는 그대로', async () => {
    const rows = (await db.query('SELECT sheet_id s, tab_name n, work_order_id w, deleted_at IS NULL live FROM trackb_work_order_links ORDER BY id')).rows;
    assert.deepEqual(rows.map(x => [x.s, x.n, x.w, x.live]), [
      ['S', '새이름', 'wo-blank', true], ['S', '새이름', 'wo-g', false], ['S2', '옛이름', 'wo-s2', true]]);
  });
  await t('★ 새 이름으로 「그 탭의 리뷰오더」를 다시 찾는다(정원·작업 조건 카드·업체 총건수의 단일 출처)', async () => {
    const sql = workOrderForTabSql(['id']);
    assert.equal((await one(sql, ['S', '새이름'])).id, 'wo-blank'); // 수동 연결 우선
    // 옛 이름에는 다른 gid 로 적힌 오더(wo-other)만 남는다 — 이 탭의 오더는 더 이상 옛 이름으로 잡히지 않는다.
    assert.deepEqual((await db.query(sql, ['S', '옛이름'])).rows.map(x => x.id), ['wo-other']);
  });

  console.log('── C. 새 이름에 이미 활성 수동 연결이 있으면(드묾) — 충돌 없이 이름 변경은 끝난다 ──');
  await db.exec(`
    INSERT INTO trackb_work_order_links (sheet_id, tab_name, work_order_id) VALUES ('T', 'A', 'w1'), ('T', 'B', 'w2');
  `);
  const r2 = await renameTabState(pool, { sheetId: 'T', oldTabName: 'A', newTabName: 'B', tabGid: '5' });
  await t('유일 제약 위반 없이 끝나고, 새 이름의 연결을 덮지 않는다', async () => {
    const rows = (await db.query(`SELECT tab_name n, work_order_id w FROM trackb_work_order_links WHERE sheet_id='T' ORDER BY id`)).rows;
    assert.deepEqual(rows.map(x => [x.n, x.w]), [['A', 'w1'], ['B', 'w2']]);
    assert.equal(r2.workOrderLinksUpdated, 0);
  });
  await t('이름이 그대로면 아무것도 안 한다', async () => {
    const n0 = calls.length;
    const z = await renameTabState(pool, { sheetId: 'S', oldTabName: 'x', newTabName: 'x' });
    assert.equal(calls.length, n0); assert.equal(z.workOrdersUpdated, 0); assert.equal(z.workOrderLinksUpdated, 0);
  });

  console.log('── D. 총모집 0 리뷰오더 — 막지 않고 이상로그 경고(실 PG) ──');
  const elog = new PGlite(); await elog.waitReady;
  await elog.exec(S('migrations/026_error_logs.sql'));
  await elog.exec(S('migrations/028_error_debug.sql'));
  const realPool = require('../src/db/pool');
  realPool.query = (s, p) => elog.query(s, p);
  const { warnZeroRecruit, isZeroRecruit } = require('../src/services/zeroRecruitWarning.service');
  await t('정원 판정: 0·빈 값·숫자 아님 = 0 / 양수 = 정상', async () => {
    assert.equal(isZeroRecruit({ recruit_count: 0 }), true);
    assert.equal(isZeroRecruit({ recruit_count: null }), true);
    assert.equal(isZeroRecruit({ recruit_count: '' }), true);
    assert.equal(isZeroRecruit({ recruit_count: '30' }), false);
    assert.equal(isZeroRecruit({ recruit_count: 1 }), false);
  });
  await t('정원 있는 오더는 기록하지 않는다', async () => {
    assert.equal(await warnZeroRecruit({ id: 'ok1', title: '정상', recruit_count: 50 }, { stage: 'intake' }), false);
    assert.equal((await elog.query('SELECT count(*)::int n FROM error_logs')).rows[0].n, 0);
  });
  await t('총모집 0 오더 → 경고(warn) 한 줄 · 오더 id·단계가 남는다', async () => {
    assert.equal(await warnZeroRecruit({ id: 'WO-1', title: '8/1 업체_상품', recruit_count: 0, source_review_order_id: 'RO-9' }, { stage: 'intake', by: '인트라넷' }), true);
    const row = (await elog.query('SELECT * FROM error_logs')).rows[0];
    assert.equal(row.severity, 'warn');
    assert.equal(row.step, 'zero_recruit_count');
    assert.match(row.step_ko, /총모집 0/);
    assert.match(row.message_raw, /8\/1 업체_상품/);
    assert.equal(row.context.workOrderId, 'WO-1');
    assert.equal(row.context.stage, 'intake');
  });
  await t('같은 오더가 접수 단계에서 다시 걸리면 같은 줄의 횟수만 오른다 · 다른 오더는 따로 남는다', async () => {
    await warnZeroRecruit({ id: 'WO-1', title: '8/1 업체_상품', recruit_count: 0 }, { stage: 'accept' });
    await warnZeroRecruit({ id: 'WO-2', title: '8/1 업체_상품', recruit_count: 0 }, { stage: 'intake' });
    const rows = (await elog.query(`SELECT context->>'workOrderId' w, occurrence_count c FROM error_logs ORDER BY id`)).rows;
    assert.deepEqual(rows.map(x => [x.w, x.c]), [['WO-1', 2], ['WO-2', 1]]);
  });
  await t('★ 기록 실패는 접수를 깨지 않는다(throw 없음)', async () => {
    realPool.query = async () => { throw new Error('db down'); };
    assert.equal(await warnZeroRecruit({ id: 'WO-3', recruit_count: 0 }, { stage: 'intake' }), true);
    assert.equal(await warnZeroRecruit(null, {}), false);
  });

  console.log('── E. 배선 — 접수(intake)·작업 접수(accept) 두 곳 · 막지 않는다 ──');
  const route = S('src/routes/order.routes.js');
  await t('인트라넷 접수: 저장 성공 뒤 경고(응답 전, 기다리지 않음)', async () => {
    assert.match(route, /data = await _insertWorkOrder\(b, requester, sourceContract\);[\s\S]{0,1600}warnZeroRecruit\(data, \{ stage: 'intake'/);
  });
  await t('작업 접수: 저장된 오더 기준으로 경고 · 응답에 표시만 싣는다', async () => {
    assert.match(route, /warnZeroRecruit\(upd\[0\], \{ stage: 'accept'/);
    assert.match(route, /recruitCountZero:/);
  });
  await t('★ 총모집 0 을 이유로 거절(4xx)하지 않는다 — 인트라넷 원본 번호가 어긋나면 안 된다', async () => {
    assert(!/recruit_count[^\n]{0,80}status\(4\d\d\)/.test(route));
    assert(!/zero_recruit[^\n]{0,120}status\(4\d\d\)/.test(route));
  });

  console.log(`\nworkOrderLinkFollowRename: ${passed} passed`);
})().catch(e => { console.error(e); process.exit(1); });
