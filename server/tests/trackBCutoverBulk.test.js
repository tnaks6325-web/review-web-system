/**
 * 일괄 cutover(DB 원본 일괄 전환) 회귀가드
 *
 * ★ 이 가드가 고정하는 것
 *   1. 게이트 단일 출처 — cutoverAll 은 판정을 setSourceOfTruth 에 위임한다(parity 게이트 사본 0).
 *   2. ★★ force 절대 미전달 — 일괄에서 게이트를 우회하면 클릭 한 번이 검증 안 된 탭을 무더기 전환한다.
 *   3. triage — 이미 db / 유령 / candidate 미충족 탭은 플립 시도조차 안 하고 사유와 함께 보고.
 *   4. 실패는 보고로 수렴(한 탭의 예외가 나머지 탭 전환을 죽이지 않는다).
 *   5. 라우트 master 전용 + force 를 받지 않는다. 프론트 버튼도 master 분기 안.
 *
 * 실행: node tests/trackBCutoverBulk.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SVC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'trackB.service.js'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

const svc = require('../src/services/trackB.service');

function cutoverAllBody() {
  const i = SVC.indexOf('async function cutoverAll(');
  assert.ok(i > 0, 'cutoverAll 이 없다');
  return SVC.slice(i, SVC.indexOf('\n}', i));
}

/* ══ 1. 정적 — 게이트 사본 0 · force 미전달 ══ */
console.log('\n1) 게이트 단일 출처 · force 금지');

t('★★ cutoverAll 은 parity 게이트를 복제하지 않는다(판정은 flipFn=setSourceOfTruth 위임)', () => {
  const body = cutoverAllBody();
  ['parityReport', 'parity_not_clean', 'real ==', 'real >', 'UPDATE tab_configs'].forEach(s =>
    assert.ok(!body.includes(s), '게이트/쓰기 사본이 들어왔다: ' + s));
  assert.ok(/flipFn\(\{ \.\.\.key, value: 'db', by \}\)/.test(body), 'flipFn 위임 호출이 아니다');
});

t("★★ force 를 전달하지 않는다(주석 제외한 코드에 'force' 0회)", () => {
  const code = cutoverAllBody().replace(/\/\/[^\n]*/g, '');   // 라인 주석 제거 후 판정
  assert.ok(!/force/.test(code), 'cutoverAll 코드에 force 가 들어왔다 — 일괄 우회 금지');
});

t('라우트도 force 를 받지 않는다 + master 전용', () => {
  const i = ROUTES.indexOf("'/source-of-truth/all'");
  assert.ok(i > 0, '라우트가 없다');
  const block = ROUTES.slice(i, ROUTES.indexOf('});', i));
  assert.ok(!/force/.test(block), '라우트가 force 를 받는다');
  assert.ok(/masterOnlyMiddleware/.test(ROUTES.slice(i - 200, i + 100)), 'master 전용이 아니다');
});

/* ══ 2. 실행 — triage·위임·격리 ══ */
console.log('\n2) cutoverAll 실행');

async function runService() {
  const items = [
    { sheetId: 'S', tabName: 'A', sourceOfTruth: 'sheet', ghost: false, cutoverCandidate: true,  countMatch: true,  owned: true,  woLinked: true },
    { sheetId: 'S', tabName: 'B', sourceOfTruth: 'db',    ghost: false, cutoverCandidate: false, countMatch: true,  owned: true,  woLinked: true },
    { sheetId: 'S', tabName: 'C', sourceOfTruth: 'sheet', ghost: true,  cutoverCandidate: false, countMatch: true,  owned: true,  woLinked: true },
    { sheetId: 'S', tabName: 'D', sourceOfTruth: 'sheet', ghost: false, cutoverCandidate: false, countMatch: false, owned: true,  woLinked: false },
    { sheetId: 'S', tabName: 'E', sourceOfTruth: 'sheet', ghost: false, cutoverCandidate: true,  countMatch: true,  owned: true,  woLinked: true },
    { sheetId: 'S', tabName: 'F', sourceOfTruth: 'sheet', ghost: false, cutoverCandidate: true,  countMatch: true,  owned: true,  woLinked: true },
  ];
  const calls = [];
  const flipFn = async (args) => {
    calls.push(args);
    if (args.tabName === 'E') return { ok: false, error: 'parity_not_clean', real: 3 };   // 게이트에 걸림
    if (args.tabName === 'F') throw new Error('boom');                                    // 예외
    return { ok: true };
  };
  const r = await svc.cutoverAll({ by: 'test', overviewFn: async () => items, flipFn });

  t('candidate 만 플립 시도(이미 db·유령·미충족은 시도 0)', () => {
    assert.deepStrictEqual(calls.map(c => c.tabName).sort(), ['A', 'E', 'F'],
      '시도 대상이 다르다: ' + calls.map(c => c.tabName));
  });
  t('★★ 위임 호출 인자에 force 없음 + value=db 고정', () => {
    calls.forEach(c => { assert.ok(!('force' in c), 'force 가 전달됐다'); assert.strictEqual(c.value, 'db'); });
  });
  t('건너뜀 사유가 결과에 남는다(already_db·ghost·not_candidate+미충족 목록)', () => {
    const by = Object.fromEntries(r.results.map(x => [x.tabName, x]));
    assert.strictEqual(by.B.skipped, 'already_db');
    assert.strictEqual(by.C.skipped, 'ghost');
    assert.strictEqual(by.D.skipped, 'not_candidate');
    assert.deepStrictEqual(by.D.reasons, ['count_mismatch', 'no_work_order'], 'D 미충족 사유');
  });
  t('게이트 미통과는 사유+real 로 보고되고 전환되지 않는다', () => {
    const e = r.results.find(x => x.tabName === 'E');
    assert.strictEqual(e.ok, false); assert.strictEqual(e.skipped, 'parity_not_clean'); assert.strictEqual(e.real, 3);
  });
  t('★ 한 탭의 예외가 나머지를 죽이지 않는다(F=error, A 는 전환됨)', () => {
    assert.strictEqual(r.results.find(x => x.tabName === 'F').skipped, 'error');
    assert.strictEqual(r.results.find(x => x.tabName === 'A').ok, true);
  });
  t('요약 집계가 맞는다(total=6, flipped=1, skipped=5)', () => {
    assert.strictEqual(r.total, 6); assert.strictEqual(r.flipped, 1); assert.strictEqual(r.skipped, 5);
  });
}

/* ══ 3. 라우터 스택 실검사 ══ */
async function runRoute() {
  console.log('\n3) 라우터 스택');
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:5432/x';
  const router = require('../src/routes/trackB.routes.js');
  const layer = router.stack.find(l => l.route && l.route.path === '/source-of-truth/all' && l.route.methods.post);
  t('POST /source-of-truth/all 등록 + authMiddleware + masterOnly', () => {
    assert.ok(layer, '미등록');
    const names = layer.route.stack.map(s => s.handle.name);
    assert.ok(names.includes('authMiddleware'), '인증 없음: ' + names);
    assert.ok(names.some(n => /masterOnly/.test(n)), 'master 게이트 없음: ' + names);
  });
}

/* ══ 4. 프론트 배선 ══ */
function runFront() {
  console.log('\n4) 프론트 배선');
  t('버튼은 master 분기 안 + runCutoverAll 존재 + confirm 마찰', () => {
    assert.ok(/\$\{STATE\.role==='master'\?`<button class="btn" id="coAllBtn" onclick="runCutoverAll\(\)"/.test(HTML),
      '버튼이 master 분기 밖이거나 없다');
    assert.ok(/async function runCutoverAll\(\)/.test(HTML));
    assert.ok(/if\(!confirm\(`전환 가능 \$\{cand\}개 탭/.test(HTML), 'confirm 마찰이 없다');
  });
  t('★ 프론트도 force 를 보내지 않는다 + 결과 모달은 이스케이프', () => {
    const i = HTML.indexOf('async function runCutoverAll()');
    const body = HTML.slice(i, HTML.indexOf('\nfunction renderOverviewHead', i));
    assert.ok(!/force/.test(body), '프론트가 force 를 보낸다');
    assert.ok(/esc\(x\.tabName/.test(body), '탭명 미이스케이프(XSS)');
    assert.ok(/renderOverviewView\(\)/.test(body), '완료 후 재조회가 없다');
  });
}

(async () => {
  await runService();
  await runRoute();
  runFront();
  console.log('\n✅ trackBCutoverBulk: ' + pass + '개 통과\n');
  process.exit(0);   // trackB.routes require 시 DB 풀 핸들이 열려 프로세스가 안 끝난다
})().catch(e => { console.error('❌', e); process.exit(1); });
