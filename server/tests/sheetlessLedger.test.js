/**
 * sheetlessLedger.test.js — 탈 구글시트 W1 회귀가드 (장부 생성기 + 크론 단속)
 * 실행: node tests/sheetlessLedger.test.js
 *   진짜 PG 검증까지: PGTEST_URL=postgres://... node tests/sheetlessLedger.test.js
 *
 * 고정하는 것:
 *  A. 순수함수 — 헤더 결정 우선순위 / 작업표 → 2차원 배열(seq 자리 보존·헤더 행 위치)
 *  B. fail-closed — 시트 기반 탭에서는 장부를 만들지 않는다(시트 값 덮어쓰기 사고 차단)
 *  C. 판정 사본 0 — 검색 명단은 **기존 파서**(indexBuilder.parseTabRows)를 통과해 나온다
 *  D. 크론 단속 — smartBuild·RAW 미러·변경감지가 무시트 시트/탭을 건너뛴다(구조 1)
 *  E. 두 장부의 행 수 차이가 **의도**임을 고정(raw=빈 슬롯 포함 / index=이름 있는 행만)
 *  F. (PGTEST_URL) 진짜 PG — 장부 생성 결과가 `listActiveTabs` 에 실제로 뜨는지(구조 2)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ★ pool 은 require 시점에 DATABASE_URL 을 읽는다 — 파일 최상단에서 옮겨야 연결이 잡힌다
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;

const srv = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ledger = require('../src/services/sheetlessLedger.service');
const scope = require('../src/utils/sheetlessScope');

let passed = 0, skipped = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }
function skip(name) { skipped++; console.log('  – ' + name + ' (skip)'); }

/* ══════════════ A. 순수함수 ══════════════ */
console.log('\n[A] 헤더 결정 · 2차원 배열 조립');
{
  const rows = [{ seq: 3, row_json: { 번호: '1', 이름: '김' } }];
  ok('헤더 우선순위 ① 저장된 장부 헤더(재생성마다 열이 흔들리지 않게)',
    ledger.resolveHeaders({ storedHeaders: ['A', 'B'], columns: ['C'], rows }).source === 'stored');
  ok('헤더 우선순위 ② 호출자 열 구성(첫 생성)',
    ledger.resolveHeaders({ storedHeaders: null, columns: ['번호', '이름'], rows }).headers.join() === '번호,이름');
  ok('헤더 우선순위 ③ row_json 키(최후 폴백)',
    ledger.resolveHeaders({ storedHeaders: [], columns: [], rows }).source === 'row_json');
  ok('헤더 없음 = source none(호출부가 막는다)',
    ledger.resolveHeaders({ storedHeaders: [], columns: [], rows: [] }).source === 'none');
  ok('빈 문자열 헤더는 무시(저장된 값이 비면 다음 우선순위로)',
    ledger.resolveHeaders({ storedHeaders: ['', '  '], columns: ['X'], rows }).headers.join() === 'X');
}
{
  const headers = ['번호', '이름', '연락처'];
  const rows = [
    { seq: 3, row_json: { 번호: '1', 이름: '김철수', 연락처: '010-1111-2222' } },
    { seq: 5, row_json: { 번호: '3', 이름: '', 연락처: '' } },          // 빈 슬롯
  ];
  const { values, headerRow } = ledger.buildValues({ headers, rows });
  ok('헤더 행 = 첫 데이터 바로 위(최소 seq − 1)', headerRow === 2);
  ok('헤더가 그 자리에 놓인다', values[1].join() === '번호,이름,연락처');
  // ★★ seq 자리 보존 — 어긋나면 주문 배정·투영이 다른 행을 가리켜 표가 두 겹이 된다
  ok('행은 자기 seq 자리에 놓인다(3행·5행)', values[2][1] === '김철수' && values[4][0] === '3');
  ok('사이의 빈 행(4행)은 빈 배열로 남는다', Array.isArray(values[3]) && values[3].length === 0);
  ok('빈 슬롯도 배열이 만들어진다(행배정할 자리)', values[4].length === 3);
  ok('헤더에 없는 키는 실리지 않는다(열 구성이 진실)',
    ledger.buildValues({ headers: ['번호'], rows }).values[2].length === 1);
}

/* ══════════════ B·C·E. 서비스 실행(스텁 pool) ══════════════ */
console.log('\n[B·C·E] 게이트 · 파서 재사용 · 두 장부의 행 수');
function makeStub({ sheetless = true, parts = [], storedHeaders = null, registered = true }) {
  const log = { sql: [], client: [], released: 0 };
  const client = {
    query(sql, params) {
      log.client.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return Promise.resolve({ rows: [] });
    },
    release() { log.released++; },
  };
  const db = {
    query(sql, params) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      log.sql.push({ sql: q, params });
      if (/FROM tab_configs/.test(q)) {
        return Promise.resolve({ rows: registered ? [{ tab_gid: '77', campaign_name: '테스트업체', sheetless }] : [] });
      }
      if (/FROM campaign_participants/.test(q)) return Promise.resolve({ rows: parts });
      if (/FROM raw_sheet_tabs/.test(q)) return Promise.resolve({ rows: storedHeaders ? [{ headers: storedHeaders }] : [] });
      return Promise.resolve({ rows: [] });
    },
    connect() { return Promise.resolve(client); },
  };
  return { db, client, log };
}

const HEADERS = ['번호', '구매일자', '주문자', '연락처', '결제금액', '리뷰제출', '입금'];
const PARTS = [
  { seq: 3, row_json: { 번호: '1', 구매일자: '8 / 7 (금)', 주문자: '김철수', 연락처: '010-1111-2222', 결제금액: '22000', 리뷰제출: 'O', 입금: '' } },
  { seq: 4, row_json: { 번호: '2', 구매일자: '8 / 7 (금)', 주문자: '이영희', 연락처: '010-3333-4444', 결제금액: '22000', 리뷰제출: '', 입금: '' } },
  { seq: 5, row_json: { 번호: '3', 구매일자: '8 / 8 (토)', 주문자: '', 연락처: '', 결제금액: '', 리뷰제출: '', 입금: '' } }, // 빈 슬롯
];

(async () => {
  // B. fail-closed — 시트 기반 탭
  {
    const { db, log } = makeStub({ sheetless: false, parts: PARTS });
    ledger.__setPoolForTest(db);
    let code = '';
    try { await ledger.rebuildLedgers({ sheetId: 'S1', tabName: 'T1' }); } catch (e) { code = e.code; }
    ok('시트 기반 탭에서는 거부(not_sheetless) — 시트 값 덮어쓰기 차단', code === 'not_sheetless');
    ok('거부 시 쓰기 트랜잭션을 열지 않는다', !log.client.length);
  }
  {
    const { db } = makeStub({ registered: false });
    ledger.__setPoolForTest(db);
    let code = '';
    try { await ledger.rebuildLedgers({ sheetId: 'S1', tabName: 'T1' }); } catch (e) { code = e.code; }
    ok('미등록 탭 거부(tab_not_registered) — 접수 단일 관문 유지', code === 'tab_not_registered');
  }
  {
    const { db } = makeStub({ parts: [] });
    ledger.__setPoolForTest(db);
    let code = '';
    try { await ledger.rebuildLedgers({ sheetId: 'S1', tabName: 'T1' }); } catch (e) { code = e.code; }
    ok('열 구성을 모르면 거부(no_headers) — 빈 장부를 만들지 않는다', code === 'no_headers');
  }

  // C·E. dryRun 으로 파서 결과 확인(쓰기 0)
  {
    const { db, log } = makeStub({ parts: PARTS, storedHeaders: HEADERS });
    ledger.__setPoolForTest(db);
    const r = await ledger.rebuildLedgers({ sheetId: 'S1', tabName: 'T1', dryRun: true });
    ok('dryRun 은 쓰기 0(connect 미호출)', !log.client.length);
    ok('헤더 출처 = 저장된 장부', r.headerSource === 'stored');
    // ★★ 두 장부의 행 수가 다른 것은 의도 — raw 는 빈 슬롯 포함, 명단은 이름 있는 행만
    ok('raw 미러 = 빈 슬롯 포함 전 행(3행)', r.mirrorRows === 3);
    ok('검색 명단 = 이름 있는 행만(2행) — 파서 규칙 그대로', r.indexRows === 2);
    ok('제출 판정도 파서가 한다(1건)', r.submittedCount === 1);
  }

  // C. 실제 쓰기 — 장부 3권 모두에 기록되는지
  {
    const { db, log } = makeStub({ parts: PARTS, storedHeaders: HEADERS });
    ledger.__setPoolForTest(db);
    const r = await ledger.rebuildLedgers({ sheetId: 'S1', tabName: 'T1', by: '테스트' });
    const sqls = log.client.map(c => c.sql);
    ok('트랜잭션으로 감싼다(BEGIN/COMMIT)', sqls[0] === 'BEGIN' && sqls[sqls.length - 1] === 'COMMIT');
    ok('① 시트 사본 갱신(raw_sheet_tabs upsert + rows 재기록)',
      sqls.some(s => /INSERT INTO raw_sheet_tabs/.test(s)) &&
      sqls.some(s => /DELETE FROM raw_sheet_rows/.test(s)) &&
      sqls.filter(s => /INSERT INTO raw_sheet_rows/.test(s)).length === 4);   // 헤더행 + 데이터 3
    ok('② 검색 명단 재기록(그 탭만 DELETE 후 INSERT)',
      sqls.some(s => /DELETE FROM review_index WHERE sheet_id = \$1 AND tab_name = \$2/.test(s)) &&
      sqls.filter(s => /INSERT INTO review_index/.test(s)).length === 2);
    ok('③ 작업 등록부 활성 등록(index_master status=active) — 목록 노출 게이트',
      sqls.some(s => /INSERT INTO index_master/.test(s) && /'active'/.test(s)));
    ok('커넥션 반납', log.released === 1);
    ok('요약 반환(미러 4행·명단 2행)', r.mirrorRows === 4 && r.indexRows === 2);
  }

  // C. 파서 사본이 없다는 것을 소스로 고정
  {
    const src = srv('src/services/sheetlessLedger.service.js');
    ok('검색 명단은 기존 파서를 통과한다(사본 금지)', /_ib\.parseTabRows\(/.test(src) && /require\('\.\/indexBuilder\.service'\)/.test(src));
    ok('키워드·컬럼매핑도 시트 경로와 같은 것을 쓴다',
      /loadKeywordsFromDB\(\)/.test(src) && /getTabColumnIndexMap\(/.test(src));
    ok('자체 키워드 표를 만들지 않는다(드리프트 차단)',
      !/NAME_KEYWORDS\s*=/.test(src) && !/SUBMIT_KEYWORDS\s*=/.test(src));
    ok('구글 시트 API 무접촉(읽기·쓰기 0)',
      !/sheets\.service|readSheet|writeSheet|appendSheet|getSpreadsheetMeta/.test(src));
  }

  /* ══════════════ D. 크론 단속 ══════════════ */
  console.log('\n[D] 크론 단속 — 무시트 시트·탭을 구글에 묻지 않는다');
  {
    const im = srv('src/services/indexBuilder.service.js');
    const rm = srv('src/services/rawMirror.service.js');
    const sb = srv('src/services/smartBuild.service.js');
    ok('RAW 미러 스윕: 전부 무시트인 시트 제외', /fullySheetlessSheetIds\(pool\)/.test(rm) && /sheetIds\.filter\(id => !_slSheets\.has\(id\)\)/.test(rm));
    ok('RAW 미러 요약에 제외 건수 고지(조용한 누락 금지)', /sheetlessSkipped/.test(rm));
    // ★★ 시트를 실제로 읽는 크론은 셋 — smartBuild(5분) · buildIndexSmart(전체빌드) · checkDirtySheets(변경감지).
    //   ★ smartBuild 를 빠뜨리면 이관한 탭을 5분마다 다시 읽어 **작업표로 만든 장부를 옛 시트 값으로 덮는다**
    //     (구현 중 실제로 빠져 있었고 회귀가드가 잡았다 — 이 셋을 함께 고정할 것).
    const gates = (im.match(/filter\(id => !_slSheets\.has\(id\)\)/g) || []).length
                + (sb.match(/filter\(id => !_slSheets\.has\(id\)\)/g) || []).length;
    ok('세 스윕 모두 시트 단위 게이트 통과(한 곳만 막으면 새 나간다)', gates === 3);
    // ★★ 탭 단위 게이트 — 이관은 한 시트 안에서 탭별로 진행된다(같은 시트에 시트 기반 탭이 남는다)
    ok('전체빌드 탭 게이트: 무시트 탭은 시트에서 빌드하지 않는다',
      /isSheetlessTab\(sheetlessKeys, sheetId, t\.properties\.title/.test(im) && /skippedSheetless/.test(im));
    ok('스마트빌드(5분 크론) 탭 게이트 — 장부 덮어쓰기 차단',
      /isSheetlessTab\(sheetlessKeys, sheetId, t\.properties\.title/.test(sb) && /tabsSkippedSheetless/.test(sb));
    ok('탭 게이트 재료를 실제로 읽는다(sheetlessTabKeys 조회 — 두 빌더 호출부 모두)',
      (im.match(/sheetlessTabKeys\(pool\)/g) || []).length === 2 && /sheetlessTabKeys\(pool\)/.test(sb));
    ok('스마트빌드 요약에 무시트 제외 건수 고지(조용한 누락 금지)',
      /무시트 \$\{result\.tabsSkippedSheetless\}탭 제외/.test(sb)
      && /result\.tabsSkippedSheetless\+\+;/.test(sb));   // ★ 증가까지 — 문구만 보면 카운터 제거를 통과시킨다
  }
  {
    // 판정 유틸 실행 — fail-open(조회 실패는 빈 집합 = 종전 동작)
    const boom = { query: () => Promise.reject(new Error('42703')) };
    ok('컬럼 미적용/조회 실패는 fail-open(스윕이 멈추지 않는다)',
      (await scope.fullySheetlessSheetIds(boom)).size === 0 &&
      (await scope.sheetlessTabKeys(boom)).size === 0 &&
      (await scope.isSheetless(boom, 'S', 'T')) === false);
    // ★ 손으로 만든 Set 이 아니라 **실제 조회 결과**로 검증한다 —
    //   빈 gid 가 키를 만드는 회귀는 손수 만든 Set 으로는 절대 안 잡힌다(변이시험 실측).
    const dbKeys = { query: () => Promise.resolve({ rows: [
      { sheet_id: 'S1', tab_name: 'T1', tab_gid: '77' },
      { sheet_id: 'S1', tab_name: 'T9', tab_gid: '' },     // gid 없는 탭
    ] }) };
    const built = await scope.sheetlessTabKeys(dbKeys);
    ok('빈 gid 는 키를 만들지 않는다(조회 결과 실측 — 이름 2 + gid 1 = 3키)', built.size === 3);
    ok('빈 gid 탭도 이름으로는 잡힌다', scope.isSheetlessTab(built, 'S1', 'T9'));
    ok('빈 gid 로 만든 키가 남의 탭을 잡지 않는다', !scope.isSheetlessTab(built, 'S1', '남의탭', ''));
    const keys = new Set([scope.tabKey('S1', 'T1'), scope.tabKey('S1', 'gid:77')]);
    ok('탭 판정: 이름 → gid 순', scope.isSheetlessTab(keys, 'S1', 'T1') && scope.isSheetlessTab(keys, 'S1', '다른이름', '77'));
    ok('빈 gid 로는 매칭되지 않는다(전부 매칭 사고 차단)', !scope.isSheetlessTab(keys, 'S1', '다른이름', ''));
    ok('무관한 탭은 false', !scope.isSheetlessTab(keys, 'S2', 'T1'));
    const src = srv('src/utils/sheetlessScope.js');
    ok('시트 단위 제외는 "등록 탭이 전부 무시트"일 때만(BOOL_AND)', /BOOL_AND\(COALESCE\(sheetless, FALSE\)\) = TRUE/.test(src));
    ok('리터럴 NUL 미사용(git 바이너리 취급 → grep 가드 무력화 방지)', !/\u0000/.test(src));
  }
  {
    const mig = srv('migrations/096_sheetless_tabs.sql');
    ok('migration 096: 컬럼 추가만 · 기본값 FALSE(배포 즉시 동작 불변)',
      /ADD COLUMN IF NOT EXISTS sheetless BOOLEAN NOT NULL DEFAULT FALSE/.test(mig)
      && !/DROP |DELETE |UPDATE tab_configs SET/.test(mig));
    ok('migration 096: 이관 이력 컬럼 + 부분 인덱스', /sheetless_at/.test(mig) && /sheetless_by/.test(mig) && /WHERE sheetless = TRUE/.test(mig));
  }

  /* ══════════════ F. 진짜 PG — 장부가 실제로 목록에 뜨는가 ══════════════ */
  console.log('\n[F] 진짜 PG16 — 생성한 장부가 작업 목록·검색에 걸리는가');
  if (!process.env.PGTEST_URL) {
    skip('PGTEST_URL 미설정 — 장부 생성 → listActiveTabs 노출');
    skip('PGTEST_URL 미설정 — 검색 명단 phone8 기록');
  } else {
    const pool = require('../src/db/pool');
    const participants = require('../src/services/participants.service');
    const S = 'PGT_SHEETLESS', T = '8/7테스트_무시트';
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS tab_configs (
        sheet_id TEXT, tab_name TEXT, tab_gid TEXT, campaign_name TEXT, is_closed BOOLEAN DEFAULT FALSE)`);
      for (const f of ['096_sheetless_tabs.sql']) {
        // ★ 줄 주석을 먼저 걷어낸다 — 안 걷으면 "주석 블록 + ALTER" 가 한 덩어리로 잡혀
        //   startsWith('--') 로 통째 skip 되고, 컬럼이 없는 채로 테스트가 42703 을 맞는다(실측).
        const sql = srv('migrations/' + f).split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
        for (const stmt of sql.split(';')) {
          const t = stmt.trim(); if (t) { try { await pool.query(t); } catch (_) {} }
        }
      }
      await pool.query(`CREATE TABLE IF NOT EXISTS campaign_participants (
        sheet_id TEXT, tab_name TEXT, tab_gid TEXT, seq INTEGER, row_json JSONB, deleted_at TIMESTAMPTZ)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS raw_sheet_tabs (
        sheet_id TEXT, sheet_url TEXT, spreadsheet_title TEXT, tab_gid TEXT, tab_name TEXT,
        row_count INT, col_count INT, headers JSONB, detected_headers JSONB,
        is_system_tab BOOLEAN DEFAULT FALSE, is_hidden BOOLEAN DEFAULT FALSE, checksum TEXT,
        mirrored_at TIMESTAMPTZ, UNIQUE(sheet_id, tab_gid))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS raw_sheet_rows (
        sheet_id TEXT, tab_gid TEXT, tab_name TEXT, row_index INT, cells JSONB, mirrored_at TIMESTAMPTZ,
        UNIQUE(sheet_id, tab_gid, row_index))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS index_master (
        sheet_id TEXT, tab_name TEXT, tab_gid TEXT, campaign_name TEXT, row_count INT,
        submitted_count INT, last_date TEXT, checksum TEXT, built_at TIMESTAMPTZ,
        status TEXT DEFAULT 'active', skip_reason TEXT, error_msg TEXT, UNIQUE(sheet_id, tab_name))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS review_index (
        id SERIAL, reviewer_name TEXT, sheet_id TEXT, tab_gid TEXT, tab_name TEXT, campaign_name TEXT,
        row_index INT, is_submitted BOOLEAN, is_submitted2 TEXT, product_url TEXT, product_name TEXT,
        submit_col TEXT, submit_col2 TEXT, row_json JSONB, start_date TEXT, end_date TEXT,
        round TEXT, phone8 TEXT, built_at TIMESTAMPTZ)`);

      await pool.query('DELETE FROM tab_configs WHERE sheet_id=$1', [S]);
      await pool.query('DELETE FROM campaign_participants WHERE sheet_id=$1', [S]);
      await pool.query('DELETE FROM raw_sheet_tabs WHERE sheet_id=$1', [S]);
      await pool.query('DELETE FROM raw_sheet_rows WHERE sheet_id=$1', [S]);
      await pool.query('DELETE FROM index_master WHERE sheet_id=$1', [S]);
      await pool.query('DELETE FROM review_index WHERE sheet_id=$1', [S]);

      await pool.query(
        `INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheetless) VALUES ($1,$2,'99','테스트업체',TRUE)`, [S, T]);
      for (const p of PARTS) {
        await pool.query(`INSERT INTO campaign_participants (sheet_id, tab_name, tab_gid, seq, row_json)
                          VALUES ($1,$2,'99',$3,$4::jsonb)`, [S, T, p.seq, JSON.stringify(p.row_json)]);
      }

      ledger.__setPoolForTest(null);          // 진짜 pool 사용
      const r = await ledger.rebuildLedgers({ sheetId: S, tabName: T, columns: HEADERS, by: 'pgtest' });

      const tabs = await participants.listActiveTabs({ limit: 50 });
      ok('장부 생성 → 작업 목록(listActiveTabs)에 실제로 뜬다(구조 2 해소)',
        tabs.some(t => t.sheetId === S && t.tabName === T));

      const { rows: ri } = await pool.query(
        'SELECT reviewer_name, phone8, row_index, is_submitted FROM review_index WHERE sheet_id=$1 ORDER BY row_index', [S]);
      ok('검색 명단: 이름 있는 행만 · phone8 추출 · seq 자리 보존',
        ri.length === 2 && ri[0].reviewer_name === '김철수' && ri[0].phone8 === '11112222' && ri[0].row_index === 3);
      ok('제출 판정이 시트 경로와 같다(1건)', ri.filter(x => x.is_submitted).length === 1);

      const { rows: rr } = await pool.query(
        'SELECT row_index FROM raw_sheet_rows WHERE sheet_id=$1 ORDER BY row_index', [S]);
      ok('시트 사본: 헤더행 + 빈 슬롯 포함(행배정 자리 확보)',
        rr.length === 4 && rr[0].row_index === 2 && rr[3].row_index === 5);

      // 재실행 멱등 — 같은 결과
      const r2 = await ledger.rebuildLedgers({ sheetId: S, tabName: T, by: 'pgtest' });
      ok('재실행 멱등(행 수 동일 · 헤더는 저장값 재사용)',
        r2.mirrorRows === r.mirrorRows && r2.indexRows === r.indexRows && r2.headerSource === 'stored');

      // 크론 게이트 — 전부 무시트인 시트는 스윕에서 빠진다
      const sl = await scope.fullySheetlessSheetIds(pool);
      ok('전부 무시트인 시트가 스윕 제외 집합에 잡힌다', sl.has(S));

      await pool.query('DELETE FROM tab_configs WHERE sheet_id=$1', [S]);
      await pool.query('DELETE FROM campaign_participants WHERE sheet_id=$1', [S]);
      await pool.query('DELETE FROM raw_sheet_tabs WHERE sheet_id=$1', [S]);
      await pool.query('DELETE FROM raw_sheet_rows WHERE sheet_id=$1', [S]);
      await pool.query('DELETE FROM index_master WHERE sheet_id=$1', [S]);
      await pool.query('DELETE FROM review_index WHERE sheet_id=$1', [S]);
    } catch (e) {
      console.error('  ✗ PG 검증 실패:', e.message);
      throw e;
    }
  }

  console.log(`\n✅ sheetlessLedger: ${passed}개 통과${skipped ? ` (${skipped}개 skip)` : ''}`);
  process.exit(0);   // trackB/pool 핸들이 열려 있어 명시 종료(레포 관용구)
})().catch(e => { console.error(e); process.exit(1); });
