'use strict';
// 마감된 작업(trackb_tab_finished)의 미제출 행은 리뷰어 "리뷰 내역"·독촉에 "써야 할 리뷰"로 나오지 않는다.
// 실행: PGLITE_MODULE=$(node -e "console.log(require.resolve('@electric-sql/pglite'))") node tests/finishedTaskReviewerHidden.test.js
const assert = require('assert');
if (!process.env.PGLITE_MODULE) throw Error('Embedded PostgreSQL required (PGLITE_MODULE)');
const { PGlite } = require(process.env.PGLITE_MODULE);
const pool = require('../src/db/pool');
const obligation = require('../src/services/reviewObligation.service');

(async () => {
  const db = new PGlite();
  pool.query = (sql, params) => db.query(sql, params);
  await db.exec(`CREATE TABLE trackb_tab_finished(sheet_id text,tab_name text,tab_gid text,deleted_at timestamptz);`);
  const { _dropFinishedPending } = require('../src/services/search.service');
  let passed = 0; const t = async (n, f) => { await f(); passed++; console.log('PASS ' + n); };
  const rows = () => [
    { sheetId: 's', tabName: '마감작업', gid: '11', isSubmitted: false },
    { sheetId: 's', tabName: '마감작업', gid: '11', isSubmitted: true },
    { sheetId: 's', tabName: '진행작업', gid: '22', isSubmitted: false },
    { sheetId: 's', tabName: '새이름', gid: '33', isSubmitted: false },
  ];
  await t('마감 없으면 그대로', async () => assert.equal((await _dropFinishedPending(rows())).length, 4));
  await db.query("INSERT INTO trackb_tab_finished VALUES('s','마감작업','11',NULL),('s','옛이름','33',NULL),('s','진행작업','',NULL)");
  await t('마감 작업 미제출만 빠지고 제출완료 이력은 남음 · 리네임은 gid 로 · 빈 gid 는 매칭 안 함 판정', async () => {
    const out = await _dropFinishedPending(rows());
    assert.deepStrictEqual(out.map(r => `${r.tabName}:${r.isSubmitted}`), ['마감작업:true']);
  });
  await db.query("UPDATE trackb_tab_finished SET tab_gid=NULL WHERE tab_name='진행작업'");
  await db.query("DELETE FROM trackb_tab_finished WHERE tab_name='진행작업'");
  await t('빈 gid 행은 다른 탭을 삼키지 않음', async () => {
    await db.query("INSERT INTO trackb_tab_finished VALUES('s','딴작업','',NULL)");
    const out = await _dropFinishedPending(rows());
    assert.ok(out.some(r => r.tabName === '진행작업'));
  });
  await t('복귀(deleted_at)하면 다시 보임', async () => {
    await db.query('UPDATE trackb_tab_finished SET deleted_at=now()');
    assert.equal((await _dropFinishedPending(rows())).length, 4);
  });
  await t('조회 실패는 종전 목록 유지(fail-open)', async () => {
    const q = pool.query; pool.query = async () => { throw new Error('boom'); };
    try { assert.equal((await _dropFinishedPending(rows())).length, 4); } finally { pool.query = q; }
  });
  await t('독촉·리뷰 의무 판정(unfulfilledSql)도 마감 작업을 뺀다', async () => {
    assert.match(obligation.unfulfilledSql('ri'), /trackb_tab_finished/);
  });
  await t('리뷰어 이력·받을 예정 금액 경로 배선', async () => {
    const fs = require('fs');
    assert.match(fs.readFileSync(require.resolve('../src/services/reviewerHistory.service'), 'utf8'), /finishedTabSql/);
    const route = fs.readFileSync(require.resolve('../src/routes/reviewer.routes'), 'utf8');
    assert.ok((route.match(/finishedTabSql\(/g) || []).length >= 4);
    assert.match(route, /if \(!r\.finished\) \{/);
    assert.match(route, /if \(o\.finished\) continue;/);
    const search = fs.readFileSync(require.resolve('../src/services/search.service'), 'latin1');
    assert.equal((search.match(/results = await _dropFinishedPending\(results\)/g) || []).length, 2);
    assert.match(search, /frc\.linked_sheet_id/, 'merged campaign orders resolve linked board');
    assert.match(fs.readFileSync(require.resolve('../src/services/reviewerHistory.service'), 'utf8'), /index_snapshot->>'tab_gid'/);
  });
  console.log(`${passed} finished-task reviewer tests passed`);
  await db.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
