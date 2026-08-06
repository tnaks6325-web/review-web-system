/**
 * inspectViewTrim.test.js — 리뷰검수 화면 정리(사용자 확정 2026-08-06).
 *
 *   ① 유형별 일괄 재검수 — 유형 칩(예 '리뷰화면 아님')을 고른 상태의 [♻ …재검수]는
 *      **그 유형 건들만** 다시 검수한다(작업 선택 없이도).
 *   ② [↻ 과거분 검수] 제거 · ③ [CSV] 제거 — 기능 불필요
 *   ④ 상태 칩은 **[의심＋불량] · [확인됨]** 둘뿐 — 이 화면의 목적이 "의심·불량만 모아 보기"
 *
 * 고정하는 불변식:
 *   A. 유형 판정은 **화면 단일 출처**(_riIssueTypes) — 서버에 유형 조건 사본을 만들지 않는다
 *      (그래서 서버는 파일ID 목록만 받는다). 상한·중복제거·빈 목록 처리.
 *   B. 대상이 **라벨에 드러난다** — 무엇이 돌지 모르는 버튼을 두지 않는다.
 *   C. 제거한 버튼은 흔적 0(누르면 죽는 버튼 금지). 서버 라우트는 남는다(되살리기 쉽게).
 *   D. 칩 축소 — 통과·미검수·전체 제거, [확인됨]은 남긴다(처리한 건에 닿는 유일한 경로).
 *
 * 실행: node tests/inspectViewTrim.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WD = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

const poolPath = require.resolve('../src/db/pool');
let _q = [];
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true, exports: {
    query: async (sql, params) => { _q.push({ sql, params }); return { rows: [], rowCount: 3 }; },
    // withJobLock 전용 커넥션 — 스윕은 이 테스트의 관심사가 아니라 busy 로 즉시 양보시킨다
    connect: async () => ({
      query: async () => ({ rows: [{ locked: false }] }),
      release: () => {},
    }),
  },
};
const RI = require('../src/services/reviewInspect.service');

(async () => {
  /* ═══ A. 서버 — 파일ID 목록만 받는다 ═══ */
  console.log('\nA) 재검수 대상 — 작업 전체 또는 화면이 고른 건들');
  {
    const svc = read('src/services/reviewInspect.service.js');
    const fn = svc.slice(svc.indexOf('async function reinspectTab('), svc.indexOf('async function runInspectSweep('));
    assert.ok(/file_id = ANY\(\$1::text\[\]\)/.test(fn), 'fileIds 경로');
    assert.ok(/sheet_id = \$1 AND tab_name = \$2/.test(fn), '작업 전체 경로(종전) 보존');
    assert.ok(/status IN \('fail', 'suspect', 'unverifiable'\)/.test(fn),
      "★ 어느 경로든 되돌리는 것은 fail/suspect/unverifiable 뿐(확인됨·통과는 보존)");
    // ★★ 서버에 유형 조건 사본이 없다 — 있으면 "칩 건수 ≠ 재검수 대상"으로 갈라진다
    //   (주석은 대상이 아니다 — 실행되는 코드만 본다)
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/checks\s*->|checks\s*->>|_riIssueTypes/.test(code),
      '★★ 서버에 유형 판정 사본 금지(화면 _riIssueTypes 단일 출처)');
    ok('A1: ★★ 두 경로 + 서버에 유형 판정 사본 0');

    // 실제 실행 — 중복 제거·상한·빈 값 정리
    _q = [];
    let r = await RI.reinspectTab({ fileIds: ['a', 'b', 'a', '', null, 'c'] });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(_q[0].params[0], ['a', 'b', 'c'], '중복·빈 값 제거');
    _q = [];
    r = await RI.reinspectTab({ fileIds: Array.from({ length: 900 }, (_, i) => 'f' + i) });
    assert.strictEqual(_q[0].params[0].length, 500, '★ 상한 500(화면 목록 최대치)');
    ok('A2: 중복 제거 · 빈 값 제거 · 상한 500');

    // 빈 목록 → 종전 요구(작업 필수)로 수렴
    _q = [];
    r = await RI.reinspectTab({ fileIds: [] });
    assert.strictEqual(r.ok, false);
    assert.ok(/fileIds/.test(r.error), '무엇이 필요한지 말한다');
    assert.strictEqual(_q.length, 0, '★ 대상이 없으면 쿼리 0(빈 UPDATE 금지)');
    _q = [];
    r = await RI.reinspectTab({ sheetId: 'S', tabName: 'T' });
    assert.ok(_q[0] && /sheet_id = \$1/.test(_q[0].sql), '작업 전체 경로는 종전 그대로');
    ok('A3: ★ 대상 없음 = 쿼리 0 + 안내 / 작업 경로 무회귀');

    const tb = read('src/routes/trackB.routes.js');
    assert.ok(/fileIds: Array\.isArray\(b\.fileIds\) \? b\.fileIds : null/.test(tb), '라우트 전달');
    assert.ok(/router\.post\('\/review-inspect\/reinspect', authMiddleware, adminOrMasterMiddleware/.test(tb),
      '★ 권한 종전 그대로(adminOrMaster)');
    ok('A4: 라우트 배선 + 권한 무변경');
  }

  /* ═══ B. 화면 — 대상이 라벨에 드러난다 ═══ */
  console.log('\nB) 화면 — 무엇이 돌지 말한다');
  {
    assert.ok(/const curType = \(i==null\) \? \(STATE\.riType\|\|'all'\) : 'all';/.test(WD),
      '상단에서 부르면 유형 칩 반영 / 카드에서 부르면 그 작업');
    assert.ok(/\(STATE\.ri\|\|\[\]\)\.filter\(x=>_riIssueTypes\(x\)\.includes\(curType\)\)\.map\(x=>x\.file_id\)/.test(WD),
      '★★ 대상은 화면 유형 판정(_riIssueTypes)으로 고른다');
    assert.ok(/if\(byType && !byType\.length\)\{ alert\('이 유형에 재검수할 건이 없습니다\.'\)/.test(WD),
      '빈 유형은 조용히 넘기지 않는다');
    assert.ok(/const body = byType \? \{ fileIds: byType, limit:100 \}/.test(WD), '페이로드 분기');
    assert.ok(/const reLbl = curType!=='all' \?/.test(WD) && /const reOn = curType!=='all' \|\| !!t;/.test(WD),
      '★ 라벨·활성 조건이 대상을 따라간다');
    assert.ok(/유형 칩이나 작업을 먼저 고르세요/.test(WD), '못 도는 이유를 말한다');
    ok('B1: ★★ 유형 칩 → 그 유형만 · 라벨이 대상을 말한다');
  }

  /* ═══ C·D. 제거 · 칩 축소 ═══ */
  console.log('\nC) 제거한 것 · 남긴 것');
  {
    assert.ok(!/riRunSweep|riExportCsv/.test(WD),
      '★ [↻ 과거분 검수]·[CSV] 는 함수·버튼 모두 흔적 0(누르면 죽는 버튼 금지)');
    // 서버는 남긴다 — 되살리기 쉽게 + 크론이 계속 돈다
    const tb = read('src/routes/trackB.routes.js');
    assert.ok(/review-inspect\/sweep/.test(tb) && /review-inspect\/export\.csv/.test(tb),
      '★ 서버 라우트는 유지(수동 버튼만 제거 — 과거분 따라잡기는 크론이 계속 돈다)');
    ok('C1: ★ 화면에서만 제거 · 서버 무변경');

    const head = WD.slice(WD.indexOf("$('#rihead').innerHTML="), WD.indexOf("$('#rihead').innerHTML=") + 1600);
    assert.ok(/\$\{chip\('open','의심＋불량'\)\}\$\{chip\('resolved','확인됨'\)\}/.test(head),
      '★ 칩은 [의심＋불량]·[확인됨] 둘뿐');
    for (const gone of ["chip('pass'", "chip('pending'", "chip('all'"])
      assert.ok(!head.includes(gone), `제거된 칩: ${gone}`);
    // ★ [확인됨]을 남긴 이유 — 처리한 건에 닿는 유일한 경로
    assert.ok(/처리한 건을 되돌아보는 \*\*유일한 경로\*\*/.test(WD)
      || /처리한 건을 되돌아보는/.test(WD), '남긴 이유를 코드가 설명한다');
    ok('D1: ★ 칩 축소(통과·미검수·전체 제거) · [확인됨] 유지');

    // 서버 status 필터 자체는 그대로 — 필요해지면 칩만 되살리면 된다
    const svc = read('src/services/reviewInspect.service.js');
    assert.ok(/status === 'open'|'open'/.test(svc), '서버 status 필터 유지');
    ok('D2: 서버 status 필터 무변경(되살리기 쉽게)');
  }

  console.log(`\n✅ inspectViewTrim 회귀가드 ${n}케이스 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌ 실패:', e); process.exit(1); });
