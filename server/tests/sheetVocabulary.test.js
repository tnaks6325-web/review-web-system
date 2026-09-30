/**
 * sheetVocabulary.test.js — 무시트 작업에 "시트"라고 쓰지 않는다 (표시 어휘 회귀가드)
 * 실행: node tests/sheetVocabulary.test.js
 *
 * 고정하는 것:
 *  A. 판정 재료 — 관제 응답 `sheetInfo.sheetless` 는 `sheetlessScope.isSheetless` 단일 출처
 *  B. 어휘 단일 출처 `_srcWords` — 무시트/시트 두 벌 · 필드 부재 = 종전(시트) 어휘
 *  C. 대조 카드 본문에 하드코딩된 '시트' 0 (주석 제외) · 미매칭 목록도 같은 어휘를 받는다
 *  D. 마감/복귀 안내 — `_finUntouched` 로 그 작업에 맞게 말한다 · 헬퍼가 <style> 안이 아니다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rd = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
/** ★ campaign.routes.js 는 **의도된 NUL**(복합키 구분자)을 갖고 있어 git 이 바이너리로 취급한다 —
 *  읽어서 걷어낸 뒤 본다(이 가드 파일에 NUL 을 글자 그대로 넣으면 이 파일까지 바이너리가 된다). */
const rdSrv = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').split(String.fromCharCode(0)).join('');
const noLineComments = (s) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
/** 블록 주석은 정규식으로 지우지 않는다(이 레포의 정규식 리터럴을 물어 코드를 통째로 지운다) —
 *  줄 단위로 `/* … *\/` 구간만 건너뛴다. */
function stripComments(src) {
  const out = []; let inBlock = false;
  for (const line of src.split('\n')) {
    let l = line;
    if (inBlock) { const e = l.indexOf('*/'); if (e < 0) continue; l = l.slice(e + 2); inBlock = false; }
    const b = l.indexOf('/*');
    if (b >= 0) { const e = l.indexOf('*/', b + 2); if (e < 0) { inBlock = true; l = l.slice(0, b); } else l = l.slice(0, b) + l.slice(e + 2); }
    const s2 = l.trim();
    if (s2.startsWith('//')) continue;
    out.push(l);
  }
  return out.join('\n');
}
/** 이름으로 함수 본문을 잘라낸다(중괄호 균형) */
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert(i >= 0, name + ' 선언을 찾지 못했다');
  let d = 0, started = false;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error(name + ' 본문 경계를 찾지 못했다');
}

let passed = 0;
const ok = (n, c) => { assert(c, n); passed++; console.log('  ✓ ' + n); };
/** ★ 비동기 단언은 여기 모아 두고 **exit 전에 반드시 기다린다** — async IIFE 안에 두고
 *  기다리지 않으면 그 단언이 `process.exit(0)` 뒤로 밀려 **조용히 실행되지 않는다**(실측 함정). */
const pending = [];

/* ══════════════ A. 판정 재료(서버) ══════════════ */
console.log('\n[A] 관제 응답 재료 — sheetless');
{
  const r = noLineComments(rdSrv('src/routes/campaign.routes.js'));
  ok('sheetInfo 에 sheetless 를 싣는다', /sheetInfo = \{[\s\S]{0,200}sheetless,/.test(r));
  ok('★ 판정은 sheetlessScope 단일 출처(이름 → gid 폴백)',
    /require\('\.\.\/utils\/sheetlessScope'\)\s*\n?\s*\.isSheetless\(pool, c0\.linked_sheet_id, c0\.linked_tab_name\)/.test(r));
  ok('★ 가상 시트ID 접두로 추측하지 않는다(이관 작업은 진짜 시트ID 를 쓴다)',
    !/sheetless\s*=\s*[^;]*wt_/.test(r));
  ok('조회 실패는 종전(시트) 어휘로 접는다', /catch \(slErr\) \{ sheetless = false; \}/.test(r));
  // 실행 — 그 함수가 실제로 tab_configs.sheetless 를 본다
  const scope = require('../src/utils/sheetlessScope');
  const calls = [];
  const db = { query: async (sql, p) => { calls.push({ sql, p }); return { rows: [{ s: true }] }; } };
  pending.push((async () => {
    const v = await scope.isSheetless(db, 'wt_x', '탭');
    ok('isSheetless 는 tab_configs.sheetless 를 읽는다',
      v === true && /COALESCE\(sheetless, FALSE\)/.test(calls[0].sql));
  })());
}

/* ══════════════ B·C. 어휘 단일 출처 + 대조 카드 ══════════════ */
console.log('\n[B] 어휘 단일 출처 _srcWords');
const ir = rd('frontend/js/index-recruit.js');
{
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(fnSrc(ir, '_srcWords') + '\n' + fnSrc(ir, '_campUnmatchedRows') + '\n' + fnSrc(ir, '_campSheetInfo'), ctx);
  const W = (v) => vm.runInContext('_srcWords(' + JSON.stringify(v) + ')', ctx);

  const ns = W(true), sh = W(false), unknown = W(undefined);
  ok('무시트 어휘에는 "시트"가 없다', !JSON.stringify(ns).includes('시트') || !/(?:^|[^무])시트/.test(Object.values(ns).join(' ')));
  ok('무시트는 작업표 어휘', ns.roster.includes('작업표') && ns.sched.includes('작업표') && ns.title.includes('작업표'));
  ok('시트 기반은 종전 어휘 그대로', sh.roster === '시트 로스터' && sh.sched === '시트 일정' && sh.title === '시트 대조');
  ok('★ 필드 부재(구버전 백엔드) = 종전 어휘', JSON.stringify(unknown) === JSON.stringify(sh));
  ok('★ 느슨한 참(문자열 "true")으로 무시트가 되지 않는다', JSON.stringify(W('true')) === JSON.stringify(sh));
  ok('★ 무시트 안내는 큐를 말하지 않는다(무시트는 큐를 안 탄다)',
    !ns.behind.includes('큐') && ns.behind.includes('자동 인계'));
  ok('시트 기반 안내는 종전대로 큐 대기를 말한다', sh.behind.includes('큐 대기'));

  console.log('\n[C] 대조 카드 — 어휘를 함수에서만 가져온다');
  const body = stripComments(fnSrc(ir, '_campSheetInfo'));
  ok('★ 카드 본문에 하드코딩된 "시트" 0(주석 제외)', !body.includes('시트'));
  ok('카드가 어휘 함수를 쓴다', /_srcWords\(si\.sheetless\)/.test(body));
  ok('미매칭 목록에도 같은 어휘를 넘긴다', /_campUnmatchedRows\(si\.unmatched, w, si\.unmatchedCounts, diff\)/.test(body));
  const um = stripComments(fnSrc(ir, '_campUnmatchedRows'));
  ok('★ 미매칭 목록 본문에도 하드코딩된 "시트" 0', !um.includes('시트'));
  ok('미매칭 목록의 어휘 폴백도 시트 기반', /w = w \|\| _srcWords\(false\)/.test(um));

  // ── 렌더 실행: 같은 데이터로 두 어휘가 실제로 갈리는지
  const si = (sheetless) => ({
    tabName: '8/19 테스트 작업', sheetless, rosterRows: 8, confirmed: 22, diff: -14,
    unmatched: [], schedule: { applied: false, reason: 'system_basis', distinctDates: 12, totalDated: 300, firstDate: '2026-08-19', lastDate: '2026-09-03' },
  });
  const html = (v) => vm.runInContext('_campSheetInfo(' + JSON.stringify(si(v)) + ')', ctx);
  const hNs = html(true), hSh = html(false);
  ok('무시트 카드 — "작업표 줄"·"작업표 대조"로 그려진다',
    hNs.includes('작업표 줄') && hNs.includes('📋 작업표 대조'));
  ok('★ 무시트 카드에는 "시트"라는 낱말이 없다', !hNs.replace(/무시트/g, '').includes('시트'));
  ok('무시트 카드는 자동 인계를 말한다', hNs.includes('자동 인계'));
  ok('시트 기반 카드는 종전 문구 그대로',
    hSh.includes('시트 로스터') && hSh.includes('📋 시트 대조') && hSh.includes('큐 대기'));
  ok('필드 부재도 종전 문구', html(undefined).includes('시트 로스터'));
  ok('탭 이름은 escape 된다(시트발 외부 문자열)',
    vm.runInContext('_campSheetInfo(' + JSON.stringify({ ...si(true), tabName: '<img src=x>' }) + ')', ctx).includes('&lt;img'));
}

/* ══════════════ D. 마감/복귀 안내 ══════════════ */
console.log('\n[D] 마감 안내 — 그 작업에 맞게');
{
  const wd = rd('frontend/workdesk.html');
  const style = wd.split('<style>')[1].split('</style>')[0];
  ok('★ 어휘 헬퍼가 <style> 안에 있지 않다(CSS 파싱을 조용히 죽인다)', !style.includes('_finUntouched'));
  ok('style 블록 중괄호·주석 균형',
    (style.match(/\{/g) || []).length === (style.match(/\}/g) || []).length &&
    (style.match(/\/\*/g) || []).length === (style.match(/\*\//g) || []).length);
  // 인라인 스크립트 전체가 파싱된다(주석 조기 종료·JS 오배치 차단)
  let blocks = 0;
  for (const m of wd.matchAll(/<script>([\s\S]*?)<\/script>/g)) { new Function(m[1]); blocks++; }
  ok('인라인 스크립트 전부 파싱 OK', blocks >= 1);

  const ctx = { console }; vm.createContext(ctx);
  vm.runInContext(fnSrc(wd, '_finUntouched'), ctx);
  const f = (t) => vm.runInContext('_finUntouched(' + JSON.stringify(t) + ')', ctx);
  ok('무시트 작업 — 구글시트를 들먹이지 않는다', f({ sheetless: true }) === '리뷰어 화면·데이터');
  ok('시트 기반 작업 — 종전 문구', f({ sheetless: false }).includes('구글시트'));
  ok('★ 필드 부재·null 도 종전 문구(모르는 것을 단정하지 않는다)',
    f({}).includes('구글시트') && f(null).includes('구글시트'));
  ok('★ 느슨한 참으로 무시트가 되지 않는다', f({ sheetless: 'yes' }).includes('구글시트'));
  const s2 = stripComments(wd);
  ok('마감 바 안내가 헬퍼를 쓴다', /마감해도 \$\{_finUntouched\(t\)\}는 그대로입니다/.test(s2));
  ok('마감 모달 안내도 헬퍼를 쓴다', /\$\{_finUntouched\(t\)\}에는 <b>아무 영향이 없습니다/.test(s2));
  ok('★ 하드코딩된 옛 문구가 남아 있지 않다',
    !s2.includes('마감해도 시트·리뷰어 화면은') && !s2.includes('<li>구글시트·리뷰어 화면·데이터에는'));
  /* ★ 문구 존재 검사만으로는 "옆에 시트를 덧붙이는" 회귀를 통과시킨다(변이시험 실측) —
     두 함수 본문에 하드코딩된 '시트'가 **0** 임을 고정한다(주석 제외 · '무시트' 는 제외어). */
  for (const nm of ['_finBarHtml', 'openFinishModal']) {
    const body = stripComments(fnSrc(wd, nm)).replace(/무시트/g, '');
    ok(`★ ${nm} 본문에 하드코딩된 "시트" 0`, !body.includes('시트'));
  }
}

Promise.all(pending).then(() => {
  console.log(`\n총 ${passed}개 통과\n`);
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
