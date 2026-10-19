'use strict';
// 결정 256: 🏁 마감(trackb_tab_finished)된 작업에는 리뷰어 본인 제출을 받지 않는다 · 직원 대신 제출은 열어 둔다.
// 실행: node tests/finishedWorkReviewSubmitBlockedPg.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
// pglite 는 server 의존성이라 CI(npm test)에서도 그대로 돈다 — 건너뛰지 않는다.
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE trackb_tab_finished(sheet_id text,tab_name text,tab_gid text,deleted_at timestamptz);
    CREATE TABLE tab_configs(sheet_id text,tab_name text,tab_gid text,is_closed boolean DEFAULT false,archived_rounds text,sheetless boolean DEFAULT true);
    CREATE TABLE campaign_participants(id serial,sheet_id text,tab_name text,seq int,active boolean DEFAULT true,deleted_at timestamptz,order_submission_id text,round text,submit_col text,row_json jsonb);
    CREATE TABLE order_submissions(id text,deleted_at timestamptz);
    CREATE TABLE index_master_archive(sheet_id text,tab_name text);
    CREATE TABLE review_closed_targets(sheet_id text,tab_name text,row_index int);
    CREATE TABLE review_index(id serial,sheet_id text,tab_name text,row_index int,is_submitted boolean DEFAULT false,round text);
    INSERT INTO tab_configs(sheet_id,tab_name,tab_gid) VALUES('s','작업','77');
    INSERT INTO campaign_participants(sheet_id,tab_name,seq,submit_col,row_json) VALUES('s','작업',1,'리뷰','{}');
    INSERT INTO review_index(sheet_id,tab_name,row_index) VALUES('s','작업',1);
  `);
  const client = { query: (sql, params) => db.query(sql, params) };
  const rct = require('../src/services/reviewCompletionTransaction.service');
  const target = { sheetId: 's', tabName: '작업', rowIndex: 1 };
  let passed = 0; const t = async (n, f) => { await f(); passed++; console.log('PASS ' + n); };
  // 소유 확인은 이 가드의 관심사가 아니다 — 통과로 고정
  require('../src/services/reviewerTargetOwnership.service').ownsReviewerTarget = async () => true;
  const session = { ownerReviewerId: 'r1' };

  await t('마감 전: 리뷰어 제출 통과', async () => {
    assert.ok(await rct.lockTarget(client, { ...target, reviewerSession: session }));
    assert.equal(await rct.isWorkFinished(client, target), false);
  });
  await db.query("INSERT INTO trackb_tab_finished VALUES('s','작업','77',NULL)");
  await t('🏁 마감 후: 리뷰어 본인 제출은 거절(REVIEW_TARGET_ARCHIVED · 안내 문구)', async () => {
    await assert.rejects(rct.lockTarget(client, { ...target, reviewerSession: session }),
      e => e.code === 'REVIEW_TARGET_ARCHIVED' && /마감된 작업이라 리뷰를 제출할 수 없어요/.test(e.message));
  });
  await t('🏁 마감 후: 직원 대신 제출(리뷰어 세션 없음)은 통과', async () => {
    assert.ok(await rct.lockTarget(client, { ...target, reviewerSession: null }));
  });
  await db.query("UPDATE trackb_tab_finished SET tab_name='옛이름'");
  await t('탭 이름이 바뀌어도 gid 로 마감을 알아본다', async () => {
    assert.equal(await rct.isWorkFinished(client, target), true);
  });
  await db.query("UPDATE trackb_tab_finished SET tab_gid=''");
  await t('빈 gid 마감 행은 다른 작업을 막지 않는다', async () => {
    assert.equal(await rct.isWorkFinished(client, target), false);
  });
  await db.query("UPDATE trackb_tab_finished SET tab_name='작업', tab_gid='77', deleted_at=now()");
  await t('진행중으로 복귀하면 다시 제출할 수 있다', async () => {
    assert.ok(await rct.lockTarget(client, { ...target, reviewerSession: session }));
  });

  const route = fs.readFileSync(path.join(__dirname, '../src/routes/submit.routes.js'), 'utf8');
  await t('제출 라우트: 리뷰어 세션일 때 이른 안내(409) · 조회 실패는 막지 않음', async () => {
    const i = route.indexOf("if (reviewerSession) {\n      const ownsTarget");
    const block = route.slice(i, route.indexOf('const closedReminder', i));
    assert.ok(/_rct\.isWorkFinished\(pool, \{ sheetId, tabName \}\)/.test(block));
    assert.ok(/status\(409\)[\s\S]*REVIEW_TARGET_ARCHIVED[\s\S]*_rct\.FINISHED_MSG/.test(block));
    assert.ok(/catch \(_\) \{ \/\* fail-open \*\/ \}/.test(block));
  });
  console.log(`\n✅ finishedWorkReviewSubmitBlockedPg: ${passed}/${passed}`);
})().catch(e => { console.error(e); process.exit(1); });
