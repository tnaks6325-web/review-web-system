/**
 * sheetlessStatusPersistPg.test.js — 탈 구글시트 W3 · **진짜 PG16** 검증
 * 실행: PGTEST_URL=postgres://... node tests/sheetlessStatusPersistPg.test.js
 *
 * ★★ 스텁으로는 절대 못 잡는 것만 여기서 본다:
 *   ① 재생성이 실제로 `review_index` 를 지우는지 = **사고 재현**
 *   ② 그 뒤 대표 리뷰 이미지가 살아 있는지 = **보존 동작**
 *   ③ 작업표 칸에 쓴 제출·입금 표시가 재생성을 **통과해 되살아나는지**(왕복)
 *   ④ jsonb `||` 병합이 다른 칸을 지우지 않는지
 */
'use strict';

// ★ pool 은 require 시점에 DATABASE_URL 을 읽는다 — 반드시 최상단에서 옮긴다(paymentBatch 규율)
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
if (!process.env.PGTEST_URL) {
  console.log('PGTEST_URL 미설정 — 진짜 PG 검증 건너뜀 (스텁 가드는 sheetlessStatusPersist.test.js)');
  process.exit(0);
}

const pool = require('../src/db/pool');
const ledger = require('../src/services/sheetlessLedger.service');
const status = require('../src/services/sheetlessStatus.service');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name); fail++; }
}

const SHEET = 'wt_w3test0000000000';
const TAB = 'W3검증탭';
const GID = '900000001';
const HEADERS = ['번호', '구매일자', '수취인', '연락처', '리뷰제출', '입금'];

async function schema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tab_configs (
      sheet_id TEXT, tab_name TEXT, tab_gid TEXT, campaign_name TEXT,
      sheetless BOOLEAN DEFAULT FALSE, PRIMARY KEY (sheet_id, tab_name));
    CREATE TABLE IF NOT EXISTS campaign_participants (
      id BIGSERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, seq INT,
      row_json JSONB, source TEXT, deleted_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
      order_submission_id UUID, identity_key TEXT,
      UNIQUE (sheet_id, tab_name, seq));
    CREATE TABLE IF NOT EXISTS raw_sheet_tabs (
      sheet_id TEXT, sheet_url TEXT, spreadsheet_title TEXT, tab_gid TEXT, tab_name TEXT,
      row_count INT, col_count INT, headers JSONB, detected_headers JSONB,
      is_system_tab BOOLEAN, is_hidden BOOLEAN, checksum TEXT, mirrored_at TIMESTAMPTZ,
      PRIMARY KEY (sheet_id, tab_gid));
    CREATE TABLE IF NOT EXISTS raw_sheet_rows (
      sheet_id TEXT, tab_gid TEXT, tab_name TEXT, row_index INT, cells JSONB,
      mirrored_at TIMESTAMPTZ, PRIMARY KEY (sheet_id, tab_gid, row_index));
    CREATE TABLE IF NOT EXISTS review_index (
      id BIGSERIAL PRIMARY KEY, reviewer_name TEXT, sheet_id TEXT, tab_gid TEXT, tab_name TEXT,
      campaign_name TEXT, row_index INT, is_submitted BOOLEAN, is_submitted2 TEXT,
      product_url TEXT, product_name TEXT, submit_col TEXT, submit_col2 TEXT,
      row_json JSONB, start_date TEXT, end_date TEXT, round TEXT, phone8 TEXT,
      built_at TIMESTAMPTZ,
      review_file_id TEXT, review_file_url TEXT, review_file_name TEXT,
      review_file_count INT DEFAULT 0, review_file_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS index_master (
      sheet_id TEXT, tab_name TEXT, tab_gid TEXT, campaign_name TEXT, row_count INT,
      submitted_count INT, checksum TEXT, built_at TIMESTAMPTZ, status TEXT,
      skip_reason TEXT, error_msg TEXT, PRIMARY KEY (sheet_id, tab_name));
  `);
}

async function seed() {
  await pool.query('DELETE FROM campaign_participants WHERE sheet_id=$1', [SHEET]);
  await pool.query('DELETE FROM review_index WHERE sheet_id=$1', [SHEET]);
  await pool.query('DELETE FROM raw_sheet_rows WHERE sheet_id=$1', [SHEET]);
  await pool.query('DELETE FROM raw_sheet_tabs WHERE sheet_id=$1', [SHEET]);
  await pool.query('DELETE FROM index_master WHERE sheet_id=$1', [SHEET]);
  await pool.query('DELETE FROM tab_configs WHERE sheet_id=$1', [SHEET]);
  await pool.query(
    `INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheetless)
     VALUES ($1,$2,$3,'W3검증캠페인',TRUE)`, [SHEET, TAB, GID]);
  // 헤더는 2행, 데이터는 3~4행(작업표 seq = 시트 실제 행번호)
  for (const [seq, name, phone] of [[3, '김리뷰', '010-1111-2222'], [4, '박리뷰', '010-3333-4444']]) {
    await pool.query(
      `INSERT INTO campaign_participants (sheet_id, tab_name, seq, row_json, source)
       VALUES ($1,$2,$3,$4::jsonb,'worktable')`,
      [SHEET, TAB, seq, JSON.stringify({
        '번호': String(seq - 2), '구매일자': '8 / 7 (금)', '수취인': name,
        '연락처': phone, '리뷰제출': '', '입금': '',
      })]);
  }
}

(async () => {
  await schema();
  await seed();

  console.log('\n[1] 장부 생성 + 사고 재현');
  await ledger.rebuildLedgers({ sheetId: SHEET, tabName: TAB, columns: HEADERS });
  let { rows } = await pool.query(
    `SELECT row_index, reviewer_name, is_submitted, is_submitted2, submit_col, submit_col2
       FROM review_index WHERE sheet_id=$1 AND tab_name=$2 ORDER BY row_index`, [SHEET, TAB]);
  ok('작업표 2줄이 검색 명단으로 생성', rows.length === 2);
  ok('파서가 리뷰제출 열을 감지', rows[0] && rows[0].submit_col === '리뷰제출');
  ok('파서가 입금 열을 감지', rows[0] && rows[0].submit_col2 === '입금');

  // ★ 사고 재현 — review_index 에 직접 쓰면 재생성에 지워진다
  await pool.query(
    `UPDATE review_index SET is_submitted2='PAID', review_file_id='FID_KEEP',
            review_file_url='https://u', review_file_name='cap.jpg',
            review_file_count=2, review_file_at=NOW()
      WHERE sheet_id=$1 AND tab_name=$2 AND row_index=3`, [SHEET, TAB]);
  const rb = await ledger.rebuildLedgers({ sheetId: SHEET, tabName: TAB });
  ({ rows } = await pool.query(
    `SELECT is_submitted2, review_file_id, review_file_count FROM review_index
      WHERE sheet_id=$1 AND tab_name=$2 AND row_index=3`, [SHEET, TAB]));
  ok('★★ review_index 직접 쓴 입금표시는 재생성에 사라진다(고치려던 사고)',
    rows[0] && rows[0].is_submitted2 !== 'PAID');
  ok('★★ 대표 리뷰 이미지는 보존된다(W3 수정)',
    rows[0] && rows[0].review_file_id === 'FID_KEEP' && rows[0].review_file_count === 2);
  /* ★ 보고 값도 실제와 맞아야 한다 — 카운터만 0 으로 바꿔도 통과하면
     "몇 건을 보존했는지"가 거짓말이 되고 조용한 소실을 감지할 수 없다(변이시험 M2). */
  ok('보존 건수 보고가 실제와 일치(1건 대상 · 1건 복원)',
    rb && rb.filesSeen === 1 && rb.filesKept === 1);

  console.log('\n[2] 작업표 칸에 쓰면 재생성을 통과한다 (왕복)');
  const p = await status.markStatusCell({ sheetId: SHEET, tabName: TAB, rowIndex: 3, kind: 'paid', value: '2026-08-07 15:30' });
  ok('입금 기록 성공', p.handled === true && p.ok === true && p.column === '입금');
  ({ rows } = await pool.query(
    `SELECT is_submitted2, row_json FROM review_index
      WHERE sheet_id=$1 AND tab_name=$2 AND row_index=3`, [SHEET, TAB]));
  ok('★ 재생성 뒤에도 PAID 로 살아 있다', rows[0] && rows[0].is_submitted2 === 'PAID');
  ok('장부 row_json 에도 스탬프가 보인다', rows[0] && rows[0].row_json['입금'] === '2026-08-07 15:30');

  const s = await status.markStatusCell({ sheetId: SHEET, tabName: TAB, rowIndex: 4, kind: 'submit' });
  ok('리뷰제출 기록 성공', s.ok === true && s.column === '리뷰제출');
  ({ rows } = await pool.query(
    `SELECT is_submitted FROM review_index WHERE sheet_id=$1 AND tab_name=$2 AND row_index=4`, [SHEET, TAB]));
  ok('★ 재생성 뒤에도 제출 표시가 살아 있다', rows[0] && rows[0].is_submitted === true);

  // 한 번 더 재생성해도 유지(멱등)
  await ledger.rebuildLedgers({ sheetId: SHEET, tabName: TAB });
  ({ rows } = await pool.query(
    `SELECT row_index, is_submitted, is_submitted2, review_file_id FROM review_index
      WHERE sheet_id=$1 AND tab_name=$2 ORDER BY row_index`, [SHEET, TAB]));
  ok('재생성을 반복해도 유지(멱등)',
    rows[0].is_submitted2 === 'PAID' && rows[1].is_submitted === true && rows[0].review_file_id === 'FID_KEEP');

  console.log('\n[3] 병합은 다른 칸을 지우지 않는다');
  const { rows: cp } = await pool.query(
    `SELECT row_json FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND seq=3`, [SHEET, TAB]);
  ok('수취인·연락처·구매일자가 그대로', cp[0].row_json['수취인'] === '김리뷰'
    && cp[0].row_json['연락처'] === '010-1111-2222' && cp[0].row_json['구매일자'] === '8 / 7 (금)');
  ok('입금 칸만 새로 채워졌다', cp[0].row_json['입금'] === '2026-08-07 15:30');

  console.log('\n[4] 시트 기반 탭은 손대지 않는다');
  await pool.query(`UPDATE tab_configs SET sheetless=FALSE WHERE sheet_id=$1 AND tab_name=$2`, [SHEET, TAB]);
  const nx = await status.markStatusCell({ sheetId: SHEET, tabName: TAB, rowIndex: 3, kind: 'paid', value: 'zzz' });
  ok('시트 기반이면 handled:false (종전 시트 경로)', nx.handled === false);
  const { rows: cp2 } = await pool.query(
    `SELECT row_json FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND seq=3`, [SHEET, TAB]);
  ok('작업표를 건드리지 않았다', cp2[0].row_json['입금'] === '2026-08-07 15:30');

  console.log(`\n총 ${pass}개 통과${fail ? ` · ${fail}개 실패` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('실패:', e); process.exit(1); });
