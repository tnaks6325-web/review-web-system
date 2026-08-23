/**
 * inspectTypeCounts.test.js — 리뷰검수 오류유형 **전체 집계** 회귀가드.
 * 실행: node tests/inspectTypeCounts.test.js
 *      PGTEST_URL=postgres://... node tests/inspectTypeCounts.test.js   (진짜 PG 대조까지)
 *
 * 왜 이렇게 짜는가
 *  - 신고(2026-08-23): 리뷰검수 3,334건인데 화면 칩이 `전체 유형 200` — 유형별 실제 분포를
 *    시스템 어디에서도 볼 수 없었다. 원인 = 목록 API `LIMIT 200` 응답을 화면이 세고 있었다.
 *  - 그래서 서버 전체 집계를 넣었는데, 그 판정을 SQL 에 **따로 적으면 사본**이 되어
 *    "칩 건수 ≠ 카드 문장"으로 갈린다(이 저장소의 반복된 사고) → 규칙표 하나에서
 *    JS 와 SQL 을 파생하고, 이 가드가 **두 구현을 같은 픽스처로 실행해 결과 동일**을 고정한다.
 *  - 화면의 최소 사본(`_riIssueTypes`)도 vm 으로 꺼내 **실제 실행**해 대조한다
 *    (문자열 검사로는 분기 한 줄이 바뀐 것을 못 잡는다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';

const IIT = require('../src/utils/inspectIssueTypes');
const svcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'reviewInspect.service.js'), 'utf8');
const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
const wd = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

/* 판정 갈래를 전부 밟는 픽스처 — 유형이 겹치는 건(한 건 = 여러 칩)을 반드시 포함한다. */
const V = (v, extra) => Object.assign({ verdict: v }, extra || {});
const FIX = [
  { name: '리뷰화면 아님',      checks: { format: V('fail', { kind: 'order_capture' }) },                 want: ['format_fail'] },
  { name: '채널 다름',          checks: { format: V('warn', { expectedChannel: 'coupang' }) },            want: ['channel'] },
  { name: 'format warn 인데 기대채널 없음 → 유형 아님', checks: { format: V('warn', { expectedChannel: '' }) }, want: [] },
  { name: '상품명 다름',        checks: { product: V('warn') },                                           want: ['product'] },
  { name: '같은 파일(fail)',    checks: { duplicate: V('fail') },                                         want: ['duplicate'] },
  { name: '같은 파일(warn)',    checks: { duplicate: V('warn') },                                         want: ['duplicate'] },
  { name: '본문 겹침',          checks: { similarity: V('warn') },                                        want: ['similarity'] },
  { name: '작성자 표기',        checks: { author: V('warn') },                                            want: ['author'] },
  { name: '한 건에 두 유형',    checks: { format: V('fail'), product: V('warn') },                        want: ['format_fail', 'product'] },
  { name: '전부 통과',          checks: { format: V('pass'), product: V('pass') },                        want: [] },
  { name: 'skip 만',            checks: { format: V('skip'), product: V('skip') },                        want: [] },
  { name: 'checks 없음',        checks: {},                                                               want: [] },
];

/* ═══ ① 판정 순수함수 ═══════════════════════════════════════════════ */
console.log('\n▶ 유형 판정(서버 단일 출처)');
for (const f of FIX) {
  ok(`${f.name} → [${f.want.join(',') || '없음'}]`,
    JSON.stringify(IIT.issueTypesOf({ checks: f.checks })) === JSON.stringify(f.want));
}
ok('★ duplicate 는 fail·warn 둘 다 센다(한쪽만 세면 도용 건이 칩에서 사라진다)',
  IIT.issueTypesOf({ checks: { duplicate: V('fail') } }).length === 1
  && IIT.issueTypesOf({ checks: { duplicate: V('warn') } }).length === 1);

/* ═══ ② 화면 사본 ≡ 서버 판정 ═══════════════════════════════════════ */
console.log('\n▶ 화면 최소 사본(_riIssueTypes) ≡ 서버 판정');
const m = wd.match(/function _riIssueTypes\(r\)\{[\s\S]*?\n\}/);
assert(m, '_riIssueTypes 를 찾지 못했다(이름이 바뀌었으면 가드를 함께 갱신할 것)');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(m[0] + '\nthis.__f = _riIssueTypes;', sandbox);
const front = sandbox.__f;
for (const f of FIX) {
  ok(`화면·서버 동일: ${f.name}`,
    JSON.stringify(front({ checks: f.checks })) === JSON.stringify(IIT.issueTypesOf({ checks: f.checks })));
}

/* ═══ ③ 칩 순서 = 화면 목록 순서 ════════════════════════════════════ */
console.log('\n▶ 유형 키 목록');
const riTypes = wd.match(/const RI_TYPES=\[([\s\S]*?)\];/);
assert(riTypes, 'RI_TYPES 를 찾지 못했다');
const frontKeys = [...riTypes[1].matchAll(/\['([a-z_]+)'/g)].map(x => x[1]);
ok('★ 화면 칩 키 ≡ 서버 유형 키(순서까지) — 한쪽만 늘면 칩이 조용히 빠진다',
  JSON.stringify(frontKeys) === JSON.stringify(IIT.ISSUE_KEYS));

/* ═══ ④ SQL 조각 ═══════════════════════════════════════════════════ */
console.log('\n▶ SQL 집계 조각');
const sql = IIT.issueTypeCountSql('i.checks');
ok('유형 키마다 FILTER 집계가 하나씩', IIT.ISSUE_KEYS.every(k => sql.includes(`AS ${k}`)));
ok('★ 별칭은 정규식 검증 — 문자열 조립 주입 차단', (() => {
  try { IIT.issueTypeCountSql("checks; DROP TABLE review_inspections; --"); return false; }
  catch (_) { return true; }
})());

/* ═══ ⑤ 서비스·라우트 배선 ══════════════════════════════════════════ */
console.log('\n▶ 배선');
ok('서비스가 유형 집계를 export', typeof require('../src/services/reviewInspect.service').inspectionTypeCounts === 'function');
ok('★ 판정 사본 금지 — 서비스가 checks verdict 조건을 직접 적지 않는다(util 파생만)',
  !/checks->'(format|product|duplicate|similarity|author)'/.test(svcSrc.replace(/issueTypeCountSql\([^)]*\)/g, '')));
ok('라우트가 목록 응답에 typeCounts 를 싣는다', /typeCounts/.test(routeSrc));
ok('★ 집계 실패는 fail-soft — 필드를 안 싣는다(0 으로 꾸미지 않는다)',
  /\.\.\.\(typeCounts \? \{ typeCounts \} : \{\}\)/.test(routeSrc));
ok('★ staff 스코프를 SQL 로 내린다(200 절단 방지) — 목록·요약·집계가 같은 tabs 를 받는다',
  /listInspections\(\{[\s\S]{0,200}tabs,/.test(routeSrc)
  && /inspectionSummary\(\{[^)]*tabs \}\)/.test(routeSrc)
  && /inspectionTypeCounts\(\{[\s\S]{0,200}tabs,/.test(routeSrc));
ok('★ 라우트가 목록을 다시 걸러 요약을 재계산하지 않는다(그 경로가 200 절단의 원인이었다)',
  !/summary\[it\.status\] !== undefined/.test(routeSrc));
ok('응답이 목록 상한을 함께 알린다(화면이 "최근 N건만"이라고 말할 수 있게)',
  /truncated: items\.length >= limit/.test(routeSrc));

/* ═══ ⑥ 화면 표시 규율 ═════════════════════════════════════════════ */
console.log('\n▶ 화면 표시');
const head = wd.slice(wd.indexOf('function _riRenderHead'), wd.indexOf('function _riRenderHead') + 3000);
ok('★ 서버 집계가 있으면 그것을 그린다(화면에서 다시 세지 않는다)',
  /const _srv = STATE\.riTypeCounts;/.test(head) && /if\(_srv\)\{/.test(head));
ok('★ 서버 집계가 없으면 종전 폴백 + "표시된 건 기준"이라고 말한다(전체인 척 금지)',
  /_riIssueTypes\(r\)\) _tcnt/.test(head) && /표시된 건 기준/.test(head));
ok('★ 목록이 잘렸으면 그 사실을 말한다', /목록은 최근 \$\{_riN\(_rows\.length\)\}건만 표시/.test(head));
ok('★ 한 건이 여러 유형이면 중복 계수됨을 계속 고지', /각 칩에 모두 세어집니다/.test(head));
const body = wd.slice(wd.indexOf('function _riRenderBody'), wd.indexOf('function _riRenderBody') + 3000);
ok('★ "없다"와 "이 목록에 안 실렸다"를 구분해 말한다',
  /지금 목록\(최근 \$\{_riN\(rows\.length\)\}건\)에는 없습니다/.test(body));

/* ═══ ⑥-2 진단 스크립트 — 규칙 사본 0 · 읽기 전용 ═══════════════════
 *  운영 DB 는 컨테이너 안에서만 닿아 `scripts/inspect-diag.js` 로 조회한다.
 *  그 스크립트가 유형 규칙을 베껴 쓰면 화면 칩과 진단 숫자가 갈리고,
 *  쓰기 구문이 섞이면 진단이 사고가 된다 → 둘 다 여기서 고정한다. */
console.log('\n▶ 진단 스크립트');
const diag = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'inspect-diag.js'), 'utf8');
ok('★★ 유형 판정을 베끼지 않고 단일 출처에서 파생한다',
  /require\([^)]*inspectIssueTypes[^)]*\)/.test(diag) && /issueTypeCountSql\('i\.checks'\)/.test(diag));
ok('★★ 읽기 전용 — 쓰기 구문이 없다',
  !/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\s/i.test(diag.replace(/^\s*(\/\/|\*).*$/gm, '')));
ok('★ DATABASE_URL 이 없으면 사유를 말하고 끝낸다(조용한 실패 금지)',
  /DATABASE_URL 이 없습니다/.test(diag));
ok('★ 한 절이 실패해도 나머지 진단은 남는다(fail-soft)', /조회 실패:/.test(diag));

/* ═══ ⑦ 진짜 PG — JS 판정 ≡ SQL 집계 ═══════════════════════════════ */
(async () => {
  if (!process.env.PGTEST_URL) {
    console.log('\n(PGTEST_URL 없음 — SQL↔JS 실행 대조는 건너뜀)');
  } else {
    console.log('\n▶ 진짜 PG: SQL 집계 ≡ JS 판정');
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.PGTEST_URL });
    await c.connect();
    const T = 'ri_typecount_guard_tmp';
    await c.query(`DROP TABLE IF EXISTS ${T}`);
    await c.query(`CREATE TABLE ${T}(id serial primary key, sheet_id text, tab_name text, status text, checks jsonb)`);
    for (const f of FIX) {
      await c.query(`INSERT INTO ${T}(sheet_id, tab_name, status, checks) VALUES ('s1','t1','suspect',$1)`,
        [JSON.stringify(f.checks)]);
    }
    const { rows } = await c.query(
      `SELECT COUNT(*)::int AS total, ${IIT.issueTypeCountSql('i.checks')} FROM ${T} i`);
    const want = { total: FIX.length };
    for (const k of IIT.ISSUE_KEYS) want[k] = 0;
    for (const f of FIX) for (const k of IIT.issueTypesOf({ checks: f.checks })) want[k] += 1;
    for (const k of Object.keys(want)) {
      ok(`PG ${k} = ${want[k]} (JS 판정과 동일)`, Number(rows[0][k]) === want[k]);
    }
    ok('★ 합계 ≠ total (한 건이 여러 유형이면 중복 계수 — 화면 안내문의 근거)',
      IIT.ISSUE_KEYS.reduce((a, k) => a + want[k], 0) !== want.total);
    await c.query(`DROP TABLE ${T}`);
    await c.end();
  }
  /* ═══ ⑧ 진짜 PG — 서비스 함수를 그대로 실행 ═════════════════════════
   *  ★★ 스텁 pool 은 SQL 을 해석하지 않는다 → 스코프(`unnest` 조인)·상태 절·유형 집계가
   *    실제로 맞는지는 **한 번 돌려 봐야** 알 수 있다(이 저장소의 반복된 교훈). */
  if (process.env.PGTEST_URL) {
    console.log('\n▶ 진짜 PG: 서비스 함수 실행');
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.PGTEST_URL });
    await c.connect();
    const mig = (f) => fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8');
    await c.query('DROP TABLE IF EXISTS review_inspections CASCADE');
    await c.query('DROP TABLE IF EXISTS review_submissions CASCADE');
    await c.query('CREATE TABLE review_submissions(file_id text primary key, file_url text, file_name text)');
    // 081 은 tab_configs 에 컬럼도 더한다 — 그 테이블은 이 가드의 관심사가 아니라 최소 형태로 세운다
    await c.query('CREATE TABLE IF NOT EXISTS tab_configs(sheet_id text, tab_name text)');
    await c.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');   // 081 의 본문 유사도 GIN 인덱스
    await c.query(mig('081_review_inspections.sql'));
    await c.query(mig('092_review_inspect_learning.sql'));   // resolution 컬럼(목록 SELECT 가 읽는다)

    let fid = 0;
    const put = (sheetId, tabName, status, checks) => c.query(
      `INSERT INTO review_inspections(file_id, sheet_id, tab_name, status, checks)
       VALUES ($1,$2,$3,$4,$5)`, [`f${++fid}`, sheetId, tabName, status, JSON.stringify(checks)]);

    // A탭: 의심 2(상품명 2 · 본문겹침 1) + 불량 1 + 통과 1 + 확인됨 1 · B탭(담당 밖): 의심 2
    await put('S1', 'A', 'suspect', { product: V('warn') });
    await put('S1', 'A', 'suspect', { product: V('warn'), similarity: V('warn') });
    await put('S1', 'A', 'fail',    { format: V('fail') });
    await put('S1', 'A', 'pass',    { format: V('pass') });
    await put('S1', 'A', 'resolved',{ product: V('warn') });
    await put('S2', 'B', 'suspect', { author: V('warn') });
    await put('S2', 'B', 'suspect', { duplicate: V('fail') });

    const RIsvc = require('../src/services/reviewInspect.service');
    RIsvc.__setPoolForTest({ query: (q, p2) => c.query(q, p2) });

    const all = await RIsvc.inspectionTypeCounts({ status: 'open' });
    ok('전체 의심+불량 5건', all.total === 5);
    ok('상품명 2 · 본문겹침 1 · 리뷰화면아님 1 · 작성자 1 · 같은파일 1',
      all.product === 2 && all.similarity === 1 && all.format_fail === 1
      && all.author === 1 && all.duplicate === 1);
    ok('★ 확인됨(resolved) 건은 open 집계에 안 든다(상품명이 3 이 아니라 2)', all.product === 2);

    const scoped = await RIsvc.inspectionTypeCounts({ status: 'open', tabs: [{ sheetId: 'S1', tabName: 'A' }] });
    ok('★ 담당 탭 스코프가 SQL 로 걸린다 — A탭만 3건', scoped.total === 3 && scoped.author === 0);

    const none = await RIsvc.inspectionTypeCounts({ status: 'open', tabs: [] });
    ok('★ 담당 탭 0개 = 0건(모른다고 전체를 세지 않는다 — fail-closed)', none.total === 0);

    const sumScoped = await RIsvc.inspectionSummary({ tabs: [{ sheetId: 'S1', tabName: 'A' }] });
    ok('요약도 같은 스코프 — 통과 1 · 의심 2 · 불량 1 · 확인됨 1',
      sumScoped.pass === 1 && sumScoped.suspect === 2 && sumScoped.fail === 1 && sumScoped.resolved === 1);

    const listScoped = await RIsvc.listInspections({ tabs: [{ sheetId: 'S1', tabName: 'A' }], status: 'open' });
    ok('★ 목록도 스코프를 SQL 로 받는다(전체 200 뽑아 거르지 않는다)',
      listScoped.length === 3 && listScoped.every(r => r.tab_name === 'A'));
    ok('불량이 맨 위(정렬 계약 불변)', listScoped[0].status === 'fail');

    const resolvedCnt = await RIsvc.inspectionTypeCounts({ status: 'resolved' });
    ok('★ 상태 칩([확인됨])에도 같은 집계가 따라온다', resolvedCnt.total === 1 && resolvedCnt.product === 1);

    RIsvc.__setPoolForTest(null);
    await c.query('DROP TABLE IF EXISTS review_inspections CASCADE');
    await c.query('DROP TABLE IF EXISTS review_submissions CASCADE');
    await c.end();
  }

  console.log(`\n✅ ${n} 케이스 통과`);
  process.exit(0);
})();
