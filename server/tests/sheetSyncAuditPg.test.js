/**
 * 시트 데이터 반영 점검 — **진짜 PostgreSQL** 검증 (스텁으로는 못 잡는 SQL만)
 *
 * 여기서만 잡히는 것
 *   1. 실제 작업 건수 SQL — `jsonb_array_elements_text(cells)` + `btrim` 로 "값이 하나라도 있는 행"을
 *      세는 것이 실제로 도는지. 미러 33행(상단 캠페인 정보 9 + 빈 줄 + 헤더 + 데이터 15)에서 **15** 가 나와야 한다.
 *      이 값이 틀리면 화면이 "15건 작업"을 33건으로 말한다(사용자 실측 오해).
 *   2. 인덱스 진단 SQL — `= ANY($1::text[])` 배열 바인딩과 index_master / index_master_archive 조회.
 *   3. 감사 본 쿼리의 LATERAL 5개가 실제로 실행되는지(스텁은 SQL 을 해석하지 않는다).
 *
 * 실행: PGTEST_URL=postgres://... node tests/sheetSyncAuditPg.test.js
 * ★★ PGTEST_URL → DATABASE_URL 이관은 **파일 최상단에서**(pool 은 require 시점에 읽는다).
 */
if (!process.env.PGTEST_URL) {
  console.log('⏭  PGTEST_URL 미설정 — 진짜 PG 검증 건너뜀(스텁 가드는 tests/sheetSyncAudit.test.js)');
  process.exit(0);
}
process.env.DATABASE_URL = process.env.PGTEST_URL;

const assert = require('assert');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.PGTEST_URL });
const svc = require('../src/services/sheetSyncAudit.service');

let pass = 0;
const ta = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };

const SHEET = '19Ct7ZQ3ScYHmVwTaJ6KNyTlsRTcr325QKqOPlkE3E_0';
const TAB = '6/10퓨비아표백제_네이버15건';
const GID = '1244421967';
const HEADER_ROW = 18;
const HDRS = ['번호', '담당자', '구매일자', '빈박/실배', '인애드명단', '주문자제출', '수취인', 'id',
  '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰제출', '입금', '주문번호'];

async function setup() {
  await pool.query(`
    DROP TABLE IF EXISTS campaign_participants, review_index, raw_sheet_rows, raw_sheet_tabs,
                         index_master, index_master_archive, tab_configs, campaigns,
                         order_submissions, recruit_campaigns, app_settings CASCADE;
    CREATE TABLE campaigns (id SERIAL PRIMARY KEY, sheet_id TEXT, campaign_name TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tab_configs (id SERIAL PRIMARY KEY, sheet_id TEXT NOT NULL, tab_name TEXT NOT NULL,
      tab_gid TEXT, display_name TEXT, campaign_name TEXT, is_closed BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(sheet_id, tab_name));
    CREATE TABLE raw_sheet_tabs (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_gid TEXT, tab_name TEXT,
      row_count INTEGER DEFAULT 0, mirrored_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE raw_sheet_rows (sheet_id TEXT, tab_gid TEXT, row_index INTEGER, cells JSONB,
      PRIMARY KEY (sheet_id, tab_gid, row_index));
    CREATE TABLE index_master (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, tab_gid TEXT,
      status TEXT DEFAULT 'active', built_at TIMESTAMPTZ, error_msg TEXT, skip_reason TEXT);
    CREATE TABLE index_master_archive (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT,
      tab_gid TEXT, campaign_name TEXT, row_count INTEGER, archived_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE review_index (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, row_index INTEGER,
      start_date TEXT);
    CREATE TABLE campaign_participants (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, seq INTEGER,
      deleted_at TIMESTAMPTZ);
    CREATE TABLE order_submissions (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT,
      submitted_at TIMESTAMPTZ DEFAULT NOW(), deleted_at TIMESTAMPTZ);
    CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, title TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
      linked_sheet_id TEXT DEFAULT '', linked_tab_name TEXT DEFAULT '', linked_tab_gid TEXT DEFAULT '');
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());`);

  await pool.query(`INSERT INTO campaigns (sheet_id, campaign_name, created_at) VALUES ($1,$2,'2026-06-10')`, [SHEET, TAB]);
  await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, display_name) VALUES ($1,$2,$3,$2)`, [SHEET, TAB, GID]);
  await pool.query(`INSERT INTO raw_sheet_tabs (sheet_id, tab_gid, tab_name, row_count) VALUES ($1,$2,$3,33)`, [SHEET, GID, TAB]);

  // 실측 구조 그대로: 1~9 캠페인 정보, 10~17 빈 줄, 18 헤더, 19~33 데이터 15행
  const meta = [
    ['캠페인명', '6/10퓨비아표백제_네이버15건'], ['생성자(PM)', '이만수'], ['채널명', '쿠팡'],
    ['상품명', '아르퓨레'], ['상품URL', 'https://smartstore.naver.com/x'], ['구매시간대', '빈박스 14'],
    ['배송유형', '빈박스, 실배송 둘다'], ['택배대행여부', '인애드대행'], ['마감자료URL', ''],
  ];
  for (let i = 0; i < meta.length; i++) {
    await pool.query(`INSERT INTO raw_sheet_rows VALUES ($1,$2,$3,$4)`, [SHEET, GID, i + 1, JSON.stringify(meta[i])]);
  }
  for (let i = 10; i <= 17; i++) {   // 빈 줄(값 없음) — 세면 안 된다
    await pool.query(`INSERT INTO raw_sheet_rows VALUES ($1,$2,$3,$4)`, [SHEET, GID, i, JSON.stringify(['', '', ''])]);
  }
  await pool.query(`INSERT INTO raw_sheet_rows VALUES ($1,$2,$3,$4)`, [SHEET, GID, HEADER_ROW, JSON.stringify(HDRS)]);
  for (let i = 1; i <= 15; i++) {
    const c = new Array(HDRS.length).fill('');
    c[0] = String(i); c[2] = '6 / 11 (목)'; c[6] = '참여자' + i; c[8] = '010-9466-' + (5000 + i); c[13] = '23900';
    await pool.query(`INSERT INTO raw_sheet_rows VALUES ($1,$2,$3,$4)`, [SHEET, GID, HEADER_ROW + i, JSON.stringify(c)]);
  }
}

(async () => {
  console.log('\n▶ 시트 데이터 반영 점검 — 진짜 PG16 검증\n');
  await setup();
  svc.__setPoolForTest(pool);

  console.log('1) 실제 작업 건수 (미러 33행 ≠ 작업 15건)');
  await ta('★★ 헤더 아래 값 있는 행만 세어 15 — 상단 캠페인 정보 9행·빈 줄 8행은 제외', async () => {
    const out = await svc.auditSheetSync({});
    const it = out.items.find(i => i.tabName === TAB);
    assert.ok(it, '점검 목록에 탭이 없다');
    assert.strictEqual(it.rawRows, 33, '미러 행 수 픽스처가 33이 아니다');
    assert.strictEqual(it.dataRows, 15, `실제 작업 건수가 15가 아니다(=${it.dataRows}) — 화면이 33건으로 말하게 된다`);
  });

  console.log('\n2) 인덱스 미등록 원인 특정');
  await ta('★ 같은 시트가 등록부에 한 줄도 없음 → index_sheet_never_built', async () => {
    const out = await svc.auditSheetSync({});
    const it = out.items.find(i => i.tabName === TAB);
    assert.ok(it.flags.includes('index_sheet_never_built'), 'flags=' + it.flags);
    assert.strictEqual(it.indexHint.sheetIndexed, false);
  });
  await ta('★★ 인덱스에 같은 gid 가 있으면 미등록 분기에 오지 않는다(gid 우선 재매칭 — 도달 불가 분기 증명)', async () => {
    // 인덱스가 같은 자리(gid)를 다른 이름으로 들고 있으면 본 쿼리의 `OR tab_gid = ...` 가 매칭한다
    // → idxStatus 가 채워져 index_missing 계열이 아예 아니다. 여기에 리네임 힌트를 걸면 죽은 코드가 된다.
    await pool.query(`INSERT INTO index_master (sheet_id, tab_name, tab_gid, status, built_at)
                      VALUES ($1,'6/11퓨비아표백제_네이버15건',$2,'active',NOW())`, [SHEET, GID]);
    const out = await svc.auditSheetSync({});
    const it = out.items.find(i => i.tabName === TAB);
    assert.ok(!it.flags.some(f => String(f).startsWith('index_missing') || f === 'index_renamed' || f === 'index_sheet_never_built'),
      'gid 로 매칭됐는데 미등록으로 분류됐다: ' + it.flags);
    assert.strictEqual(it.idxStatus, 'active');
    await pool.query(`DELETE FROM index_master`);
  });
  await ta('★★ 시트의 실제 탭 이름이 바뀌었고 인덱스도 못 찾음 → index_renamed(양쪽 이름 표기)', async () => {
    // 실제 리네임 상황: 미러(시트 현재값)는 새 이름, tab_configs 는 옛 이름, 인덱스엔 어느 쪽도 없음
    await pool.query(`UPDATE raw_sheet_tabs SET tab_name='6/11퓨비아표백제_네이버15건' WHERE sheet_id=$1`, [SHEET]);
    const out = await svc.auditSheetSync({});
    const it = out.items.find(i => i.tabName === TAB);
    assert.ok(it.flags.includes('index_renamed'), 'flags=' + it.flags);
    assert.strictEqual(it.indexHint.renamedTo, '6/11퓨비아표백제_네이버15건');
    assert.ok(it.reasonKo.includes('6/11퓨비아표백제_네이버15건') && it.reasonKo.includes(TAB),
      '시트 실제 이름과 등록 이름을 둘 다 보여주지 않는다');
    await pool.query(`UPDATE raw_sheet_tabs SET tab_name=$2 WHERE sheet_id=$1`, [SHEET, TAB]);
  });
  await ta('★ 아카이브 기록이 있으면 index_archived 가 우선(복구 대상임을 먼저 알린다)', async () => {
    await pool.query(`INSERT INTO index_master_archive (sheet_id, tab_name) VALUES ($1,$2)`, [SHEET, TAB]);
    const out = await svc.auditSheetSync({});
    const it = out.items.find(i => i.tabName === TAB);
    assert.ok(it.flags.includes('index_archived'), 'flags=' + it.flags);
  });

  console.log('\n3) 정상 등록 시 회귀 없음');
  await ta('탭명 그대로 등록되고 인덱스·작업보드가 채워지면 ok', async () => {
    await pool.query(`DELETE FROM index_master_archive`);
    await pool.query(`DELETE FROM index_master`);
    await pool.query(`INSERT INTO index_master (sheet_id, tab_name, tab_gid, status, built_at)
                      VALUES ($1,$2,$3,'active',NOW())`, [SHEET, TAB, GID]);
    for (let i = 1; i <= 15; i++) {
      await pool.query(`INSERT INTO review_index (sheet_id, tab_name, row_index) VALUES ($1,$2,$3)`, [SHEET, TAB, HEADER_ROW + i]);
      await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, seq) VALUES ($1,$2,$3)`, [SHEET, TAB, HEADER_ROW + i]);
    }
    const out = await svc.auditSheetSync({});
    const it = out.items.find(i => i.tabName === TAB);
    assert.strictEqual(it.severity, 'ok', '정상인데 문제로 잡힌다: ' + it.reasonKo);
    assert.strictEqual(it.indexRows, 15);
    assert.strictEqual(it.boardRows, 15);
    // ok 탭은 정밀 보강 대상이 아니므로 dataRows 는 계산하지 않는다(무거운 쿼리 절약)
    assert.ok(it.dataRows == null, 'ok 탭까지 정밀 진단을 돌렸다');
  });

  console.log('\n4) 컷오프 필터(진짜 날짜 비교)');
  await ta('등록일 2026-06-10 은 before=2026-07-20 에 포함, before=2026-06-01 에는 제외', async () => {
    const inc = await svc.auditSheetSync({ before: '2026-07-20' });
    assert.ok(inc.items.some(i => i.tabName === TAB), '이전 등록 작업이 빠졌다');
    const exc = await svc.auditSheetSync({ before: '2026-06-01' });
    assert.ok(!exc.items.some(i => i.tabName === TAB), '기준일 이후 등록이 섞였다');
  });

  console.log('\n5) gid 해석·백필 (실제 SQL)');
  await ta('★ tab_configs.tab_gid 가 비면 시트 사본에서 찾아 탭 링크를 만든다', async () => {
    await pool.query(`UPDATE tab_configs SET tab_gid = NULL WHERE sheet_id=$1`, [SHEET]);
    const out = await svc.auditSheetSync({ includeArchived: true });
    const it = out.items.find(i => i.tabName === TAB);
    assert.strictEqual(it.resolvedGid, GID, 'gid 를 못 찾았다(시트만 열리는 링크가 된다)');
    assert.strictEqual(it.gidSource, 'mirror');
    assert.strictEqual(it.tabUrl, `https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=${GID}`);
  });
  await ta('★★ 동명 탭이 2개면 확정하지 않는다(엉뚱한 탭으로 데려가지 않음)', async () => {
    await pool.query(`INSERT INTO raw_sheet_tabs (sheet_id, tab_gid, tab_name, row_count) VALUES ($1,'999',$2,5)`, [SHEET, TAB]);
    const out = await svc.auditSheetSync({});
    const it = out.items.find(i => i.tabName === TAB);
    assert.strictEqual(it.resolvedGid, null, '동명 탭인데 gid 를 정했다');
    assert.strictEqual(it.gidSource, 'ambiguous');
    await pool.query(`DELETE FROM raw_sheet_tabs WHERE tab_gid='999'`);
  });
  await ta('백필 실행 → tab_configs.tab_gid 채워짐 · 재실행은 0건(이미 있는 값 미덮음)', async () => {
    const pre = await svc.backfillTabGids({});
    assert.strictEqual(pre.fillable, 1, '채울 대상을 못 찾았다');
    const out = await svc.backfillTabGids({ dryRun: false });
    assert.strictEqual(out.updated, 1);
    const { rows } = await pool.query(`SELECT tab_gid FROM tab_configs WHERE sheet_id=$1`, [SHEET]);
    assert.strictEqual(rows[0].tab_gid, GID);
    const again = await svc.backfillTabGids({ dryRun: false });
    assert.strictEqual(again.updated, 0, '이미 gid 가 있는데 또 썼다');
    assert.strictEqual(again.missing, 0);
  });

  console.log('\n6) 아카이브 전용 탭 합류');
  await ta('★ 등록 목록에 없고 아카이브에만 있는 탭도 includeArchived 로 보인다(복구 대상)', async () => {
    await pool.query(`INSERT INTO index_master_archive (sheet_id, tab_name, tab_gid, campaign_name, row_count, archived_at)
                      VALUES ($1,'5/20지난차수_네이버30건','777','지난차수',30,NOW())`, [SHEET]);
    const off = await svc.auditSheetSync({});
    assert.ok(!off.items.some(i => i.tabName === '5/20지난차수_네이버30건'), '기본 조회에 아카이브 탭이 섞였다');
    const on = await svc.auditSheetSync({ includeArchived: true });
    const it = on.items.find(i => i.tabName === '5/20지난차수_네이버30건');
    assert.ok(it, '아카이브 전용 탭이 목록에 없다 — 복구할 방법이 없어진다');
    assert.strictEqual(it.archivedOnly, true);
    assert.strictEqual(it.tabUrl, `https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=777`);
  });

  console.log('\n7) 연도 기준(2026~) — 활동 신호 LATERAL 실제 실행');
  await ta('★ 2025년 등록 + 주문 없음 = 목록에서 빠지고 filteredOld 로 고지', async () => {
    await pool.query(`UPDATE campaigns SET created_at='2025-06-10' WHERE sheet_id=$1`, [SHEET]);
    const out = await svc.auditSheetSync({});
    assert.ok(!out.items.some(i => i.tabName === TAB), '2025년 작업이 목록에 남았다');
    assert.strictEqual(out.filteredOld, 1, '제외 건수를 고지하지 않는다');
    assert.strictEqual(out.since, '2026-01-01');
  });
  await ta('★★ 같은 작업에 2026년 주문이 하나라도 있으면 되살아난다(최댓값 판정)', async () => {
    await pool.query(`INSERT INTO order_submissions (sheet_id, tab_name, submitted_at) VALUES ($1,$2,'2026-08-05')`, [SHEET, TAB]);
    const out = await svc.auditSheetSync({});
    const it = out.items.find(i => i.tabName === TAB);
    assert.ok(it, '2026년 주문이 있는데 과거로 숨겼다 — 살아있는 작업이 사라진다');
    assert.strictEqual(it.activitySource, 'order');
    assert.strictEqual(it.activityAt, '2026-08-05');
    assert.strictEqual(out.filteredOld, 0);
    await pool.query(`DELETE FROM order_submissions`);
  });
  await ta('★ 연결 공고 생성일도 신호로 잡힌다', async () => {
    await pool.query(`INSERT INTO recruit_campaigns (id, title, created_at, linked_sheet_id, linked_tab_name)
                      VALUES ('c-2026','공고','2026-03-01',$1,$2)`, [SHEET, TAB]);
    const out = await svc.auditSheetSync({});
    const it = out.items.find(i => i.tabName === TAB);
    assert.ok(it, '연결 공고가 2026년인데 숨겼다');
    assert.strictEqual(it.activitySource, 'campaign');
    await pool.query(`DELETE FROM recruit_campaigns`);
  });
  await ta('★ 신호가 하나도 없으면 yearUnknown 으로 분리 · includeUnknown 으로 열람', async () => {
    await pool.query(`DELETE FROM campaigns WHERE sheet_id=$1`, [SHEET]);
    await pool.query(`UPDATE review_index SET start_date=NULL WHERE sheet_id=$1`, [SHEET]);
    const off = await svc.auditSheetSync({});
    assert.ok(!off.items.some(i => i.tabName === TAB));
    assert.strictEqual(off.yearUnknown, 1, '연도 미상 건수를 고지하지 않는다');
    const on = await svc.auditSheetSync({ includeUnknown: true });
    const it = on.items.find(i => i.tabName === TAB);
    assert.ok(it, '[보기]로도 안 열린다');
    assert.strictEqual(it.yearUnknown, true);
  });
  await ta('★ 구매일자에 연도가 명시되면(26.8.24) 그것으로 살아난다', async () => {
    await pool.query(`UPDATE review_index SET start_date='26.8.24(월)' WHERE sheet_id=$1`, [SHEET]);
    const out = await svc.auditSheetSync({});
    const it = out.items.find(i => i.tabName === TAB);
    assert.ok(it, '연도 명시 구매일자를 신호로 못 썼다');
    assert.strictEqual(it.activitySource, 'sheet_date');
    // 연도 없는 표기는 신호가 아니다 → 다시 미상으로
    await pool.query(`UPDATE review_index SET start_date='6 / 11 (목)' WHERE sheet_id=$1`, [SHEET]);
    const back = await svc.auditSheetSync({});
    assert.ok(!back.items.some(i => i.tabName === TAB), '연도 없는 표기로 연도를 추론했다');
    assert.strictEqual(back.yearUnknown, 1);
  });

  console.log('\n8) 구매일 우선 판정 · 목록 제외 (실제 SQL)');
  await ta('★★ 구매일(마지막 날짜)이 2025면 시트 등록이 2026이어도 제외', async () => {
    await pool.query(`DELETE FROM app_settings WHERE key='tab_year_probe'`).catch(() => {});
    await pool.query(`INSERT INTO campaigns (sheet_id, campaign_name, created_at) VALUES ($1,$2,'2026-03-01')`, [SHEET, TAB]);
    await pool.query(`UPDATE review_index SET start_date='25.7.12(금)' WHERE sheet_id=$1`, [SHEET]);
    const out = await svc.auditSheetSync({});
    assert.ok(!out.items.some(i => i.tabName === TAB), '구매일이 2025인데 등록일로 되살아났다');
    assert.strictEqual(out.filteredOld, 1);
  });
  await ta('★ 구매일이 2026이면 목록에 남는다(마지막 날짜 기준)', async () => {
    await pool.query(`UPDATE review_index SET start_date='26.7.12(금)' WHERE sheet_id=$1`, [SHEET]);
    const out = await svc.auditSheetSync({});
    const it = out.items.find(i => i.tabName === TAB);
    assert.ok(it, '구매일 2026인데 제외됐다');
    assert.strictEqual(it.activitySource, 'sheet_date');
    assert.strictEqual(it.activityAt, '2026-07-12');
  });
  await ta('★★ 목록 제외 → 목록에서 빠지고 건수 고지 · includeIgnored 로 복원 열람 · 데이터 무손상', async () => {
    const before = (await pool.query(`SELECT COUNT(*)::int n FROM review_index`)).rows[0].n;
    await svc.setIgnored({ sheetId: SHEET, tabName: TAB });
    const off = await svc.auditSheetSync({});
    assert.ok(!off.items.some(i => i.tabName === TAB), '제외했는데 목록에 남았다');
    assert.strictEqual(off.ignoredCount, 1, '제외 건수를 고지하지 않는다');
    const on = await svc.auditSheetSync({ includeIgnored: true });
    assert.ok(on.items.find(i => i.tabName === TAB && i.ignored), '복원 열람이 안 된다');
    const after = (await pool.query(`SELECT COUNT(*)::int n FROM review_index`)).rows[0].n;
    assert.strictEqual(after, before, '★ 제외가 데이터를 지웠다 — 감추기만 해야 한다');
    await svc.setIgnored({ sheetId: SHEET, tabName: TAB, ignored: false });
    const back = await svc.auditSheetSync({});
    assert.ok(back.items.some(i => i.tabName === TAB), '되돌리기가 안 된다');
  });

  svc.__setPoolForTest(null);
  await pool.end();
  console.log('\n✅ 진짜 PG 검증 전체 통과: ' + pass + '케이스');
  process.exit(0);
})().catch(async (e) => { console.error('\n❌ 실패:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
