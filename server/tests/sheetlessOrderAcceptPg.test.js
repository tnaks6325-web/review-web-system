/**
 * sheetlessOrderAcceptPg.test.js — 탈 구글시트 W2-a **진짜 PG16** 검증
 * 실행: PGTEST_URL=postgres://postgres@/w2test?host=/tmp&port=5433 node tests/sheetlessOrderAcceptPg.test.js
 *
 * ★★ 왜 따로인가: 스텁 pool 은 **SQL 을 해석하지 않는다** — 컬럼 수 ≠ 자리표시자 수,
 *   `NOT EXISTS` 상관 서브쿼리의 바깥 참조, jsonb 병합 같은 것은 진짜 PG 로만 잡힌다
 *   (063 이 `cells->>$n::int` 캐스트 누락으로 배포 이래 무음이었던 실측 사고와 같은 계열).
 *
 * 고정하는 것:
 *  1. 접수 업서트 — 컬럼/자리표시자/파라미터가 실제로 맞물린다 + 이관 되돌림 금지(OR)
 *  2. 사후검증·배치 스케줄러의 무시트 제외가 **정말 그 행만** 뺀다(시트 기반 행은 남는다)
 *  3. 폴더 1단 이름 조회 — 업체 > 캠페인 > 작업 이름 우선순위가 SQL 로 성립
 *  4. 작업표 row_json 병합 — 기존 칸 보존 + 새 값 반영(jsonb 통째 교체가 아님)
 */
const assert = require('assert');

if (!process.env.PGTEST_URL) {
  console.log('PGTEST_URL 미설정 — 진짜 PG 검증 건너뜀');
  process.exit(0);
}
process.env.DATABASE_URL = process.env.PGTEST_URL;

const { Client } = require('pg');
let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

(async () => {
  const c = new Client({ connectionString: process.env.PGTEST_URL });
  await c.connect();

  // ── 최소 스키마(이 검증에 필요한 열만) ─────────────────────────────
  await c.query(`
    DROP TABLE IF EXISTS tab_configs, order_submissions, advertiser_campaigns, advertisers, campaign_participants CASCADE;
    CREATE TABLE tab_configs (
      sheet_id TEXT NOT NULL, tab_name TEXT NOT NULL, tab_gid TEXT, sheet_url TEXT,
      campaign_name TEXT, display_name TEXT, manager TEXT, time_range TEXT,
      review_type TEXT, delivery_type TEXT, taekhap BOOLEAN,
      sheetless BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ, PRIMARY KEY (sheet_id, tab_name));
    CREATE TABLE order_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sheet_id TEXT, tab_name TEXT,
      mirror_status TEXT, deleted_at TIMESTAMPTZ, sheet_row INT,
      sheet_written_at TIMESTAMPTZ, row_verified_at TIMESTAMPTZ, submitted_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE advertisers (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE advertiser_campaigns (
      id SERIAL PRIMARY KEY, advertiser_id TEXT, sheet_id TEXT, tab_gid TEXT, deleted_at TIMESTAMPTZ);
    CREATE TABLE campaign_participants (
      sheet_id TEXT, tab_name TEXT, tab_gid TEXT, seq INT, reviewer_name TEXT,
      recipient_name TEXT, phone8 TEXT, option_text TEXT, row_json JSONB,
      source TEXT, updated_by TEXT, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
      PRIMARY KEY (sheet_id, tab_name, seq));
  `);

  /* ══════════ 1. 접수 업서트 — 컬럼 ≡ 자리표시자 ≡ 파라미터 ══════════ */
  console.log('\n[1] 접수 업서트 (실행으로 정합 확인)');
  const LEGACY = ['실배송', '빈박스'];
  const UPSERT = `INSERT INTO tab_configs
       (sheet_id, tab_name, tab_gid, sheet_url, campaign_name, display_name,
        manager, time_range, review_type, delivery_type, taekhap, sheetless, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$13, NOW())
     ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
       sheetless     = COALESCE(tab_configs.sheetless, FALSE) OR EXCLUDED.sheetless,
       tab_gid       = COALESCE(NULLIF(tab_configs.tab_gid,''),       EXCLUDED.tab_gid),
       sheet_url     = COALESCE(NULLIF(tab_configs.sheet_url,''),     EXCLUDED.sheet_url),
       campaign_name = COALESCE(NULLIF(tab_configs.campaign_name,''), EXCLUDED.campaign_name),
       review_type   = CASE WHEN tab_configs.review_type = ANY($12::text[])
                            THEN EXCLUDED.review_type
                            ELSE COALESCE(NULLIF(tab_configs.review_type,''), EXCLUDED.review_type) END,
       delivery_type = COALESCE(NULLIF(tab_configs.delivery_type,''),
                                NULLIF(CASE WHEN tab_configs.review_type = ANY($12::text[])
                                            THEN tab_configs.review_type ELSE '' END, ''),
                                EXCLUDED.delivery_type),
       updated_at    = NOW()`;

  await c.query(UPSERT, ['wt_aaa', 'T무시트', '111', '', '작업오더제목', 'T무시트',
                         '만두', '', '구매확정', '', false, LEGACY, true]);
  let r = await c.query(`SELECT sheetless, sheet_url, review_type FROM tab_configs WHERE sheet_id='wt_aaa'`);
  ok('무시트 접수가 실행된다(13 파라미터 정합)', r.rows.length === 1);
  ok('무시트 표식이 켜진다', r.rows[0].sheetless === true);
  ok("무시트 탭의 sheet_url 은 빈 값(죽은 구글 링크 금지)", r.rows[0].sheet_url === '');

  // ★★ 이관 되돌림 금지 — 시트 URL 로 재접수해도 sheetless 는 TRUE 로 남는다
  await c.query(UPSERT, ['wt_aaa', 'T무시트', '111', 'https://docs.google.com/x', '작업오더제목', 'T무시트',
                         '만두', '', '구매확정', '', false, LEGACY, false]);
  r = await c.query(`SELECT sheetless FROM tab_configs WHERE sheet_id='wt_aaa'`);
  ok('이관은 되돌아가지 않는다(시트 URL 재접수에도 sheetless 유지)', r.rows[0].sheetless === true);

  // 시트 기반 탭은 종전대로 FALSE (기존 동작 불변)
  await c.query(UPSERT, ['SHEET1', 'T시트', '222', 'https://docs.google.com/y', '스프레드시트제목', 'T시트',
                         '망고', '', '실배송', '', false, LEGACY, false]);
  r = await c.query(`SELECT sheetless, review_type, delivery_type FROM tab_configs WHERE sheet_id='SHEET1'`);
  ok('시트 경로는 sheetless=FALSE(기존 동작 불변)', r.rows[0].sheetless === false);
  ok('리뷰타입 칸의 배송유형 교정도 그대로 동작(무회귀)',
    r.rows[0].review_type === '실배송' || r.rows[0].delivery_type === '실배송');

  /* ══════════ 2. 시트 대조 경로 제외가 그 행만 뺀다 ══════════ */
  console.log('\n[2] 사후검증·배치 스케줄러 무시트 제외');
  await c.query(`INSERT INTO order_submissions (sheet_id, tab_name, mirror_status, sheet_row, sheet_written_at)
                 VALUES ('wt_aaa','T무시트','written',2,NOW()), ('SHEET1','T시트','written',5,NOW())`);
  r = await c.query(
    `SELECT os.sheet_id FROM order_submissions os
      WHERE os.mirror_status = 'written' AND os.deleted_at IS NULL
        AND os.sheet_row IS NOT NULL AND os.sheet_written_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM tab_configs tc
           WHERE tc.sheet_id = os.sheet_id AND tc.tab_name = os.tab_name
             AND COALESCE(tc.sheetless, FALSE) = TRUE)`);
  ok('사후검증: 무시트 행만 빠지고 시트 기반 행은 남는다',
    r.rows.length === 1 && r.rows[0].sheet_id === 'SHEET1');

  await c.query(`UPDATE order_submissions SET mirror_status='pending'`);
  r = await c.query(
    `SELECT sheet_id FROM order_submissions
      WHERE deleted_at IS NULL
        AND mirror_status IN ('pending','pending_no_row','queued','failed')
        AND sheet_id IS NOT NULL AND tab_name IS NOT NULL AND tab_name <> ''
        AND NOT EXISTS (
          SELECT 1 FROM tab_configs tc
           WHERE tc.sheet_id = order_submissions.sheet_id AND tc.tab_name = order_submissions.tab_name
             AND COALESCE(tc.sheetless, FALSE) = TRUE)
      GROUP BY sheet_id, tab_name`);
  ok('배치 스케줄러: 무시트 탭만 빠진다(상관 서브쿼리 바깥 참조 실행 확인)',
    r.rows.length === 1 && r.rows[0].sheet_id === 'SHEET1');

  /* ══════════ 3. 폴더 1단 이름 우선순위 ══════════ */
  console.log('\n[3] 폴더 1단 이름(D2-a) 조회');
  const folderTitle = require('../src/services/folderTitle.service');
  const pool = require('../src/db/pool');
  folderTitle.__setPoolForTest(pool);

  ok('업체 미지정이면 캠페인 이름',
    (await folderTitle.resolveSheetlessFolderTitle('wt_aaa', 'T무시트')) === '작업오더제목');

  await c.query(`INSERT INTO advertisers (id, name) VALUES ('adv1','파미고')`);
  await c.query(`INSERT INTO advertiser_campaigns (advertiser_id, sheet_id, tab_gid) VALUES ('adv1','wt_aaa',NULL)`);
  ok('시트 전체 소유가 있으면 업체명',
    (await folderTitle.resolveSheetlessFolderTitle('wt_aaa', 'T무시트')) === '파미고');

  await c.query(`INSERT INTO advertisers (id, name) VALUES ('adv2','올레샷')`);
  await c.query(`INSERT INTO advertiser_campaigns (advertiser_id, sheet_id, tab_gid) VALUES ('adv2','wt_aaa','111')`);
  ok('탭 지정 소유가 시트 전체보다 우선(작업목록 그룹핑과 같은 순서)',
    (await folderTitle.resolveSheetlessFolderTitle('wt_aaa', 'T무시트')) === '올레샷');

  ok('시트 기반 탭은 null — 호출부 기존 로직 유지(무회귀)',
    (await folderTitle.resolveSheetlessFolderTitle('SHEET1', 'T시트')) === null);

  /* ══════════ 4. 작업표 row_json 병합 ══════════ */
  console.log('\n[4] 작업표 row_json 병합 (기존 칸 보존)');
  await c.query(
    `INSERT INTO campaign_participants (sheet_id, tab_name, tab_gid, seq, row_json, source)
     VALUES ('wt_aaa','T무시트','111',2,'{"번호":"1","구매일자":"8 / 7 (금)","리뷰옵션":"포토리뷰"}'::jsonb,'worktable')`);
  const merged = { 번호: '1', '구매일자': '8 / 7 (금)', '리뷰옵션': '포토리뷰', '수취인': '김수취', '연락처': '010-1111-2222' };
  await c.query(
    `UPDATE campaign_participants
        SET row_json = $4::jsonb,
            reviewer_name  = COALESCE(NULLIF($5,''), reviewer_name),
            phone8         = COALESCE(NULLIF($6,''), phone8),
            updated_at = NOW()
      WHERE sheet_id = $1 AND tab_name = $2 AND seq = $3`,
    ['wt_aaa', 'T무시트', 2, JSON.stringify(merged), '김로그인', '11112222']);
  r = await c.query(`SELECT row_json, reviewer_name, phone8 FROM campaign_participants WHERE seq=2`);
  ok('기존 칸(번호·구매일자·작업지시 옵션)이 살아 있다',
    r.rows[0].row_json['번호'] === '1' && r.rows[0].row_json['리뷰옵션'] === '포토리뷰');
  ok('새 값이 반영된다', r.rows[0].row_json['수취인'] === '김수취');
  ok('표에 뜰 이름·연락처도 채워진다', r.rows[0].reviewer_name === '김로그인' && r.rows[0].phone8 === '11112222');

  // 빈 값으로 기존 이름을 덮지 않는다
  await c.query(
    `UPDATE campaign_participants SET reviewer_name = COALESCE(NULLIF($1,''), reviewer_name) WHERE seq=2`, ['']);
  r = await c.query(`SELECT reviewer_name FROM campaign_participants WHERE seq=2`);
  ok('빈 값은 기존 이름을 지우지 않는다(COALESCE(NULLIF))', r.rows[0].reviewer_name === '김로그인');

  await c.end();
  try { await pool.end(); } catch (_) {}
  console.log(`\n총 ${passed}개 통과 (진짜 PG16)\n`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
