/**
 * 관측 대시보드 — 투영 커버리지(투영완료/총작업 · 미투영 N) 회귀가드
 *
 * ★ 이 요약이 필요한 이유(사고 아님, 구조적 눈속임):
 *   overview() 는 campaign_participants 에서 시작하므로 **한 번도 투영되지 않은 탭은 목록에 아예 없다**.
 *   그래서 관측 화면만 보면 목록이 짧은 것이 "작업이 적어서"인지 "투영이 안 돼서"인지 구분되지 않는다.
 *   projectionCoverage() 가 분모(현재 투영 대상 활성 탭)를 따로 세어 그 눈속임을 없앤다.
 *
 * ★ 이 가드가 고정하는 것
 *   1. 투영 대상 정의는 participants.listActiveTabs() **하나만** 쓴다(사본 금지) — 크론(projectActive)이
 *      대상으로 삼는 목록과 같아야 "미투영 = 크론이 아직 안 만든 것"이 성립한다.
 *   2. 투영완료 판정 = deleted_at IS NULL 행 존재(active 필터 없음) = overview b CTE 와 **같은 조건**
 *      → "투영완료로 센 탭"과 "아래 목록에 뜨는 탭"이 어긋나지 않는다.
 *   3. cronBatchLimit 은 projectActive 의 실제 기본 limit 과 같은 값(실행으로 대조 — 하드코딩 드리프트 차단).
 *   4. 읽기 전용(쓰기 SQL 0) · 라우트는 fail-soft(커버리지가 죽어도 관측 목록은 뜬다).
 *   5. 프론트는 필드 부재(구버전 백엔드)와 null(조회 실패)을 구분한다 — 배포 스큐 허위 정상 차단.
 *   6. 리터럴 NUL 금지(git 이 파일을 바이너리로 취급해 grep 가드가 통째로 무력화된다 — 개발 중 실제로 밟음).
 *
 * 실행: node tests/trackBProjectionCoverage.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
const FRONT = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

const SVC = SRC('services/trackB.service.js');
const ROUTES = SRC('routes/trackB.routes.js');
const HTML = FRONT('workdesk.html');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

const svc = require('../src/services/trackB.service');
const participants = require('../src/services/participants.service');

// projectionCoverage 본문만 잘라 검사(다른 함수의 SQL 이 섞이지 않게)
function coverageBody() {
  const i = SVC.indexOf('async function projectionCoverage(');
  assert.ok(i > 0, 'projectionCoverage 가 없다');
  const j = SVC.indexOf('\n}', i);
  return SVC.slice(i, j);
}

/* ══════════════════════════════════════════════════════════
   1. 단일 출처 · 읽기 전용
   ══════════════════════════════════════════════════════════ */
console.log('\n1) 투영 대상 정의는 한 벌 · 읽기 전용');

t('★★ 활성 탭 목록은 participants.listActiveTabs() 를 그대로 쓴다(SQL 사본 금지)', () => {
  const body = coverageBody();
  assert.ok(/participants\.listActiveTabs\(/.test(body),
    'listActiveTabs 를 안 쓴다 — 대상 정의가 크론과 갈라진다');
  // 활성 탭 판정 SQL 을 여기 복사했는지(= 사본) 확인
  ['is_system_tab', 'index_master', 'raw_sheet_tabs'].forEach(k =>
    assert.ok(!body.includes(k),
      '활성 탭 판정 SQL 사본이 들어왔다(' + k + ') — participants.listActiveTabs 만 써야 한다'));
});

t('★ 쓰기 SQL 0 — 관측 요약은 읽기 전용이다', () => {
  const body = coverageBody();
  [/\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i].forEach(re =>
    assert.ok(!re.test(body), '쓰기 SQL 이 들어왔다: ' + re));
});

t('★★ 라우트는 overview items 를 재료로 넘긴다 — "투영완료 ≡ 목록에 뜨는 탭"을 구조로 보장', () => {
  assert.ok(/svc\.projectionCoverage\(\{ projectedTabs: items \}\)/.test(ROUTES),
    'items 를 안 넘기면 같은 집합을 두 번 정의하게 되고(중복 조회 + 드리프트), 목록과 숫자가 갈라질 수 있다');
});

t('★ 폴백 조회(단독 호출)도 deleted_at IS NULL — overview b CTE 와 같은 조건', () => {
  const body = coverageBody();
  assert.ok(/FROM campaign_participants WHERE deleted_at IS NULL/.test(body),
    '조건이 바뀌면 단독 호출 결과가 화면과 어긋난다');
  assert.ok(!/AND\s+active/i.test(body),
    'active 필터를 넣으면 활성 0행(유령) 탭이 미투영으로 잘못 세어진다 — 그건 overview.ghost 담당');
  assert.ok(/FROM campaign_participants WHERE deleted_at IS NULL[\s\S]{0,60}GROUP BY sheet_id, tab_name/.test(SVC),
    'overview b CTE 의 조건이 바뀌었다 — 폴백 조회와 함께 맞춰야 한다');
});

t('★ truncated 판정 상한이 participants.listActiveTabs 의 실제 clamp 와 같다', () => {
  const P = SRC('services/participants.service.js');
  const i = P.indexOf('async function listActiveTabs(');
  const clamp = P.slice(i, P.indexOf('\n}', i));
  assert.ok(/2000/.test(clamp), 'listActiveTabs 의 상한이 바뀌었다 — _COVERAGE_TAB_CAP 도 함께 고쳐야 truncated 가 뜬다');
  assert.ok(/_COVERAGE_TAB_CAP = 2000/.test(SVC), '_COVERAGE_TAB_CAP 이 상한과 다르면 절단을 영영 고지하지 못한다');
});

/* ══════════════════════════════════════════════════════════
   2. 실제 실행 — 집계가 맞나
   ══════════════════════════════════════════════════════════ */
console.log('\n2) projectionCoverage 실행');

async function runService() {
  const savedList = participants.listActiveTabs;
  const savedFlag = process.env.TRACK_B_PROJECTION;
  try {
    const tabs = [
      { sheetId: 'S1', tabName: 'T1', spreadsheetTitle: '가시트' },   // 투영됨
      { sheetId: 'S1', tabName: 'T2', spreadsheetTitle: '가시트' },   // 미투영
      { sheetId: 'S2', tabName: 'T1', spreadsheetTitle: null },       // 미투영 + 제목 없음(sheetId 폴백 확인)
      { sheetId: 'S2', tabName: 'T9', spreadsheetTitle: '나시트' },   // 투영됨(활성 0행이어도 투영은 된 것)
    ];
    let askedLimit = null;
    participants.listActiveTabs = async ({ limit } = {}) => { askedLimit = limit; return tabs; };
    svc.__setPoolForTest({ async query(sql) {
      if (/FROM campaign_participants WHERE deleted_at IS NULL/.test(String(sql)))
        return { rows: [{ sheetId: 'S1', tabName: 'T1' }, { sheetId: 'S2', tabName: 'T9' },
                         { sheetId: 'S9', tabName: 'Z' }] };   // 활성 탭이 아닌 잔재 — 분모에 안 잡혀야
      return { rows: [] };
    } });

    delete process.env.TRACK_B_PROJECTION;
    const c = await svc.projectionCoverage();

    t('총/투영완료/미투영이 활성 탭 기준으로 집계된다', () => {
      assert.strictEqual(c.total, 4, '총작업수');
      assert.strictEqual(c.projected, 2, '투영완료');
      assert.strictEqual(c.missing, 2, '미투영');
      assert.strictEqual(c.projected + c.missing, c.total, '분해 합이 총계와 다르다');
    });

    t('★ (시트,탭) 복합키로 짝짓는다 — 탭명만 같은 다른 시트를 투영됨으로 오판하지 않는다', () => {
      const keys = c.missingTabs.map(x => x.sheetId + '/' + x.tabName).sort();
      assert.deepStrictEqual(keys, ['S1/T2', 'S2/T1'],
        '미투영 목록이 다르다: ' + JSON.stringify(c.missingTabs));
    });

    t('★ 활성 탭이 아닌 원장 잔재(S9)는 분모·분자 어디에도 안 들어간다', () => {
      assert.ok(!c.missingTabs.some(x => x.sheetId === 'S9'), 'S9 가 미투영으로 샜다');
      assert.strictEqual(c.total, 4, '분모가 원장 잔재로 부풀었다');
    });

    t('시트 제목이 없으면 sheetId 로 대체 표기한다(목록 빈 칸 금지)', () => {
      const noTitle = c.missingTabs.find(x => x.sheetId === 'S2' && x.tabName === 'T1');
      assert.ok(noTitle, '제목 없는 미투영 탭이 목록에서 빠졌다');
      assert.strictEqual(noTitle.spreadsheetTitle, 'S2', 'sheetId 폴백이 없어 화면에 빈 칸이 뜬다');
    });

    t('projectionOn 이 TRACK_B_PROJECTION 환경변수를 그대로 반영한다', () => {
      assert.strictEqual(c.projectionOn, false, '플래그 없음인데 켜진 것으로 보고');
    });

    process.env.TRACK_B_PROJECTION = '1';
    const c2 = await svc.projectionCoverage();
    t('TRACK_B_PROJECTION=1 이면 projectionOn=true', () => {
      assert.strictEqual(c2.projectionOn, true);
    });

    t('★ 조회 상한을 넘지 않으면 truncated=false (조용한 절단 금지 신호)', () => {
      assert.strictEqual(c2.truncated, false);
      assert.ok(askedLimit >= 500, 'listActiveTabs 기본 상한(500)보다 작게 요청하면 분모가 잘린다: ' + askedLimit);
    });

    // ── cronBatchLimit 은 projectActive 의 실제 기본값과 같아야 한다(하드코딩 드리프트 차단) ──
    let projectLimit = null;
    participants.listActiveTabs = async ({ limit } = {}) => { projectLimit = limit; return []; };
    await svc.projectActive({});   // TRACK_B_PROJECTION=1 상태 — 게이트 통과
    t('★★ cronBatchLimit === projectActive 의 실제 기본 limit (실행으로 대조)', () => {
      assert.strictEqual(projectLimit, c2.cronBatchLimit,
        `화면이 말하는 크론 상한(${c2.cronBatchLimit})과 실제 투영 대상 수(${projectLimit})가 다르다`);
      assert.ok(Number.isFinite(c2.cronBatchLimit) && c2.cronBatchLimit > 0, 'cronBatchLimit 값이 이상하다');
    });

    // ── 미투영 목록은 sample 상한까지만(응답 폭주 방지) ──
    const many = Array.from({ length: 30 }, (_, i) => ({ sheetId: 'S', tabName: 'T' + i, spreadsheetTitle: '시트' }));
    participants.listActiveTabs = async () => many;
    const c3 = await svc.projectionCoverage({ sample: 5 });
    t('★ 미투영 목록은 sample 상한까지만 담고 missing 총수는 그대로 보고(조용한 절단 금지)', () => {
      assert.strictEqual(c3.missing, 30, '총수가 목록 길이로 줄었다 — 화면이 과소보고한다');
      assert.strictEqual(c3.missingTabs.length, 5, '목록 상한이 안 걸렸다');
    });

    // ── projectedTabs 주입 경로 ≡ 직접 조회 경로 (라우트가 쓰는 길이 다른 답을 내면 안 된다) ──
    participants.listActiveTabs = async () => tabs;
    let queried = false;
    svc.__setPoolForTest({ async query(sql) {
      if (/FROM campaign_participants WHERE deleted_at IS NULL/.test(String(sql))) {
        queried = true;
        return { rows: [{ sheetId: 'S1', tabName: 'T1' }, { sheetId: 'S2', tabName: 'T9' }] };
      }
      return { rows: [] };
    } });
    const injected = await svc.projectionCoverage({
      projectedTabs: [{ sheetId: 'S1', tabName: 'T1' }, { sheetId: 'S2', tabName: 'T9' }] });
    t('★★ overview items 주입 결과 = 직접 조회 결과 · 주입 시 중복 조회를 하지 않는다', () => {
      assert.strictEqual(queried, false, 'items 를 줬는데도 같은 테이블을 다시 훑었다(비용 낭비)');
      assert.strictEqual(injected.total, 4);
      assert.strictEqual(injected.projected, 2);
      assert.deepStrictEqual(injected.missingTabs.map(x => x.sheetId + '/' + x.tabName).sort(),
        ['S1/T2', 'S2/T1'], '주입 경로가 직접 조회 경로와 다른 답을 냈다');
    });

    const fallback = await svc.projectionCoverage();   // 주입 없음 → 폴백 조회
    t('★ 주입이 없으면 직접 조회로 폴백한다(단독 호출 가능)', () => {
      assert.strictEqual(queried, true, '폴백 조회가 안 돌았다');
      assert.strictEqual(fallback.projected, injected.projected, '두 경로의 답이 다르다');
    });
  } finally {
    participants.listActiveTabs = savedList;
    svc.__setPoolForTest(null);
    if (savedFlag === undefined) delete process.env.TRACK_B_PROJECTION; else process.env.TRACK_B_PROJECTION = savedFlag;
  }
}

/* ══════════════════════════════════════════════════════════
   3. 라우트 — 동봉 + fail-soft
   ══════════════════════════════════════════════════════════ */
async function runRoute() {
  console.log('\n3) GET /overview 가 coverage 를 동봉하고 fail-soft 다');

  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:5432/x';
  const router = require('../src/routes/trackB.routes.js');
  const layer = router.stack.find(l => l.route && l.route.path === '/overview' && l.route.methods.get);
  assert.ok(layer, 'GET /overview 미등록');

  t('권한 게이트는 종전 그대로(authMiddleware + adminOrMaster)', () => {
    const names = layer.route.stack.map(s => s.handle.name);
    assert.ok(names.includes('authMiddleware'), '인증 미들웨어가 빠졌다: ' + names.join(','));
    assert.ok(names.some(n => /adminOrMaster/.test(n)), '관리자 게이트가 빠졌다: ' + names.join(','));
  });

  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const call = () => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; },
                  json(b) { resolve({ statusCode: this.statusCode, body: b }); return this; } };
    Promise.resolve(handler({ headers: {}, query: {}, admin: { role: 'master' } }, res,
      (e) => resolve({ next: true, e }))).catch((e) => resolve({ threw: true, e }));
  });

  const savedOv = svc.overview, savedCov = svc.projectionCoverage;
  try {
    svc.overview = async () => [{ tabName: 'T' }];
    svc.projectionCoverage = async () => ({ total: 7, projected: 3, missing: 4, missingTabs: [] });
    const okRes = await call();
    t('정상: items 와 coverage 를 함께 반환', () => {
      assert.ok(okRes.body && okRes.body.ok, '응답 실패: ' + JSON.stringify(okRes).slice(0, 200));
      assert.strictEqual(okRes.body.coverage.missing, 4);
      assert.strictEqual(okRes.body.items.length, 1);
    });

    svc.projectionCoverage = async () => { throw new Error('boom'); };
    const softRes = await call();
    t('★★ 커버리지가 죽어도 관측 목록은 뜬다(fail-soft) · coverage=null 로 모름을 말한다', () => {
      assert.ok(softRes.body && softRes.body.ok, '커버리지 실패가 관측 화면 전체를 죽였다');
      assert.strictEqual(softRes.body.items.length, 1, 'items 가 사라졌다');
      assert.ok('coverage' in softRes.body, 'coverage 키 자체가 사라지면 구버전 백엔드와 구분이 안 된다');
      assert.strictEqual(softRes.body.coverage, null, '실패는 null 이어야 화면이 ? 로 고지한다');
    });
  } finally { svc.overview = savedOv; svc.projectionCoverage = savedCov; }
}

/* ══════════════════════════════════════════════════════════
   4. 프론트 배선
   ══════════════════════════════════════════════════════════ */
function runFront() {
  console.log('\n4) 관측 화면 상단 요약 배선');

  t('헤더가 커버리지 칩을 그린다', () => {
    assert.ok(/function _ovCoverageChips\(\)/.test(HTML), '_ovCoverageChips 가 없다');
    assert.ok(/<h1>관측 대시보드<\/h1>[\s\S]{0,220}\$\{_ovCoverageChips\(\)\}/.test(HTML),
      '헤더(.mh)에서 _ovCoverageChips() 를 부르지 않는다');
    assert.ok(/투영완료 \$\{done\} \/ 총 \$\{total\}/.test(HTML), '투영완료/총작업 표기가 없다');
    assert.ok(/미투영 \$\{miss\}/.test(HTML), '미투영 표기가 없다');
  });

  t('★★ 필드 부재(구버전)와 null(조회 실패)을 구분한다', () => {
    assert.ok(/STATE\.ovCov\s*=\s*\('coverage' in r\)/.test(HTML),
      "('coverage' in r) 로 구분하지 않으면 구버전 백엔드에서 '미투영 ?' 가 잘못 뜬다");
    assert.ok(/if \(c === undefined\) return '';/.test(HTML), '구버전이면 칩을 아예 안 그려야 한다');
    assert.ok(/미투영 \?/.test(HTML), '조회 실패 시 모른다고 말하는 표기가 없다');
  });

  t('★ 미투영 사유(자동 투영 OFF · 크론 상한)를 화면이 설명한다', () => {
    assert.ok(/TRACK_B_PROJECTION/.test(HTML), '자동 투영 스위치 사유 안내가 없다');
    assert.ok(/c\.cronBatchLimit/.test(HTML), '크론 상한 사유 안내가 없다');
    assert.ok(/c\.truncated/.test(HTML), '분모 절단 고지가 없다');
  });

  t('미투영 목록은 읽기 전용 모달(쓰기 버튼 없음) + 이스케이프', () => {
    const i = HTML.indexOf('function openCoverageMissing()');
    assert.ok(i > 0, 'openCoverageMissing 이 없다');
    const body = HTML.slice(i, HTML.indexOf('\n}', i));
    assert.ok(/_modal\(/.test(body), '공용 모달을 안 쓴다');
    assert.ok(/esc\(t\.spreadsheetTitle/.test(body) && /esc\(t\.tabName/.test(body),
      '시트에서 온 이름을 이스케이프 없이 넣으면 XSS');
    assert.ok(!/method:\s*'POST'|api\(/.test(body), '읽기 전용이어야 하는데 쓰기 호출이 있다');
  });

  t('★ 기존 `투영 N탭` 칩은 그대로 남는다(의미가 다른 두 수 — 합치지 않는다)', () => {
    assert.ok(/투영 \$\{n\}탭/.test(HTML), '기존 목록 행 수 칩이 사라졌다');
  });

  t('.bd.w 스타일이 정의돼 있다(칩이 무색으로 뜨지 않게)', () => {
    assert.ok(/\.bd\.w\{/.test(HTML), '.bd.w 미정의');
  });
}

/* ══════════════════════════════════════════════════════════
   5. 리터럴 NUL 금지 (개발 중 실제로 밟은 함정)
   ══════════════════════════════════════════════════════════ */
function runNul() {
  console.log('\n5) 소스에 리터럴 NUL 금지');
  t('★★ trackB.service/routes·workdesk.html 에 NUL 바이트가 없다', () => {
    [['src/services/trackB.service.js', SVC], ['src/routes/trackB.routes.js', ROUTES],
     ['frontend/workdesk.html', HTML]].forEach(([name, src]) => {
      assert.ok(src.indexOf(String.fromCharCode(0)) < 0,
        name + ' 에 리터럴 NUL 이 들어갔다 — git 이 바이너리로 취급해 grep 회귀가드가 통째로 무력화된다(이스케이프 표기를 쓸 것)');
    });
  });
}

(async () => {
  await runService();
  await runRoute();
  runFront();
  runNul();
  console.log('\n✅ trackBProjectionCoverage: ' + pass + '개 통과\n');
  process.exit(0);   // trackB.routes 를 require 하면 DB 풀 핸들이 열려 프로세스가 안 끝난다
})().catch(e => { console.error('❌', e); process.exit(1); });
