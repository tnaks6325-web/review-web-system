/**
 * 리뷰어 홈 — **진짜 PostgreSQL** 검증 (스텁으로는 못 잡는 조인·조건절만).
 *
 *   1. 구매 캡처 보완 카드의 작업 이름 = **지금 적용된 공고 제목**(한글)
 *      — 참여형 주문의 원장 좌표 `campaign:<공고ID>` 가 그대로 찍히던 신고(2026-08-19).
 *   2. 공고 제목이 비면 연결 작업표 탭 이름으로 접는다(이름이 비지 않는다).
 *   3. **받을 예정 금액의 이중 집계 차단** — 같은 참여가 명단(review_index)과 주문원장 양쪽에서
 *      세어져 "참여중 3건 / 49,800원"처럼 건수·금액이 부풀던 실측 버그. 위치키로는 참여형이
 *      절대 안 걸러지므로 **작업표 줄(주문 id 링크) 좌표**로도 짝지어야 한다.
 *
 * 실행: PGTEST_URL=postgres://... node tests/reviewerMissingCapturePg.test.js
 */
if (!process.env.PGTEST_URL) {
  console.log('⏭  PGTEST_URL 미설정 — 진짜 PG 검증 건너뜀');
  process.exit(0);
}
process.env.DATABASE_URL = process.env.PGTEST_URL;

const assert = require('assert');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.PGTEST_URL });

let pass = 0;
const ta = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };

const SHEET = 'wt_mc', TAB = '8/15모기위키 모기기피제';
const TITLE = '모기위키 모기기피제';
const OSID = '22222222-2222-2222-2222-222222222222';
const P8 = '29979075';

const router = require('../src/routes/reviewer.routes');
function handlerFor(method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert(layer, `라우트 없음: ${method.toUpperCase()} ${routePath}`);
  const st = layer.route.stack;
  return st[st.length - 1].handle;
}
async function call(method, routePath, req) {
  const handler = handlerFor(method, routePath);
  return await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ err }))).catch((err) => resolve({ err }));
  });
}

async function schema() {
  await pool.query(`
    DROP TABLE IF EXISTS review_index, tab_configs, recruit_campaigns, campaign_applications,
      order_submissions, campaign_participants, reviewers, app_settings, campaign_fee_schedules CASCADE;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE review_index (
      id SERIAL PRIMARY KEY, reviewer_name TEXT, sheet_id TEXT, tab_gid TEXT, tab_name TEXT,
      campaign_name TEXT, row_index INT, is_submitted BOOLEAN DEFAULT FALSE, is_submitted2 TEXT,
      product_url TEXT, product_name TEXT, submit_col TEXT, submit_col2 TEXT, row_json JSONB,
      start_date TEXT, end_date TEXT, round TEXT, phone8 TEXT, recipient_name TEXT,
      review_file_id TEXT, review_file_at TIMESTAMPTZ, built_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tab_configs (
      sheet_id TEXT, tab_name TEXT, tab_gid TEXT, display_name TEXT, campaign_name TEXT,
      sheetless BOOLEAN DEFAULT FALSE, PRIMARY KEY (sheet_id, tab_name));
    CREATE TABLE recruit_campaigns (
      id TEXT PRIMARY KEY, title TEXT, linked_sheet_id TEXT, linked_tab_name TEXT, linked_tab_gid TEXT,
      review_fee INT DEFAULT 0, thumbnail_url TEXT, start_date DATE, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE campaign_applications (id SERIAL PRIMARY KEY, campaign_id TEXT, phone8 TEXT);
    CREATE TABLE order_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id TEXT, tab_name TEXT, sheet_row INT,
      mirror_status TEXT, recipient TEXT, orderer TEXT, phone TEXT, price TEXT,
      review_fee_snapshot INT, capture_uploaded_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
      submitted_at TIMESTAMPTZ DEFAULT NOW(), sheet_written_at TIMESTAMPTZ, campaign_application_id INT);
    CREATE TABLE campaign_participants (
      id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, seq INT, row_json JSONB,
      order_submission_id UUID, deleted_at TIMESTAMPTZ);
    CREATE TABLE reviewers (id SERIAL PRIMARY KEY, phone8 TEXT, sub_accounts JSONB);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE campaign_fee_schedules (campaign_id TEXT, effective_from DATE, review_fee INT);
  `);
}

async function seed() {
  await pool.query('TRUNCATE review_index, tab_configs, recruit_campaigns, campaign_applications, order_submissions, campaign_participants');
  await pool.query(
    `INSERT INTO recruit_campaigns(id,title,linked_sheet_id,linked_tab_name,review_fee)
     VALUES ('c1',$1,$2,$3,0)`, [TITLE, SHEET, TAB]);
  await pool.query(
    `INSERT INTO tab_configs(sheet_id,tab_name,display_name,campaign_name,sheetless)
     VALUES ($1,$2,$2,$2,TRUE)`, [SHEET, TAB]);
  await pool.query(`INSERT INTO campaign_applications(id,campaign_id,phone8) VALUES (1,'c1',$1)`, [P8]);
  await pool.query(
    `INSERT INTO order_submissions(id,sheet_id,tab_name,sheet_row,mirror_status,recipient,phone,price,campaign_application_id)
     VALUES ($1,'campaign:c1','campaign:c1',5,'written','박진회','010-2997-9075','13900',1)`, [OSID]);
  await pool.query(
    `INSERT INTO campaign_participants(sheet_id,tab_name,seq,order_submission_id,row_json)
     VALUES ($1,$2,5,$3,'{"결제금액":"13900"}')`, [SHEET, TAB, OSID]);
  await pool.query(
    `INSERT INTO review_index(reviewer_name,sheet_id,tab_name,row_index,phone8,row_json,is_submitted)
     VALUES ('박진회',$1,$2,5,$3,'{"결제금액":"13900"}',FALSE)`, [SHEET, TAB, P8]);
}

(async () => {
  await schema();

  await ta('구매 캡처 보완 — 이름은 지금 적용된 공고 제목(내부 키 노출 0)', async () => {
    await seed();
    const r = await call('get', '/my-missing-captures', { query: { phone8: P8 } });
    const it = (r.body && r.body.items || [])[0];
    assert.ok(it, '캡처 미첨부 주문 1건');
    assert.equal(it.displayName, TITLE, '이름은 공고 제목');
    assert.ok(!/^campaign:/.test(String(it.displayName)), '내부 키가 이름 자리에 오면 안 된다');
    assert.equal(it.tabName, 'campaign:c1', 'tabName 은 첨부 업로드 좌표라 그대로 내려간다');
  });

  await ta('공고 제목이 비면 연결 작업표 탭 이름으로 접는다', async () => {
    await seed();
    await pool.query("UPDATE recruit_campaigns SET title = '' WHERE id = 'c1'");
    const r = await call('get', '/my-missing-captures', { query: { phone8: P8 } });
    const it = (r.body && r.body.items || [])[0];
    assert.equal(it.displayName, TAB, '이름이 비지 않는다');
  });

  await ta('받을 예정 — 같은 참여를 두 번 세지 않는다(건수·금액)', async () => {
    await seed();
    const r = await call('get', '/review-earnings', { query: { phone8: P8 } });
    const t = r.body && r.body.totals;
    assert.ok(t, 'totals 반환');
    assert.equal(t.count, 1, `참여 1건이 1건으로 세어져야 한다(실제 ${t.count})`);
    assert.equal(t.productTotal, 13900, `금액도 한 번만(실제 ${t.productTotal})`);
  });

  await ta('명단에 아직 없는 무시트 주문은 종전대로 합계에 든다(무회귀)', async () => {
    await seed();
    await pool.query('DELETE FROM review_index');
    const r = await call('get', '/review-earnings', { query: { phone8: P8 } });
    const t = r.body && r.body.totals;
    assert.equal(t.count, 1, '명단에 없으면 주문원장으로 보여야 한다');
    assert.equal(t.productTotal, 13900, '금액도 그대로');
  });

  await ta('신청 FK가 비어도 campaign:<id> 작업표 키로 리뷰 내역에 표시한다', async () => {
    await seed();
    await pool.query('DELETE FROM review_index');
    await pool.query('UPDATE order_submissions SET campaign_application_id = NULL');
    const r = await call('get', '/review-earnings', { query: { phone8: P8 } });
    const t = r.body && r.body.totals;
    assert.equal(t.count, 1, '공고 키를 복원한 주문이 리뷰 내역에 나타난다');
    assert.equal(t.productTotal, 13900, '주문 결제금액도 유지한다');
  });

  await ta('작업표 줄이 소프트삭제면 이중집계 방지 근거가 아니다', async () => {
    await seed();
    await pool.query('UPDATE campaign_participants SET deleted_at = NOW()');
    const r = await call('get', '/review-earnings', { query: { phone8: P8 } });
    assert.equal(r.body.totals.count, 2, '지워진 줄로는 짝지을 수 없으므로 종전 동작(양쪽 계수)');
  });

  console.log(`✅ reviewerMissingCapturePg — ${pass}케이스 통과`);
  await pool.end();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
