/*
 * 코드 신원 migration 실 PostgreSQL E2E.
 * 실행: PGTEST_URL=postgres://... node tests/reviewerIdentityCodesPgE2E.test.js
 *
 * 모든 DML은 하나의 트랜잭션에서 실행하고 마지막에 반드시 ROLLBACK 한다.
 * 따라서 Railway PR DB/운영 DB 어디에서도 테스트 리뷰어·참여기록이 남지 않는다.
 */
const assert = require('assert');
const crypto = require('crypto');
const { Client } = require('pg');

const url = process.env.PGTEST_URL || process.env.DATABASE_URL;
if (!url) {
  console.log('⏭ reviewerIdentityCodesPgE2E: PGTEST_URL/DATABASE_URL 없음 — 실DB 검증 건너뜀');
  process.exit(0);
}

const tag = `E2E_ID_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`;
let passed = 0;
function ok(name, condition) { assert.ok(condition, name); passed++; console.log('  ✓ ' + name); }

async function main() {
  const db = new Client({ connectionString: url, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
  await db.connect();
  try {
    await db.query('BEGIN');
    const tables = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name = ANY($1::text[])`,
      [['reviewer_identities', 'reviewer_identity_aliases']]
    );
    ok('migration: identity/alias 테이블이 실제 DB에 존재', tables.rows.length === 2);
    const columns = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name = ANY($1::text[])
          AND column_name = ANY($2::text[])`,
      [['reviewers', 'campaign_applications', 'order_submissions', 'participation_links', 'campaign_participants', 'payment_batch_items'],
       ['reviewer_no', 'owner_reviewer_id', 'participant_identity_id']]
    );
    const have = new Set(columns.rows.map(r => `${r.table_name}.${r.column_name}`));
    ok('migration: 리뷰어 코드와 모든 이력 FK 컬럼이 실제 DB에 존재',
      have.has('reviewers.reviewer_no') &&
      ['campaign_applications', 'order_submissions', 'participation_links', 'campaign_participants', 'payment_batch_items']
        .every(t => have.has(`${t}.owner_reviewer_id`) && have.has(`${t}.participant_identity_id`)));

    const phone = '010-91' + String(Date.now()).slice(-7);
    const reviewer = await db.query(
      `INSERT INTO reviewers (name, phone, status, sub_accounts)
       VALUES ($1, $2, 'active', '[]'::jsonb) RETURNING id, phone8`, [`${tag}_owner`, phone]
    );
    const owner = reviewer.rows[0];
    await db.query('UPDATE reviewers SET reviewer_no=$2 WHERE id=$1', [owner.id, 90000001]);
    const identity = await db.query(
      `INSERT INTO reviewer_identities (owner_reviewer_id, member_no, current_name, current_phone, current_phone8)
       VALUES ($1,0,$2,$3,$4) RETURNING id`,
      [owner.id, `${tag}_participant`, phone, owner.phone8]
    );
    const participantId = identity.rows[0].id;
    await db.query(
      `INSERT INTO reviewer_identity_aliases (identity_id, name, phone, phone8, reason)
       VALUES ($1,$2,$3,$4,'e2e')`, [participantId, `${tag}_participant`, phone, owner.phone8]
    );
    const link = await db.query(
      `INSERT INTO participation_links (sheet_id, tab_name, row_index, phone8, name, source, owner_reviewer_id, participant_identity_id)
       VALUES ($1,$2,987654,$3,$4,'identity_e2e',$5,$6)
       RETURNING owner_reviewer_id, participant_identity_id`,
      [`e2e:${tag}`, tag, owner.phone8, `${tag}_participant`, owner.id, participantId]
    );
    ok('참여 링크: 소유자와 실제 참여자 UUID를 함께 고정',
      link.rows[0].owner_reviewer_id === owner.id && link.rows[0].participant_identity_id === participantId);

    const subPhone = '010-92' + String(Date.now()).slice(-7);
    const second = await db.query(
      `INSERT INTO reviewer_identities (owner_reviewer_id, member_no, current_name, current_phone, current_phone8)
       VALUES ($1,1,$2,$3,$4) RETURNING id`,
      [owner.id, `${tag}_sub`, subPhone, subPhone.slice(-8)]
    );
    await db.query(
      `INSERT INTO reviewer_identity_aliases (identity_id, name, phone, phone8, reason)
       VALUES ($1,$2,$3,$4,'e2e')`, [second.rows[0].id, `${tag}_sub`, subPhone, subPhone.slice(-8)]
    );
    const scope = await db.query(
      `SELECT r.reviewer_no, i.member_no, i.current_phone8
         FROM reviewers r JOIN reviewer_identities i ON i.owner_reviewer_id=r.id
        WHERE r.id=$1 ORDER BY i.member_no`, [owner.id]
    );
    ok('소유자 0001 규칙: 본계정 -0과 타계정 -1은 서로 다른 실제 참여자',
      scope.rows.map(r => Number(r.member_no)).join(',') === '0,1' && Number(scope.rows[0].reviewer_no) === 90000001);

    let duplicateRejected = false;
    try {
      await db.query(
        `INSERT INTO reviewer_identity_aliases (identity_id, name, phone, phone8, reason)
         VALUES ($1,$2,$3,$4,'e2e_duplicate')`, [second.rows[0].id, 'duplicate', phone, owner.phone8]
      );
    } catch (err) { duplicateRejected = err && err.code === '23505'; }
    ok('열린 별칭: 다른 실제 참여자에 같은 번호를 중복 귀속하지 못함', duplicateRejected);
  } finally {
    try { await db.query('ROLLBACK'); } finally { await db.end(); }
  }
  console.log(`✅ reviewerIdentityCodesPgE2E: ${passed}개 통과 (모든 테스트 데이터 ROLLBACK)`);
}

main().catch((err) => { console.error('❌ reviewerIdentityCodesPgE2E:', err.message); process.exit(1); });
