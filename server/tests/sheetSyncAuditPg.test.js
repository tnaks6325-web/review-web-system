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
                         index_master, index_master_archive, tab_configs, campaigns CASCADE;
    CREATE TABLE campaigns (id SERIAL PRIMARY KEY, sheet_id TEXT, campaign_name TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE tab_configs (id SERIAL PRIMARY KEY, sheet_id TEXT NOT NULL, tab_name TEXT NOT NULL,
      tab_gid TEXT, display_name TEXT, campaign_name TEXT, is_closed BOOLEAN DEFAULT FALSE, UNIQUE(sheet_id, tab_name));
    CREATE TABLE raw_sheet_tabs (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_gid TEXT, tab_name TEXT,
      row_count INTEGER DEFAULT 0, mirrored_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE raw_sheet_rows (sheet_id TEXT, tab_gid TEXT, row_index INTEGER, cells JSONB,
      PRIMARY KEY (sheet_id, tab_gid, row_index));
    CREATE TABLE index_master (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, tab_gid TEXT,
      status TEXT DEFAULT 'active', built_at TIMESTAMPTZ, error_msg TEXT, skip_reason TEXT);
    CREATE TABLE index_master_archive (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT);
    CREATE TABLE review_index (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, row_index INTEGER);
    CREATE TABLE campaign_participants (id SERIAL PRIMARY KEY, sheet_id TEXT, tab_name TEXT, seq INTEGER,
      deleted_at TIMESTAMPTZ);`);

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

  svc.__setPoolForTest(null);
  await pool.end();
  console.log('\n✅ 진짜 PG 검증 전체 통과: ' + pass + '케이스');
  process.exit(0);
})().catch(async (e) => { console.error('\n❌ 실패:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
