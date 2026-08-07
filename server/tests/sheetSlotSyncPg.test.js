/**
 * 시트 우위 동기화 — **진짜 PostgreSQL** 검증 (스텁으로는 못 잡는 것만)
 *
 * 스텁 DB 는 SQL 을 해석하지 않는다. 그래서 아래 넷은 스텁 테스트를 100% 통과하면서도
 * 운영에서 조용히 틀릴 수 있다 — 여기서 실제 PG16 으로 실행해 고정한다.
 *   1. `cells->>$n::int` — 캐스트가 없으면 **에러가 아니라 전 행 NULL**(063 무음 고장 재현)
 *   2. 점검 쿼리의 LATERAL 조인 + `(sheet_id, tab_name) IN ((..),(..))` 튜플 IN 이 실제로 도는지
 *   3. 슬롯 INSERT 의 자리표시자 배치 + `ON CONFLICT (sheet_id, tab_name, seq) DO NOTHING` 멱등성
 *   4. 정원 교정 UPDATE 의 보호 조건(`recruit_total > 0 AND < target`)이 실제로 거르는지
 *
 * 실행: PGTEST_URL=postgres://... node tests/sheetSlotSyncPg.test.js
 *   (PGTEST_URL 이 없으면 skip — CI·개발기에서 조용히 통과하지 않고 "건너뜀"을 출력한다)
 *
 * ★★ PGTEST_URL → DATABASE_URL 이관은 **파일 최상단에서** 해야 한다 —
 *    pool 은 require 시점에 환경변수를 읽으므로 뒤늦게 설정하면 연결이 안 잡힌다(레포 실측).
 */
if (!process.env.PGTEST_URL) {
  console.log('⏭  PGTEST_URL 미설정 — 진짜 PG 검증 건너뜀(스텁 가드는 tests/sheetSlotSync.test.js)');
  process.exit(0);
}
process.env.DATABASE_URL = process.env.PGTEST_URL;

const assert = require('assert');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.PGTEST_URL });
const svc = require('../src/services/sheetSlotSync.service');
const participants = require('../src/services/participants.service');

let pass = 0;
const ta = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };

const HEADERS = ['번호', '담당자', '구매일자', '리뷰옵션', '인애드명단', '주문자제출', '수취인', 'id',
  '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '옵션금액', '비고(옵션확인)', '리뷰제출'];
const SHEET = 'SHEET_UREON', TAB = '8/3(네이버)우레온_바디미스트 100건', GID = '278673543';
const HEADER_ROW = 18;

async function schema() {
  await pool.query(`
    DROP TABLE IF EXISTS campaign_options, campaign_participants, raw_sheet_rows, raw_sheet_tabs, tab_configs,
                         recruit_campaigns, campaigns, order_submissions, review_index CASCADE;
    -- 연도 기준(tabActivity) 신호 테이블 — 점검 쿼리가 함께 읽는다
    CREATE TABLE campaigns (id SERIAL PRIMARY KEY, sheet_id TEXT, campaign_name TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE order_submissions (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT,
      submitted_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ);
    CREATE TABLE review_index (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, row_index INTEGER, start_date TEXT);
    CREATE TABLE tab_configs (
      id SERIAL PRIMARY KEY, sheet_id TEXT NOT NULL, tab_name TEXT NOT NULL, tab_gid TEXT,
      display_name TEXT, campaign_name TEXT, is_closed BOOLEAN DEFAULT FALSE, UNIQUE(sheet_id, tab_name));
    CREATE TABLE raw_sheet_tabs (
      id SERIAL PRIMARY KEY, sheet_id TEXT NOT NULL, tab_gid TEXT, tab_name TEXT,
      row_count INTEGER DEFAULT 0, mirrored_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE raw_sheet_rows (
      sheet_id TEXT NOT NULL, tab_gid TEXT NOT NULL, row_index INTEGER NOT NULL, cells JSONB,
      PRIMARY KEY (sheet_id, tab_gid, row_index));
    CREATE TABLE campaign_participants (
      id SERIAL PRIMARY KEY, sheet_id TEXT NOT NULL, tab_gid TEXT, tab_name TEXT NOT NULL,
      campaign_name TEXT, seq INTEGER NOT NULL, reviewer_name TEXT, recipient_name TEXT, phone8 TEXT,
      round TEXT, option_text TEXT, product_name TEXT, start_date TEXT, row_json JSONB,
      source TEXT NOT NULL DEFAULT 'import', updated_at TIMESTAMPTZ DEFAULT NOW(), updated_by TEXT,
      deleted_at TIMESTAMPTZ);
    CREATE UNIQUE INDEX uq_cp ON campaign_participants(sheet_id, tab_name, seq);
    CREATE TABLE recruit_campaigns (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT DEFAULT 'active',
      participation_mode BOOLEAN DEFAULT TRUE, recruit_total INTEGER DEFAULT 0, daily_limit INTEGER DEFAULT 0,
      linked_sheet_id TEXT DEFAULT '', linked_tab_name TEXT DEFAULT '', linked_tab_gid TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE campaign_options (
      id SERIAL PRIMARY KEY, campaign_id TEXT REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
      opt_key TEXT NOT NULL, pay_amount INTEGER DEFAULT 0, recruit_total INTEGER DEFAULT 0,
      daily_limit INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
      updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(campaign_id, opt_key));`);
}

async function seed() {
  await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, display_name, campaign_name)
                    VALUES ($1,$2,$3,$2,'우레온')`, [SHEET, TAB, GID]);
  // 연도 신호(2026 등록) — 없으면 연도 미상으로 분류돼 점검 대상에서 빠진다
  await pool.query(`INSERT INTO campaigns (sheet_id, campaign_name, created_at) VALUES ($1,$2,'2026-08-01')`, [SHEET, TAB]);
  await pool.query(`INSERT INTO raw_sheet_tabs (sheet_id, tab_gid, tab_name, row_count) VALUES ($1,$2,$3,118)`,
    [SHEET, GID, TAB]);
  // 상단 메타 + 헤더 줄
  await pool.query(`INSERT INTO raw_sheet_rows (sheet_id, tab_gid, row_index, cells) VALUES ($1,$2,1,$3)`,
    [SHEET, GID, JSON.stringify(['캠페인명', '8/3(네이버)우레온_바디미스트 100건'])]);
  await pool.query(`INSERT INTO raw_sheet_rows (sheet_id, tab_gid, row_index, cells) VALUES ($1,$2,$3,$4)`,
    [SHEET, GID, HEADER_ROW, JSON.stringify(HEADERS)]);
  // 데이터 100행: 앞 20행만 참여자 채움, 21~100 은 구매일자·리뷰옵션만(= 시트 준비 행)
  for (let i = 1; i <= 100; i++) {
    const rowIdx = HEADER_ROW + i;
    const c = new Array(HEADERS.length).fill('');
    c[0] = String(i);
    c[2] = `26.8.${Math.min(31, 3 + Math.floor((i - 1) / 5))}(월)`;
    c[3] = i <= 20 ? '텍스트' : '포토';
    if (i <= 20) { c[4] = '참여자' + i; c[6] = '참여자' + i; c[8] = '010-1111-' + String(1000 + i); }
    await pool.query(`INSERT INTO raw_sheet_rows (sheet_id, tab_gid, row_index, cells) VALUES ($1,$2,$3,$4)`,
      [SHEET, GID, rowIdx, JSON.stringify(c)]);
  }
  // 표에는 20행만 들어와 있다(이름 있는 행만 검색인덱스를 통과했으므로)
  for (let i = 1; i <= 20; i++) {
    await pool.query(
      `INSERT INTO campaign_participants (sheet_id, tab_gid, tab_name, seq, reviewer_name, phone8, source)
       VALUES ($1,$2,$3,$4,$5,$6,'import')`,
      [SHEET, GID, TAB, HEADER_ROW + i, '참여자' + i, '1111' + String(1000 + i)]);
  }
  await pool.query(
    `INSERT INTO recruit_campaigns (id, title, recruit_total, daily_limit, linked_sheet_id, linked_tab_name, linked_tab_gid)
     VALUES ('camp-ureon','우레온 바디미스트',100,5,$1,$2,$3)`, [SHEET, TAB, GID]);
  await pool.query(
    `INSERT INTO campaign_options (campaign_id, opt_key, recruit_total, status)
     VALUES ('camp-ureon','우레온 모이스처 바디 리셋 미스트',20,'active')`);
}

(async () => {
  console.log('\n▶ 시트 우위 동기화 — 진짜 PG16 검증\n');
  await schema();
  await seed();

  /* ── 1) jsonb 배열 인덱싱 ─────────────────────────────── */
  console.log('1) cells->>$n::int (무음 고장 재현)');
  await ta('★★ 캐스트 없는 `cells->>$3` 은 에러가 아니라 **전 행 NULL**(그래서 기능이 조용히 꺼진다)', async () => {
    const bad = await pool.query(
      `SELECT cells->>$3 AS v FROM raw_sheet_rows WHERE sheet_id=$1 AND tab_gid=$2 AND row_index > 18 LIMIT 5`,
      [SHEET, GID, '2']);
    assert.ok(bad.rows.every(r => r.v === null), '캐스트 없이도 값이 나온다면 이 함정이 사라진 것 — 가드 재검토');
    const good = await pool.query(
      `SELECT cells->>$3::int AS v FROM raw_sheet_rows WHERE sheet_id=$1 AND tab_gid=$2 AND row_index > 18 LIMIT 5`,
      [SHEET, GID, '2']);
    assert.ok(good.rows.every(r => r.v && r.v.length), '::int 캐스트로도 값이 안 나온다');
  });

  /* ── 2) 준비 행 판독 ──────────────────────────────────── */
  console.log('\n2) readPreparedRows — 실제 SQL 로 100행 판독');
  await ta('시트 준비 행 100개를 그대로 읽는다(표에는 20행뿐)', async () => {
    const out = await svc.readPreparedRows(pool, { sheetId: SHEET, tabGid: GID });
    assert.strictEqual(out.ok, true, '판독 실패: ' + out.reason);
    assert.strictEqual(out.headerRow, HEADER_ROW);
    assert.strictEqual(out.dateColumn, '구매일자');
    assert.strictEqual(out.optionColumn, '리뷰옵션');
    assert.strictEqual(out.prepared.length, 100, '준비 행 수가 100이 아니다');
    assert.strictEqual(out.prepared[0].seq, HEADER_ROW + 1, 'seq 가 시트 실제 행 번호가 아니다');
    assert.strictEqual(out.prepared[99].seq, HEADER_ROW + 100);
  });

  /* ── 3) 전수 점검 ─────────────────────────────────────── */
  console.log('\n3) auditSheetSuperiority — LATERAL·튜플 IN 실제 실행');
  await ta('우레온 탭이 시트 우위(+80)로 잡히고 공고 정원 불일치까지 함께 보고', async () => {
    svc.__setPoolForTest(pool);
    const out = await svc.auditSheetSuperiority({});
    const it = out.items.find(i => i.tabName === TAB);
    assert.ok(it, '점검 목록에 우레온 탭이 없다');
    assert.strictEqual(it.severity, 'sheet_ahead');
    assert.strictEqual(it.preparedRows, 100);
    assert.strictEqual(it.boardRows, 20);
    assert.strictEqual(it.missingSlots, 80, '부족 자리 계산이 80이 아니다');
    assert.ok(it.campaign && it.campaign.id === 'camp-ureon', '연결 공고를 못 찾았다');
    assert.strictEqual(it.quota.needsFix, true, '옵션 정원 20 < 표 100 인데 교정 대상이 아니다');
    assert.deepStrictEqual(it.quota.fixes.map(f => f.kind), ['option'], '총모집(100)은 이미 충분해 손대면 안 된다');
    svc.__setPoolForTest(null);
  });

  /* ── 4) 백필 ─────────────────────────────────────────── */
  console.log('\n4) backfillSlots — 실제 INSERT · 멱등 · 기존 행 보존');
  await ta('80자리 생성 후 표가 100행 · seq 는 19~118(시트 행 번호)', async () => {
    svc.__setPoolForTest(pool); participants.__setPoolForTest(pool);
    const pre = await svc.backfillSlots({ sheetId: SHEET, tabName: TAB });
    assert.strictEqual(pre.dryRun, true);
    assert.strictEqual(pre.missing, 80);
    const { rows: still } = await pool.query(`SELECT COUNT(*)::int n FROM campaign_participants`);
    assert.strictEqual(still[0].n, 20, '미리보기가 행을 만들었다');

    const out = await svc.backfillSlots({ sheetId: SHEET, tabName: TAB, dryRun: false });
    assert.strictEqual(out.created, 80);
    assert.strictEqual(out.boardRowsAfter, 100);
    const { rows: r } = await pool.query(
      `SELECT MIN(seq)::int lo, MAX(seq)::int hi, COUNT(*)::int n FROM campaign_participants WHERE deleted_at IS NULL`);
    assert.deepStrictEqual([r[0].lo, r[0].hi, r[0].n], [19, 118, 100]);
  });
  await ta('★ 새 자리에 구매일자·리뷰옵션이 담긴다(그리드가 시트처럼 그린다)', async () => {
    const { rows } = await pool.query(
      `SELECT option_text, start_date, row_json, source FROM campaign_participants WHERE seq=$1`, [HEADER_ROW + 21]);
    assert.strictEqual(rows[0].source, 'worktable');
    assert.strictEqual(rows[0].option_text, '포토');
    assert.ok(rows[0].start_date && rows[0].start_date.includes('26.8'), 'start_date 에 구매일자가 없다');
    assert.strictEqual(rows[0].row_json['리뷰옵션'], '포토');
    assert.ok(rows[0].row_json['구매일자'], 'row_json 에 구매일자가 없다');
  });
  await ta('★★ 다시 실행해도 0건(멱등) + 기존 참여자 행은 그대로', async () => {
    const again = await svc.backfillSlots({ sheetId: SHEET, tabName: TAB, dryRun: false });
    assert.strictEqual(again.created, 0, '중복 생성됐다');
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM campaign_participants WHERE deleted_at IS NULL`);
    assert.strictEqual(rows[0].n, 100, '행이 두 겹이 됐다');
    const { rows: keep } = await pool.query(
      `SELECT reviewer_name, source FROM campaign_participants WHERE seq=$1`, [HEADER_ROW + 1]);
    assert.strictEqual(keep[0].reviewer_name, '참여자1', '기존 참여자 행이 덮였다');
    assert.strictEqual(keep[0].source, 'import', '기존 행의 source 가 바뀌었다');
  });

  /* ── 5) 정원 교정 ─────────────────────────────────────── */
  console.log('\n5) applyQuotaFix — 조건부 UPDATE 실제 동작');
  await ta('옵션 정원 20 → 100(표 기준) · 총모집(100)은 이미 충분해 미접촉', async () => {
    const out = await svc.applyQuotaFix({ sheetId: SHEET, tabName: TAB, campaignId: 'camp-ureon' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.target, 100, '표 인원을 서버가 다시 세지 않았다');
    const { rows: o } = await pool.query(`SELECT recruit_total FROM campaign_options WHERE campaign_id='camp-ureon'`);
    assert.strictEqual(o[0].recruit_total, 100, '옵션 정원이 안 올라갔다 = 전체 마감이 안 풀린다');
    const { rows: c } = await pool.query(`SELECT recruit_total FROM recruit_campaigns WHERE id='camp-ureon'`);
    assert.strictEqual(c[0].recruit_total, 100, '총모집이 바뀌었다(이미 충분했는데)');
  });
  await ta('★ 두 번째 실행은 no-op(이미 충분) — 정원을 줄이지 않는다', async () => {
    await pool.query(`UPDATE campaign_options SET recruit_total=150 WHERE campaign_id='camp-ureon'`);
    const out = await svc.applyQuotaFix({ sheetId: SHEET, tabName: TAB, campaignId: 'camp-ureon' });
    assert.strictEqual(out.applied.length, 0);
    const { rows } = await pool.query(`SELECT recruit_total FROM campaign_options WHERE campaign_id='camp-ureon'`);
    assert.strictEqual(rows[0].recruit_total, 150, '남이 올려둔 값을 되돌렸다');
  });
  await ta('★ 0(무제한) 옵션은 손대지 않는다', async () => {
    await pool.query(`UPDATE campaign_options SET recruit_total=0 WHERE campaign_id='camp-ureon'`);
    await svc.applyQuotaFix({ sheetId: SHEET, tabName: TAB, campaignId: 'camp-ureon' });
    const { rows } = await pool.query(`SELECT recruit_total FROM campaign_options WHERE campaign_id='camp-ureon'`);
    assert.strictEqual(rows[0].recruit_total, 0, '무제한이던 옵션을 조였다');
  });
  await ta('★ 연결되지 않은 공고 id 는 거부(엉뚱한 공고 정원 변경 차단)', async () => {
    await pool.query(`INSERT INTO recruit_campaigns (id,title,recruit_total,linked_sheet_id,linked_tab_name)
                      VALUES ('other','남의 공고',5,'OTHER_SHEET','다른탭')`);
    const out = await svc.applyQuotaFix({ sheetId: SHEET, tabName: TAB, campaignId: 'other' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'campaign_mismatch');
    const { rows } = await pool.query(`SELECT recruit_total FROM recruit_campaigns WHERE id='other'`);
    assert.strictEqual(rows[0].recruit_total, 5, '남의 공고 정원이 바뀌었다');
  });

  /* ── 6) 점검 재실행 = 해소 확인 ───────────────────────── */
  console.log('\n6) 동기화 후 재점검');
  await ta('동기화·교정 후 그 탭은 더 이상 시트 우위가 아니다', async () => {
    const out = await svc.auditSheetSuperiority({});
    const it = out.items.find(i => i.tabName === TAB);
    if (it) {
      assert.strictEqual(it.missingSlots, 0, '아직 부족 자리가 남았다');
      assert.strictEqual(it.severity, 'ok');
    }
  });

  svc.__setPoolForTest(null); participants.__setPoolForTest(null);
  await pool.end();
  console.log('\n✅ 진짜 PG 검증 전체 통과: ' + pass + '케이스');
  process.exit(0);
})().catch(async (e) => { console.error('\n❌ 실패:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
