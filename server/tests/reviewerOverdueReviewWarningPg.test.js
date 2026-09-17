/**
 * 격리 PostgreSQL 스키마에서 오래된 리뷰 경고의 실제 SQL을 검증한다.
 * 실행: PGTEST_URL=postgres://... node tests/reviewerOverdueReviewWarningPg.test.js
 */
if (!process.env.PGTEST_URL) {
  console.log('⏭  PGTEST_URL 미설정 — PostgreSQL 검증 건너뜀');
  process.exit(0);
}

const assert = require('assert');
const { Pool } = require('pg');

const schemaName = 'reviewer_overdue_warning_test';
const adminPool = new Pool({ connectionString:process.env.PGTEST_URL });

function scopedConnectionString(base, schema) {
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

async function callRoute(router, ownerReviewerId) {
  const layer = router.stack.find(l => l.route && l.route.path === '/overdue-review-warning' && l.route.methods.get);
  assert.ok(layer, 'overdue-review-warning 라우트 없음');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return await new Promise(resolve => {
    const res = {
      statusCode:200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode:this.statusCode, body }); return this; },
    };
    Promise.resolve(handler({ reviewer:{ ownerReviewerId } }, res, err => resolve({ err }))).catch(err => resolve({ err }));
  });
}

(async () => {
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool.query(`CREATE SCHEMA ${schemaName}`);
  process.env.DATABASE_URL = scopedConnectionString(process.env.PGTEST_URL, schemaName);
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'reviewer-overdue-test-secret';

  const pool = require('../src/db/pool');
  await pool.query(`
    CREATE TABLE reviewers (
      id UUID PRIMARY KEY, reviewer_no BIGINT, phone8 TEXT, sub_accounts JSONB DEFAULT '[]'::jsonb
    );
    CREATE TABLE reviewer_identities (
      id UUID PRIMARY KEY, owner_reviewer_id UUID, current_phone8 TEXT, status TEXT
    );
    CREATE TABLE reviewer_identity_aliases (identity_id UUID, phone8 TEXT);
    CREATE TABLE reviewer_phone_changes (old_phone8 TEXT, reviewer_id UUID);
    CREATE TABLE order_submissions (
      id UUID PRIMARY KEY, submitted_at TIMESTAMPTZ, sheet_id TEXT, tab_name TEXT, sheet_row INT,
      owner_reviewer_id UUID, phone TEXT, deleted_at TIMESTAMPTZ, mirror_status TEXT,
      campaign_application_id UUID, participant_identity_id UUID
    );
    CREATE TABLE campaign_participants (
      id UUID PRIMARY KEY, order_submission_id UUID, sheet_id TEXT, tab_name TEXT, seq INT,
      reviewer_name TEXT, phone8 TEXT, owner_reviewer_id UUID, participant_identity_id UUID,
      is_submitted BOOLEAN DEFAULT FALSE, deleted_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE review_index (
      sheet_id TEXT, tab_name TEXT, row_index INT, is_submitted BOOLEAN DEFAULT FALSE, campaign_name TEXT, phone8 TEXT
    );
    CREATE TABLE review_index_archive (
      sheet_id TEXT, tab_name TEXT, row_index INT, is_submitted BOOLEAN DEFAULT FALSE, campaign_name TEXT, phone8 TEXT
    );
    CREATE TABLE participation_links (
      sheet_id TEXT, tab_name TEXT, row_index INT, phone8 TEXT, owner_reviewer_id UUID
    );
    CREATE TABLE campaign_applications (
      id UUID PRIMARY KEY, campaign_id TEXT, owner_reviewer_id UUID, owner_phone8 TEXT,
      phone8 TEXT, participant_identity_id UUID
    );
    CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE tab_configs (sheet_id TEXT, tab_name TEXT, display_name TEXT, campaign_name TEXT);
    CREATE TABLE review_reminder_states (order_submission_id UUID, review_status TEXT);
    CREATE TABLE workdesk_participant_deletions (
      order_submission_id UUID, sheet_id TEXT, tab_name TEXT, seq INT
    );
  `);

  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const old12 = '11111111-1111-4111-8111-111111111111';
  const old11 = '22222222-2222-4222-8222-222222222222';
  const done15 = '33333333-3333-4333-8333-333333333333';
  const recent9 = '44444444-4444-4444-8444-444444444444';
  const foreign20 = '55555555-5555-4555-8555-555555555555';
  const legacy13 = '66666666-6666-4666-8666-666666666666';
  const foreignOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await pool.query(`INSERT INTO reviewers(id,phone8,sub_accounts) VALUES ($1,'11112222','[]')`, [owner]);
  await pool.query(`
    INSERT INTO order_submissions(id,submitted_at,sheet_id,tab_name,sheet_row,owner_reviewer_id,phone,mirror_status)
    VALUES
      ($1,NOW()-INTERVAL '12 days','s1','t1',1,$5,'01011112222','written'),
      ($2,NOW()-INTERVAL '11 days','s2','t2',2,$5,'01011112222','written'),
      ($3,NOW()-INTERVAL '15 days','s3','t3',3,$5,'01011112222','written'),
      ($4,NOW()-INTERVAL '9 days','s4','t4',4,$5,'01011112222','written'),
      ($6,NOW()-INTERVAL '20 days','s5','t5',5,$8,'01011112222','written'),
      ($7,NOW()-INTERVAL '13 days','s6','t6',6,NULL,'01011112222','written')`,
    [old12, old11, done15, recent9, owner, foreign20, legacy13, foreignOwner]
  );
  await pool.query(`
    INSERT INTO campaign_participants(id,order_submission_id,sheet_id,tab_name,seq,phone8,owner_reviewer_id,is_submitted)
    VALUES
      ('51111111-1111-4111-8111-111111111111',$1,'s1','t1',1,'11112222',$6,FALSE),
      ('52222222-2222-4222-8222-222222222222',$2,'s2','t2',2,'11112222',$6,FALSE),
      ('53333333-3333-4333-8333-333333333333',$3,'s3','t3',3,'11112222',$6,TRUE),
      ('54444444-4444-4444-8444-444444444444',$4,'s4','t4',4,'11112222',$6,FALSE),
      ('55555555-5555-4555-8555-555555555551',$5,'s5','t5',5,'11112222',$7,FALSE)`,
    [old12, old11, done15, recent9, foreign20, owner, foreignOwner]
  );
  await pool.query(`
    INSERT INTO review_index(sheet_id,tab_name,row_index,is_submitted,campaign_name,phone8)
    VALUES ('s1','t1',1,FALSE,'12일 작업','11112222'),('s2','t2',2,FALSE,'11일 작업','11112222'),
           ('s3','t3',3,TRUE,'완료 작업','11112222'),('s4','t4',4,FALSE,'9일 작업','11112222'),
           ('s5','t5',5,FALSE,'다른 소유자 작업','11112222'),('s6','t6',6,FALSE,'레거시 참여링크 작업',NULL)
  `);
  await pool.query(`
    INSERT INTO participation_links(sheet_id,tab_name,row_index,phone8,owner_reviewer_id)
    VALUES ('s6','t6',6,'11112222',$1)
  `, [owner]);

  const router = require('../src/routes/reviewer.routes');
  const first = await callRoute(router, owner);
  assert.ifError(first.err);
  assert.notEqual(first.body.item.orderSubmissionId, foreign20, '재사용 전화번호의 다른 소유자 주문 제외');
  assert.equal(first.body.item.orderSubmissionId, legacy13, '연락처가 빈 레거시 행은 참여링크로 연결');
  assert.equal(first.body.item.displayName, '레거시 참여링크 작업');

  await pool.query(`UPDATE review_index SET is_submitted=TRUE WHERE sheet_id='s6' AND tab_name='t6'`);
  const second = await callRoute(router, owner);
  assert.ifError(second.err);
  assert.equal(second.body.item.orderSubmissionId, old12, '레거시 완료 뒤 12일 작업');

  await pool.query(`UPDATE campaign_participants SET is_submitted=TRUE WHERE order_submission_id=$1`, [old12]);
  const third = await callRoute(router, owner);
  assert.ifError(third.err);
  assert.equal(third.body.item.orderSubmissionId, old11, '12일 완료 뒤 11일 작업');

  await pool.query(`UPDATE review_index SET is_submitted=TRUE WHERE sheet_id='s2' AND tab_name='t2'`);
  const none = await callRoute(router, owner);
  assert.ifError(none.err);
  assert.equal(none.body.item, null, '완료 건과 10일 미만 건만 남으면 알림 없음');

  const polluted = '77777777-7777-4777-8777-777777777777';
  await pool.query(`
    INSERT INTO order_submissions(id,submitted_at,sheet_id,tab_name,sheet_row,owner_reviewer_id,phone,mirror_status)
    VALUES ($1,NOW()-INTERVAL '30 days','s7','t7',70,$2,'01011112222','written')`, [polluted, owner]);
  await pool.query(`
    INSERT INTO campaign_participants
      (id,order_submission_id,sheet_id,tab_name,seq,reviewer_name,phone8,owner_reviewer_id,is_submitted,updated_at)
    VALUES
      ('71111111-1111-4111-8111-111111111111',$1,'s7','t7',71,'소유자 타계정','33334444',$2,FALSE,NOW()-INTERVAL '1 hour'),
      ('7fffffff-ffff-4fff-8fff-ffffffffffff',$1,'s7','t7',72,'다른 소유자','99990000',$3,FALSE,NOW())`,
    [polluted, owner, foreignOwner]);
  await pool.query(`
    INSERT INTO review_index(sheet_id,tab_name,row_index,is_submitted,campaign_name,phone8)
    VALUES ('s7','t7',71,FALSE,'소유자 완료 작업','33334444'),('s7','t7',72,FALSE,'타소유자 미완료 작업','99990000')`);
  await pool.query(`
    INSERT INTO review_index_archive(sheet_id,tab_name,row_index,is_submitted,campaign_name,phone8)
    VALUES ('s7','t7',71,TRUE,'소유자 완료 작업','33334444')`);
  const pollutedDone = await callRoute(router, owner);
  assert.ifError(pollutedDone.err);
  assert.equal(pollutedDone.body.item, null, '최신 타소유자 미완료행 대신 소유자 보관 완료행을 적용');

  const mixedIdentity = '88888888-8888-4888-8888-888888888888';
  await pool.query(`UPDATE reviewers SET sub_accounts=$2::jsonb WHERE id=$1`, [owner, JSON.stringify([
    { name:'명지수', phone:'010-1234-5678' }, { name:'홍길동', phone:'010-1111-2222' },
  ])]);
  await pool.query(`
    INSERT INTO order_submissions(id,submitted_at,sheet_id,tab_name,sheet_row,owner_reviewer_id,phone,mirror_status)
    VALUES ($1,NOW()-INTERVAL '14 days','s8','t8',81,$2,'01011112222','written')`, [mixedIdentity, owner]);
  await pool.query(`
    INSERT INTO campaign_participants
      (id,order_submission_id,sheet_id,tab_name,seq,reviewer_name,phone8,owner_reviewer_id,is_submitted)
    VALUES ('81111111-1111-4111-8111-111111111111',$1,'s8','t8',81,'명지수','12345678',$2,FALSE)`,
    [mixedIdentity, owner]);
  await pool.query(`
    INSERT INTO review_index(sheet_id,tab_name,row_index,is_submitted,campaign_name,phone8)
    VALUES ('s8','t8',81,FALSE,'타계정 교차 연락처 작업','12345678')`);
  const mixedPending = await callRoute(router, owner);
  assert.ifError(mixedPending.err);
  assert.equal(mixedPending.body.item.orderSubmissionId, mixedIdentity, '같은 소유자의 다른 타계정 연락처 조합도 작업에 귀속');

  await pool.query(`UPDATE review_index SET is_submitted=TRUE WHERE sheet_id='s8' AND tab_name='t8' AND row_index=81`);
  const mixedDone = await callRoute(router, owner);
  assert.ifError(mixedDone.err);
  assert.equal(mixedDone.body.item, null, '같은 소유자 범위에서 어느 명의로든 완료되면 재알림 없음');

  console.log('✅ reviewerOverdueReviewWarningPg — 실제 PostgreSQL 8시나리오 통과');
  await pool.end();
})().catch(err => {
  console.error('❌ ' + err.stack);
  process.exitCode = 1;
}).finally(async () => {
  try { await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`); } catch (_) {}
  await adminPool.end();
});
