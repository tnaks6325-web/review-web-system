/**
 * workdeskToolMenuConditional.test.js — 회귀가드: [⋯] 도구 메뉴 조건부 노출 (2026-08-21)
 * 실행: node tests/workdeskToolMenuConditional.test.js
 *
 * 왜: 도구 버튼들이 역할·무시트 여부만 보고 상시 노출돼, 대부분의 작업에서 할 일 없이 떠 있었다
 *   (눌러서 미리보기를 봐야 "대상 0건"을 알 수 있었다). 이제 **할 일이 있을 때만** 띄운다.
 *
 * 고정하는 것:
 *  A. 판정 재료 = 그 도구가 실제로 쓰는 것과 **같은 것**(사본 금지)
 *  B. ★★ **모르면 숨기지 않는다(fail-open)** — 조회 실패·미도착은 종전대로 노출
 *  C. 할 일 0건이면 숨긴다 · 있으면 건수 배지
 *  D. 서버는 [⋯] 를 **열 때만** 부른다 · 같은 작업은 1회만
 *  E. 메뉴 내용은 한 곳(_mhMenuHtml)에서만 정한다 — 렌더/재렌더가 갈리지 않게
 *
 * ★ 정적 문자열 검사가 아니라 **vm 으로 실제 실행**한다(변이시험으로 검출력 확인).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

/* 함수 하나를 원문 그대로 떠온다(사본을 만들지 않는다 — 원문이 바뀌면 이 검사가 같이 움직인다). */
function grab(name) {
  const i = HTML.indexOf(`function ${name}(`);
  assert(i > -1, `함수 ${name} 을 찾지 못했다`);
  let d = 0, started = false;
  for (let k = i; k < HTML.length; k++) {
    const c = HTML[k];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return HTML.slice(i, k + 1); }
  }
  throw new Error(`함수 ${name} 의 끝을 찾지 못했다`);
}

function makeSandbox({ role = 'master', roster = [], cur = { sheetId: 's1', tabName: 't1' },
                       dedupe = null, workKind = '' } = {}) {
  const sb = {
    STATE: { role, cur, wd: { roster }, _flipBtnHtml: '' },
    _MHB: dedupe === undefined ? null : { key: cur ? cur.sheetId + '\t' + cur.tabName : '', dedupe, busy: false },
    document: { getElementById: () => null },
    api: async () => ({ ok: true, removeRows: 0 }),
  };
  sb.STATE.cur = cur ? Object.assign({ sheetless: true, workKind }, cur) : null;
  vm.createContext(sb);
  vm.runInContext([
    grab('_ddCount'), grab('_mhKey'),
    grab('_mhToolsVisible'), grab('_mhMenuHtml'),
    grab('_ddCan'), grab('_brCanAdd'),
    'function _isInternalRole(){ const r=STATE.role; return r==="master"||r==="admin"||r==="staff"; }',
  ].join('\n'), sb);
  return sb;
}
const R = (round, name = '홍길동') => ({ round, name, submitted: false, paid: false });

(async () => {
  console.log('\n[A] 🧹 줄 정리 — 제거 고정 (2026-08-21 사용자 확정)');
  {
    ok('★ [⋯] 메뉴에 [🧹 줄 정리] 가 없다', !/openRetireModal/.test(HTML));
    ok('★ 모달·판정 코드도 남아 있지 않다(죽은 코드 금지)',
      !/_wrCanRetire|_wrHasWork|function wrRun|_wrRender/.test(HTML));
    ok('★ 제거된 HTTP 창구를 부르지 않는다', !/worktable\/retire-rows/.test(HTML));
  }

  console.log('\n[B] ★★ fail-open — 모르면 숨기지 않는다');
  {
    const sb = makeSandbox({ roster: [R('1'), R('2')], dedupe: null });
    const html = vm.runInContext('_mhMenuHtml()', sb);
    ok('중복 건수를 아직 모르면(null) ♻ 중복 정리를 **노출**한다', /openDedupeModal/.test(html));
    ok('모를 때는 배지를 붙이지 않는다', !/중복 정리 \d/.test(html));

    // _MHB 가 아예 없는 경우(첫 렌더 · 조회 전)
    const sb2 = makeSandbox({ roster: [R('1'), R('2')] });
    vm.runInContext('_MHB = null', sb2);
    ok('_MHB 가 없어도(첫 렌더) 노출한다', /openDedupeModal/.test(vm.runInContext('_mhMenuHtml()', sb2)));

    // 다른 작업의 값이 남아 있어도 이 작업 것으로 쓰지 않는다
    const sb3 = makeSandbox({ roster: [R('1'), R('2')], dedupe: 0 });
    vm.runInContext('_MHB.key = "OTHER\\tTAB"', sb3);
    ok('★ 다른 작업의 건수를 이 작업에 쓰지 않는다(키 불일치 = 모름 = 노출)',
      /openDedupeModal/.test(vm.runInContext('_mhMenuHtml()', sb3)));
  }

  console.log('\n[C] 할 일 0건이면 숨김 · 있으면 배지');
  {
    const sb0 = makeSandbox({ roster: [R('1'), R('2')], dedupe: 0 });
    ok('중복 0건이면 ♻ 중복 정리를 숨긴다', !/openDedupeModal/.test(vm.runInContext('_mhMenuHtml()', sb0)));

    const sb3 = makeSandbox({ roster: [R('1'), R('2')], dedupe: 3 });
    const h3 = vm.runInContext('_mhMenuHtml()', sb3);
    ok('중복 3건이면 노출', /openDedupeModal/.test(h3));
    ok('건수를 배지로 말한다', /♻ 중복 정리 3</.test(h3), h3.slice(0, 400));

    const sbW = makeSandbox({ roster: [R('1'), R('1')], dedupe: 0 });
    const hW = vm.runInContext('_mhMenuHtml()', sbW);
    ok('할 일이 없으면 정리 버튼이 안 뜬다', !/openDedupeModal/.test(hW));
    ok('★ 정리 버튼이 없어도 다른 도구는 그대로', /showWritebackSim/.test(hW));
  }

  console.log('\n[D] 권한 — 조건부 노출이 게이트를 넓히지 않는다');
  {
    /* ⚠ 2026-08-23 사용자 재확정: 화면 게이트를 서버(`/worktable/dedupe-rows` = adminOrMaster)와
       **1:1** 로 맞췄다(그 전 2026-08-21 확정은 master 전용이었다). 이 가드가 고정하는 것은
       "누가 보느냐"가 아니라 **조건부 노출이 게이트를 넓히지 않는다**는 쪽이다 —
       그래서 admin 은 뜨고(서버가 허용), staff 는 안 뜬다(서버가 403). */
    const admin = makeSandbox({ role: 'admin', roster: [R('1'), R('2')], dedupe: 5 });
    const ha = vm.runInContext('_mhMenuHtml()', admin);
    ok('★ admin 은 서버가 허용하므로 띄운다(화면 ≡ 서버 adminOrMaster)',
      /openDedupeModal/.test(ha));
    const adminNone = makeSandbox({ role: 'admin', roster: [R('1'), R('1')], dedupe: 0 });
    ok('★ admin 에게도 할 일이 없으면 안 띄운다(조건부 노출은 역할과 무관)',
      !/openDedupeModal/.test(vm.runInContext('_mhMenuHtml()', adminNone)));
    const staff = makeSandbox({ role: 'staff', roster: [R('1'), R('2')], dedupe: 5 });
    const hs = vm.runInContext('_mhMenuHtml()', staff);
    ok('★ staff 에게도 안 띄운다', !/openDedupeModal/.test(hs));
    ok('staff 는 ＋ 블로거 추가만', /openBloggerModal/.test(hs));
    ok('★ [⋯] 자체는 띄울 것이 있을 때만',
      vm.runInContext('_mhToolsVisible()', makeSandbox({ role: 'advertiser', cur: null })) === false);
  }

  console.log('\n[E] 배선 — 열 때만 조회 · 1회만 · 렌더 단일 출처');
  {
    ok('[⋯] 를 열 때만 조회한다', /classList\.contains\('open'\)\)\s*_mhToolsSync\(\)/.test(HTML));
    const sync = grab('_mhToolsSync');
    ok('★ 같은 작업은 1회만 조회', /_MHB\.key === key\) return/.test(sync));
    ok('★ 모달 미리보기와 **같은 호출**을 쓴다(사본 금지)',
      /worktable\/dedupe-rows/.test(sync) && /dryRun: true/.test(sync));
    ok('★ 숫자로 온 값만 센다(형태 불일치는 모름으로)', /typeof j\.removeRows === 'number'/.test(sync));
    ok('★ 조회 실패는 삼켜서 null 유지(fail-open)', /catch \(_\) \{ \/\* fail-open/.test(sync));
    ok('★ 메뉴 내용 생성기는 하나뿐(_mhMenuHtml)',
      (HTML.match(/function _mhMenuHtml\(/g) || []).length === 1);
    ok('★ 재렌더는 메뉴 껍데기만 갈아끼운다(헤더 재렌더 금지 — 열린 메뉴가 닫힌다)',
      /mhMenuBox'\);\s*\n?\s*if \(box\) box\.innerHTML = _mhMenuHtml\(\)/.test(HTML));
    ok('★ 헤더 렌더도 같은 생성기를 쓴다', /id="mhMenuBox">\$\{_mhMenuHtml\(\)\}/.test(HTML));
  }

  console.log(`\n✅ workdeskToolMenuConditional: ${passed} checks passed\n`);
})().catch(err => { console.error('\n❌ ' + err.message + '\n'); process.exit(1); });
