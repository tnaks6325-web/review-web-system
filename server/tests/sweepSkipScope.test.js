'use strict';
/**
 * sweepSkipScope.test.js — "주기 스윕이 어느 시트를 건너뛰는가" 게이트 회귀가드 (탈 구글시트 5단계)
 *
 * 왜 이 파일이 따로 있나: 이 판정은 **SQL 한 문장이 전부**라 스텁 DB 로는 한 글자도 검증되지 않는다
 * (스텁은 SQL 을 해석하지 않는다 — `cells->>$n::int` 사고와 같은 계열). 진짜 PG16 로 돌린다.
 *
 *   PGTEST_URL=postgres://... node tests/sweepSkipScope.test.js
 *   (PGTEST_URL 없으면 정적 검사만 하고 통과 — 배선·킬스위치·사본 금지)
 */
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.error('  ✗', name); } }
const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  const scope = require('../src/utils/sheetlessScope');

  /* ══════════ A. 사본 금지 · 배선 ══════════ */
  console.log('\n[A] 판정 사본 0 — 게이트는 한 문장, 소비처는 그것을 부르기만');
  {
    const s = src('src/utils/sheetlessScope.js');
    ok('넓은 규칙이 열거식(REGISTERED_SHEET_IDS_SQL)을 재사용한다(사본 금지)',
      /const SWEEP_SKIP_SHEET_IDS_SQL = `[\s\S]*\$\{REGISTERED_SHEET_IDS_SQL\}/.test(s));
    ok('마감 탭과 등록 탭 0 을 모두 제외 대상으로 본다',
      /BOOL_AND\(\s*\n?\s*t\.sheet_id IS NULL[\s\S]{0,200}COALESCE\(t\.sheetless, FALSE\)[\s\S]{0,120}COALESCE\(t\.is_closed, FALSE\)/.test(s));
    ok('킬스위치 SHEET_SWEEP_SKIP_WIDE=0 이면 좁은(구) 규칙으로 복귀',
      /SHEET_SWEEP_SKIP_WIDE === '0'[\s\S]{0,80}FULLY_SHEETLESS_SHEET_IDS_SQL/.test(s));
    ok('조회 실패는 빈 집합(fail-open — 게이트가 죽어도 스윕은 계속)',
      /catch \(_\) \{\s*return new Set\(\);/.test(s));
    // ★ 소비처 4곳이 같은 함수를 부른다 — 한 곳만 옛 이름으로 남으면 그 스윕만 계속 읽는다
    for (const f of ['src/services/rawMirror.service.js', 'src/services/smartBuild.service.js',
                     'src/services/indexBuilder.service.js', 'src/services/sheetReadScope.service.js']) {
      ok(`${path.basename(f)} 가 게이트 함수를 부른다`, /sweepSkipSheetIds\(/.test(src(f)));
    }
    ok('옛 이름(fullySheetlessSheetIds) 호출부 0 — 이름이 남으면 의미가 갈린다',
      !/fullySheetlessSheetIds\s*\(/.test(
        ['src/services/rawMirror.service.js', 'src/services/smartBuild.service.js',
         'src/services/indexBuilder.service.js', 'src/services/sheetReadScope.service.js']
          .map(src).join('\n')));
  }

  /* ══════════ B. 읽기 전용 ══════════ */
  console.log('\n[B] 게이트는 아무것도 쓰지 않는다');
  {
    const s = src('src/utils/sheetlessScope.js');
    ok('쓰기 쿼리 0(INSERT/UPDATE/DELETE 문장 없음)',
      !/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(s));
    ok('구글 시트/Drive API 무접촉', !/sheets\.service|readSheet|googleapis/.test(s));
  }

  if (!process.env.PGTEST_URL) {
    console.log('\n[PG] PGTEST_URL 없음 — 정적 검사만 수행');
  } else {
    /* ══════════ C. 진짜 PG16 ══════════ */
    console.log('\n[C] 진짜 PG16 — 네 갈래를 실제로 판정한다');
    const pool = require('../src/db/pool');
    const P = 'swskip_';
    try {
      // ★ 표는 만들지 않는다 — **운영 스키마 그대로** 써야 NOT NULL·기본값 같은 실제 제약을 통과하는지 알 수 있다.
      await pool.query(`DELETE FROM tab_configs WHERE sheet_id LIKE $1`, [P + '%']);
      await pool.query(`DELETE FROM campaigns WHERE sheet_id LIKE $1`, [P + '%']);

      const S = k => P + k;
      await pool.query(`INSERT INTO campaigns (sheet_id, campaign_name) VALUES
        ($1,'t'),($2,'t'),($3,'t'),($4,'t'),($5,'t')`,
        [S('live'), S('sheetless'), S('closed'), S('none'), S('mixed')]);
      await pool.query(`INSERT INTO tab_configs (sheet_id, tab_name, sheetless, is_closed) VALUES
        ($1,'T1',FALSE,FALSE),
        ($2,'T1',TRUE ,FALSE),
        ($3,'T1',FALSE,TRUE ), ($3,'T2',TRUE ,FALSE),
        ($4,'T1',FALSE,TRUE ), ($4,'T2',FALSE,FALSE)`,
        [S('live'), S('sheetless'), S('closed'), S('mixed')]);

      delete process.env.SHEET_SWEEP_SKIP_WIDE;
      const wide = await scope.sweepSkipSheetIds(pool);
      ok('① 시트 기반 활성 탭이 있으면 계속 읽는다', !wide.has(S('live')));
      ok('② 전부 무시트면 건너뛴다(종전 동작 유지)', wide.has(S('sheetless')));
      ok('③ 마감 + 무시트만 남으면 건너뛴다(이번 확장)', wide.has(S('closed')));
      ok('④ 등록 탭이 0 이어도 건너뛴다(campaigns 행만 잔존 — 이번 확장)', wide.has(S('none')));
      ok('⑤ 마감 탭이 섞여 있어도 활성 탭이 하나 있으면 읽는다(완화 금지)', !wide.has(S('mixed')));

      // ★★ 킬스위치 — 되돌리면 ③④ 가 다시 "읽는 시트" 가 되어야 한다(코드 변경 0 으로 복귀)
      process.env.SHEET_SWEEP_SKIP_WIDE = '0';
      const narrow = await scope.sweepSkipSheetIds(pool);
      delete process.env.SHEET_SWEEP_SKIP_WIDE;
      ok('킬스위치 OFF → 마감만 남은 시트는 다시 읽는다', !narrow.has(S('closed')));
      ok('킬스위치 OFF → 등록 탭 0 시트도 다시 읽는다', !narrow.has(S('none')));
      ok('킬스위치 OFF 여도 전부 무시트는 그대로 제외', narrow.has(S('sheetless')));

      // ★ 되살아나는 판정 — 마감을 풀면 그 즉시 다시 읽는다(영구화 없음)
      await pool.query(`UPDATE tab_configs SET is_closed = FALSE WHERE sheet_id = $1 AND tab_name='T1'`, [S('closed')]);
      const after = await scope.sweepSkipSheetIds(pool);
      ok('마감을 풀면 즉시 다시 읽는다(아카이브 복구·재접수 경로 보존)', !after.has(S('closed')));

      await pool.query(`DELETE FROM tab_configs WHERE sheet_id LIKE $1`, [P + '%']);
      await pool.query(`DELETE FROM campaigns WHERE sheet_id LIKE $1`, [P + '%']);
    } catch (e) {
      fail++; console.error('  ✗ PG 검증 실패:', e.message);
    }
  }

  console.log(`\n결과: ${pass} 통과 · ${fail} 실패`);
  assert.strictEqual(fail, 0, '회귀가드 실패');
  process.exit(0);
})();
