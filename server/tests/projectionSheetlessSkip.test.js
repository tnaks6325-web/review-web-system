/**
 * projectionSheetlessSkip.test.js — 회귀가드: 투영이 무시트 탭을 건너뛴다
 * 실행: node tests/projectionSheetlessSkip.test.js
 *
 * 배경(2026-08-23 프로덕션 실측): `참여 명단(review_index) → 작업표` 복사(importTabFromIndex)는
 *   시트 시절 흐름의 마지막 화살표다. 탈시트 이후 무시트 탭의 진실원본은 **작업표**이고
 *   review_index 는 거기서 만들어지므로, 그대로 두면 **결과물로 원본을 덮는다**.
 *   5분 스윕이 고친 번호를 이 복사가 10분마다 되돌렸다(대상 35→23→35→23 반복).
 *
 * 고정하는 것:
 *  A. 무시트 탭이면 임포트를 건너뛴다(쓰기 0) · 시트 기반 탭은 종전 동작 그대로
 *  B. ★★★ 건너뛴 탭에서는 `_reconcileSeen` 을 돌리지 않는다
 *     (임포트가 없었으므로 source='import' 활성 줄이 **전부** 비활성화된다)
 *  C. 게이트는 `importTabFromIndex` **안**에 있다 — 호출부 4곳이 모두 덮인다(판정 사본 0)
 *  D. `_enrichTab` 은 무시트 탭에서도 계속 돈다(row_json 무접촉 · 관제 재료 유지)
 *  E. 킬스위치 `TRACKB_PROJECT_SHEETLESS=1` 로 종전 동작 복귀
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const noLineComments = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
let passed = 0;
const ok = (n, c, e) => { assert(c, n + (e ? ' — ' + e : '')); passed++; console.log('  ✓ ' + n); };

const P = require('../src/services/participants.service');

function makePool(shapes) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    for (const [re, res] of shapes) if (re.test(sql)) return typeof res === 'function' ? res(params) : res;
    return { rows: [], rowCount: 0 };
  } };
}

(async () => {
  console.log('\n[A] 무시트 탭 = 임포트 건너뜀 · 쓰기 0');
  {
    const pool = makePool([[/FROM tab_configs/i, { rows: [{ s: true }] }]]);
    P.__setPoolForTest(pool);
    const r = await P.importTabFromIndex({ sheetId: 'S1', tabName: 'T1', by: 'cron' });
    ok('★★ 무시트 탭이면 skipped 로 즉시 반환', r.skipped === true && r.reason === 'sheetless', JSON.stringify(r));
    ok('★★ review_index 를 읽지도 않는다', !pool.calls.some(c => /FROM review_index/i.test(c.sql)));
    ok('★★ 쓰기 쿼리 0건', !pool.calls.some(c => /^(INSERT|UPDATE|DELETE)\b/i.test(c.sql)));
    ok('★ 건수는 0 으로 보고한다(집계가 부풀지 않게)', r.inserted === 0 && r.updated === 0);
  }

  console.log('\n[A2] 시트 기반 탭 = 종전 동작(무회귀)');
  {
    const pool = makePool([
      [/FROM tab_configs/i, { rows: [{ s: false }] }],
      [/FROM review_index/i, { rows: [] }],
      [/FROM workdesk_participant_deletions/i, { rows: [] }],
      [/COUNT\(\*\)::int AS n FROM campaign_participants/i, { rows: [{ n: 0 }] }],
    ]);
    P.__setPoolForTest(pool);
    const r = await P.importTabFromIndex({ sheetId: 'S2', tabName: 'T2', dryRun: true, by: 'cron' });
    ok('★ 시트 기반 탭은 건너뛰지 않는다', !r.skipped, JSON.stringify(r));
    ok('★ review_index 를 실제로 읽는다', pool.calls.some(c => /FROM review_index/i.test(c.sql)));
  }

  console.log('\n[B] ★★★ 건너뛴 탭에서는 seen-set 정리를 돌리지 않는다');
  {
    const src = noLineComments(read('src/services/trackB.service.js'));
    const blk = src.slice(src.indexOf('async function projectTab('), src.indexOf('async function _enrichTab('));
    ok('★★★ imp.skipped 면 _reconcileSeen 을 부르지 않는다',
      /imp && imp\.skipped\)\s*\?\s*\{[^}]*deactivated: 0/.test(blk.replace(/\s+/g, ' ')), blk.slice(-260));
    ok('★ 건너뛴 사실을 응답에 싣는다(조용한 생략 금지)', /reconcileSkipped: true/.test(blk));
    /* 왜 위험한가를 조건으로 고정 — 이 SQL 이 남아 있는 한 임포트 없이 돌리면 전멸한다. */
    /* ★ 고정 폭 슬라이스 금지 — 선언 위치에서 **다음 함수 선언까지** 자른다(레포 규율). */
    const recStart = src.indexOf('async function _reconcileSeen(');
    const rec = src.slice(recStart, src.indexOf('\nasync function ', recStart + 10));
    ok('★ 그 정리는 imported_at < runStart 인 import 행을 비활성화한다(= 임포트 없이 돌리면 전부)',
      /source = 'import'/.test(rec) && /imported_at IS NULL OR imported_at < /.test(rec));
  }

  console.log('\n[C] 게이트 위치 — 호출부 4곳이 모두 덮인다(판정 사본 0)');
  {
    const ps = noLineComments(read('src/services/participants.service.js'));
    const fn = ps.slice(ps.indexOf('async function importTabFromIndex('), ps.indexOf('async function syncImportedTabs('));
    ok('★★ 게이트가 importTabFromIndex 안에 있다', /isSheetless\(db, sheetId, tabName\)/.test(fn));
    ok('★ 판정은 utils/sheetlessScope 단일 출처(사본 0)', /require\('\.\.\/utils\/sheetlessScope'\)/.test(fn));
    /* 호출부 열거 — 늘어나면 여기서 드러난다(바깥에 게이트를 또 두지 말 것). */
    const callers = [];
    ['src/services/trackB.service.js', 'src/services/participants.service.js', 'src/routes/participants.routes.js']
      .forEach(f => { const n = (read(f).match(/importTabFromIndex\(/g) || []).length; if (n) callers.push(f + ':' + n); });
    ok('★ 호출부는 여전히 3파일(투영·동기화·수동 라우트)', callers.length === 3, callers.join(', '));
    ok('★ 동기화 크론은 건너뛴 탭을 "동기화했다"로 세지 않는다', /if \(r && r\.skipped\) \{ skipped\+\+; continue; \}/.test(ps));
  }

  console.log('\n[D] enrich 는 계속 돈다 — row_json 무접촉');
  {
    const src = noLineComments(read('src/services/trackB.service.js'));
    const blk = src.slice(src.indexOf('async function projectTab('), src.indexOf('async function _enrichTab('));
    ok('★ projectTab 이 무시트에서도 _enrichTab 을 부른다(조건 없이)',
      /const enr = await _enrichTab\(\{ sheetId, tabName \}\);/.test(blk) && !/skipped[^]*_enrichTab/.test(blk));
    const en = src.slice(src.indexOf('async function _enrichTab('), src.indexOf('async function _reconcileSeen('));
    const up = en.slice(en.indexOf('UPDATE campaign_participants'));
    ok('★★ enrich 의 UPDATE 는 row_json 을 쓰지 않는다(되돌림과 무관)',
      up.indexOf('row_json') < 0 || up.indexOf('row_json') > up.indexOf('WHERE'), up.slice(0, 160));
    ok('★ 주문 링크는 blank-only(기존 값 미덮음)', /order_submission_id = COALESCE\(/.test(up));
  }

  console.log('\n[E] 킬스위치');
  {
    process.env.TRACKB_PROJECT_SHEETLESS = '1';
    const pool = makePool([
      [/FROM tab_configs/i, { rows: [{ s: true }] }],
      [/FROM review_index/i, { rows: [] }],
      [/FROM workdesk_participant_deletions/i, { rows: [] }],
      [/COUNT\(\*\)::int AS n FROM campaign_participants/i, { rows: [{ n: 0 }] }],
    ]);
    P.__setPoolForTest(pool);
    const r = await P.importTabFromIndex({ sheetId: 'S1', tabName: 'T1', dryRun: true, by: 'x' });
    ok('★ TRACKB_PROJECT_SHEETLESS=1 이면 무시트 탭도 종전대로 임포트한다', !r.skipped, JSON.stringify(r));
    delete process.env.TRACKB_PROJECT_SHEETLESS;
  }

  console.log(`\n✅ projectionSheetlessSkip 회귀가드 통과 (${passed}케이스)`);
  process.exit(0);
})().catch(e => { console.error('\n❌ 실패:', e.message); process.exit(1); });
