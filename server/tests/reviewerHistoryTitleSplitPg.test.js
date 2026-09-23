/**
 * 리뷰 내역 "제목 수정 → 한 참여가 두 장" — **진짜 PostgreSQL** 검증.
 *
 * 스텁 DB 는 SQL 을 해석하지 않는다. 이 건의 핵심은 전부 조건절·조인의 실제 동작이라
 * 여기서만 잡힌다:
 *   1. 참여형(무시트) 주문 + 작업표 링크 → 카드 **1장**(수정 전 코드에서는 2장이 재현된다)
 *   2. 카드 이름 = **지금 적용된 공고 제목**(사용자 확정 2026-08-19) — 색인행 카드·병합 카드가
 *      같은 문자열이라 제목을 바꿔도 두 이름으로 갈리지 않는다
 *   3. 주문 id dedup 의 스코프 — 남의 작업표 행(다른 phone8)으로 내 카드가 사라지지 않는다
 *   4. 소프트삭제된 작업표 줄은 dedup 근거가 아니다(주문이 다시 보여야 한다)
 *
 * 실행: PGTEST_URL=postgres://... node tests/reviewerHistoryTitleSplitPg.test.js
 *   (PGTEST_URL 이 없으면 skip — 스텁 가드는 tests/reviewerHistoryTitleSplit.test.js)
 *
 * ★★ PGTEST_URL → DATABASE_URL 이관은 **파일 최상단에서**(pool 은 require 시점에 env 를 읽는다).
 */
if (!process.env.PGTEST_URL) {
  console.log('⏭  PGTEST_URL 미설정 — 진짜 PG 검증 건너뜀(스텁 가드는 tests/reviewerHistoryTitleSplit.test.js)');
  process.exit(0);
}
process.env.DATABASE_URL = process.env.PGTEST_URL;

const assert = require('assert');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.PGTEST_URL });
const svc = require('../src/services/search.service');
// 제목 조회는 탭당 60초 캐시(리뷰타입·종류와 같은 규율) — 테스트는 매 케이스 캐시를 비운다.
// ⚠ 운영 함의: 공고 제목을 고치면 리뷰어 화면 반영이 최대 60초 늦다(CAMPAIGN_TITLE_CACHE_MS).
const titleCtx = require('../src/services/campaignTitleContext.service');
const resetTitleCache = () => titleCtx.__setPoolForTest(null);

let pass = 0;
const ta = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };

const SHEET = 'wt_titlesplit';
const TAB = '8/15모기위키 모기기피제';   // 접수 시점 작업 이름(= tab_configs.display_name, 고정)
const NEW_TITLE = '모기위키 모기기피제'; // 관리자가 나중에 고친 공고 제목
const OSID = '11111111-1111-1111-1111-111111111111';
const P8 = '29979075';

async function schema() {
  // ★ 서비스가 실제로 조회하는 테이블을 전부 만든다 — 쿼리 사본을 검증하면 서비스 SQL 을
  //   망가뜨려도 통과한다(레포 규율: ownershipTransferPg 와 같은 방식).
  await pool.query(`
    DROP TABLE IF EXISTS review_index, tab_configs, recruit_campaigns, campaign_applications,
      order_submissions, campaign_participants, reviewers, participation_links, review_submissions CASCADE;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE review_index (
      id SERIAL PRIMARY KEY, reviewer_name TEXT, sheet_id TEXT, tab_gid TEXT, tab_name TEXT,
      campaign_name TEXT, row_index INT, is_submitted BOOLEAN DEFAULT FALSE, is_submitted2 TEXT,
      product_url TEXT, product_name TEXT, submit_col TEXT, submit_col2 TEXT, row_json JSONB,
      start_date TEXT, end_date TEXT, round TEXT, phone8 TEXT, recipient_name TEXT,
      review_file_id TEXT, review_file_url TEXT, review_file_name TEXT, review_file_count INT,
      review_file_at TIMESTAMPTZ, built_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tab_configs (
      sheet_id TEXT, tab_name TEXT, tab_gid TEXT, sheet_url TEXT, campaign_name TEXT, display_name TEXT,
      manager TEXT, time_range TEXT, review_type TEXT, taekhap BOOLEAN, is_closed BOOLEAN DEFAULT FALSE,
      delivery_type TEXT, is_bulk BOOLEAN, income_type TEXT, nc_mode BOOLEAN, folder_url TEXT,
      capture_folder_url TEXT, capture_slots JSONB, archived_rounds TEXT, sheetless BOOLEAN DEFAULT FALSE,
      work_kind TEXT, PRIMARY KEY (sheet_id, tab_name));
    CREATE TABLE recruit_campaigns (
      id TEXT PRIMARY KEY, title TEXT, linked_sheet_id TEXT, linked_tab_name TEXT, linked_tab_gid TEXT,
      review_type TEXT, work_kind TEXT, participation_mode BOOLEAN DEFAULT TRUE,
      status TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE campaign_applications (id SERIAL PRIMARY KEY, campaign_id TEXT, phone8 TEXT);
    CREATE TABLE order_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id TEXT, tab_name TEXT, tab_gid TEXT,
      sheet_row INT, mirror_status TEXT, recipient TEXT, phone TEXT, deleted_at TIMESTAMPTZ,
      submitted_at TIMESTAMPTZ DEFAULT NOW(), sheet_written_at TIMESTAMPTZ, campaign_application_id INT);
    CREATE TABLE campaign_participants (
      id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, tab_gid TEXT, seq INT,
      order_submission_id UUID, deleted_at TIMESTAMPTZ);
    CREATE TABLE reviewers (id SERIAL PRIMARY KEY, phone8 TEXT, sub_accounts JSONB);
    CREATE TABLE participation_links (sheet_id TEXT, tab_name TEXT, row_index INT, phone8 TEXT);
    CREATE TABLE review_submissions (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT,
      row_index INT, phone8 TEXT, slot_key TEXT, trashed BOOLEAN DEFAULT FALSE);
  `);
}

async function seed() {
  resetTitleCache();
  await pool.query('TRUNCATE review_index, tab_configs, recruit_campaigns, campaign_applications, order_submissions, campaign_participants');
  await pool.query(
    `INSERT INTO recruit_campaigns(id,title,linked_sheet_id,linked_tab_name,linked_tab_gid)
     VALUES ('c1',$1,$2,$3,'101')`, [NEW_TITLE, SHEET, TAB]);
  await pool.query(
    `INSERT INTO tab_configs(sheet_id,tab_name,tab_gid,display_name,campaign_name,sheetless)
     VALUES ($1,$2,'101',$2,$2,TRUE)`, [SHEET, TAB]);
  await pool.query(`INSERT INTO campaign_applications(id,campaign_id,phone8) VALUES (1,'c1',$1)`, [P8]);
  // 참여형 주문 — 원장 좌표는 campaign:*, sheet_row 는 작업표 seq(좌표계가 다르다)
  await pool.query(
    `INSERT INTO order_submissions(id,sheet_id,tab_name,sheet_row,mirror_status,recipient,phone,
                                   sheet_written_at,campaign_application_id)
     VALUES ($1,'campaign:c1','campaign:c1',5,'written','박진회','010-2997-9075',NOW(),1)`, [OSID]);
  await pool.query(
    `INSERT INTO campaign_participants(sheet_id,tab_name,tab_gid,seq,order_submission_id)
     VALUES ($1,$2,'101',5,$3)`, [SHEET, TAB, OSID]);
  await pool.query(
    `INSERT INTO review_index(reviewer_name,sheet_id,tab_gid,tab_name,campaign_name,row_index,phone8,row_json)
     VALUES ('박진회',$1,'101',$2,$2,5,$3,'{"주문번호":"123456"}')`, [SHEET, TAB, P8]);
}

async function cards() {
  const r = await svc.searchByName('박진회', P8, { includeSubmitted: true });
  return r.results.map(x => ({ title: x.displayNameTC, order: !!x.isOrderPending }));
}

(async () => {
  await schema();

  await ta('제목을 바꿔도 한 참여 = 카드 1장 · 이름은 지금 적용된 공고 제목', async () => {
    await seed();
    const c = await cards();
    assert.equal(c.length, 1, `카드 1장이어야 한다(실제: ${JSON.stringify(c)})`);
    assert.equal(c[0].order, false, '남는 카드는 작업표 색인행이다');
    assert.equal(c[0].title, NEW_TITLE,
      '색인행 카드도 지금 적용된 공고 제목으로 표기한다(접수 시점 탭 이름 아님)');
  });

  await ta('제목을 또 바꾸면 카드 이름도 따라 바뀐다', async () => {
    await seed();
    await pool.query("UPDATE recruit_campaigns SET title = '모기위키 모기기피제(2차)' WHERE id = 'c1'");
    resetTitleCache();
    const c = await cards();
    assert.equal(c.length, 1, '이름이 바뀌어도 카드는 1장');
    assert.equal(c[0].title, '모기위키 모기기피제(2차)', '최신 제목이 그대로 카드 이름');
  });

  await ta('작업표 링크가 없으면 병합 카드가 뜨되 이름은 색인행과 같다', async () => {
    await seed();
    await pool.query('UPDATE campaign_participants SET order_submission_id = NULL');
    const c = await cards();
    const merged = c.filter(x => x.order);
    assert.equal(merged.length, 1, '링크가 없으면 종전대로 병합된다');
    assert.equal(merged[0].title, NEW_TITLE, '병합 카드도 같은 제목 — 두 이름으로 갈리지 않는다');
    assert.deepEqual([...new Set(c.map(x => x.title))], [NEW_TITLE],
      '두 카드가 같은 문자열이어야 한다');
  });

  await ta('공고가 연결되지 않은 탭은 종전 탭 표시명으로 접는다', async () => {
    await seed();
    await pool.query("UPDATE recruit_campaigns SET linked_sheet_id = 'other', linked_tab_name = 'other'");
    resetTitleCache();
    const c = await cards();
    assert.equal(c[0].title, TAB, '미연결이면 이름이 비지 않고 종전 표시명');
  });

  await ta('남의 작업표 행은 내 카드를 지우지 못한다', async () => {
    await seed();
    // 같은 주문 id 가 붙은 줄이지만 그 행의 색인 phone8 은 타인
    await pool.query('UPDATE review_index SET phone8 = $1', ['00000000']);
    const r = await svc.searchByName('박진회', P8, { includeSubmitted: true });
    const merged = r.results.filter(x => x.isOrderPending);
    assert.equal(merged.length, 1,
      '내 화면에 보이지 않는 행을 dedup 근거로 쓰면 참여가 통째로 사라진다');
  });

  await ta('소프트삭제된 작업표 줄은 dedup 근거가 아니다', async () => {
    await seed();
    await pool.query('UPDATE campaign_participants SET deleted_at = NOW()');
    const r = await svc.searchByName('박진회', P8, { includeSubmitted: true });
    assert.equal(r.results.filter(x => x.isOrderPending).length, 1,
      '지워진 줄을 근거로 주문을 숨기면 안 된다');
  });

  console.log(`✅ reviewerHistoryTitleSplitPg — ${pass}케이스 통과`);
  await pool.end();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
