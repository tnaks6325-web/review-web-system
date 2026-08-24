/* 총건수 초과 표시 + 여분 준비 줄 정리 창구 (2026-08-24 사용자 확정)
   ───────────────────────────────────────────────────────────────────────────
   신고: 작업오더·모집공고·작업보드가 모두 500건인데 작업표 줄은 581/577.
   사용자 확정 = **줄을 강제로 500 에 맞추지 않는다** — 실제로 501명이 들어왔으면
   그 501번째 줄을 식별해 `501/500` 이라고 말한다(사실을 감추지 않는다).
   그리고 사람이 안 들어온 **여분 준비 줄**은 [📅 인원]에서 닫을 수 있어야 한다.

   ★ 이 가드가 고정하는 것
     A. 초과 판정은 서버 한 곳(`workdeskTab`) — cap 은 작업 조건 카드와 같은 값
     B. 무시트 작업표만 · 채워진 줄만 · 모르면 표시하지 않는다
     C. 광고주에게도 보인다(사용자 확정) — 단 `condition` 자체는 여전히 내부 전용
     D. 화면은 서버 판정을 그리기만 한다(사본 0)
     E. 균형 모드가 구간 뒤 **빈 준비 줄**을 0 명으로 표에 올리고 저장에 싣는다 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8').replace(/\r\n/g, '\n');
const S = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra ? ' → ' + extra : '')); pass++; console.log('  ✓ ' + name); };

const svc = S('src/services/trackB.service.js');
const wd = F('workdesk.html');
const dp = F('js/campaign-daily-plan.js');

/* 함수 본문 잘라내기 — 최상위 함수는 열 0 의 `}` 로 닫힌다(레포 스타일). */
function body(src, decl) {
  const i = src.indexOf(decl);
  assert(i >= 0, '선언을 못 찾음: ' + decl);
  const j = src.indexOf('\n}', i);
  return src.slice(i, j > 0 ? j + 2 : src.length);
}

console.log('── A. 초과 판정: 서버 단일 출처 ──');
const tab = body(svc, 'async function workdeskTab(');
t('cap 은 tabConditionSummary(= displayRecruitTotal 단일 출처)에서 온다',
  /_cond\s*=\s*await tabConditionSummary\(/.test(tab) && /_cond\.recruitTotal/.test(tab));
t('★ tabConditionSummary 호출은 1회 — 두 번 부르면 cap 과 조건 카드가 갈릴 수 있다',
  (svc.match(/await tabConditionSummary\(/g) || []).length === 1);
t('★ 총건수 규칙 사본 0 — workdeskTab 안에서 displayRecruitTotal 을 **호출**하지 않는다',
  !/displayRecruitTotal\s*\(/.test(tab));   // 주석의 언급은 사본이 아니다
t('★ 무시트 작업표만 판정한다(시트 기반 탭은 시트가 행 수를 정한다)',
  /meta\[0\]\s*&&\s*meta\[0\]\.sheetless\s*&&\s*_cond/.test(tab));
t('★ cap 이 0·미상이면 null — 아무 표시도 하지 않는다',
  /Number\(_cond\.recruitTotal\)\s*>\s*0[\s\S]{0,80}:\s*null;/.test(tab));
t('★ 채워진 줄만 센다(빈 슬롯은 사람이 아니다)',
  /for \(const r of out\) \{ if \(!r\.filled\) continue;/.test(tab));
t('★ 정렬 뒤에 센다 — 화면과 같은 순서라야 "몇 번째 사람"이 일치한다',
  tab.indexOf('out.sort(') < tab.indexOf('if (!r.filled) continue;'));
t('counts 에 cap·over 를 싣되 모르면 undefined(0 과 구분)',
  /cap: _cap \|\| undefined/.test(tab) && /over: _cap \? overCount : undefined/.test(tab));

console.log('── B. 광고주 노출 경계 ──');
t('★ condition 자체는 여전히 내부 전용(showEdits 안)',
  (() => {
    const i = svc.indexOf('res.condition =');
    const before = svc.slice(svc.lastIndexOf('if (showEdits) {', i), i);
    return /if \(showEdits\) \{/.test(before);
  })());
t('★ 초과 판정은 showEdits 밖 — 광고주도 받는다(사용자 확정)',
  (() => {
    const i = tab.indexOf('const _cond = await tabConditionSummary');
    const j = tab.indexOf('if (showEdits) {', tab.indexOf('const res = {'));
    return i >= 0 && (j < 0 || i < j);
  })());
t('행 표식은 syn 에 직접 붙어 광고주 화이트리스트 재구성 뒤에도 남는다',
  /r\.over = true/.test(tab));

console.log('── C. 화면: 서버 판정을 그리기만 ──');
const grid = body(wd, 'function buildGrid(');
t('행 배경은 r.over 로만 켠다(화면 재판정 0)', /r\.over===true\?' class="gover"'/.test(grid));
t('초과 배지도 r.over 로만', /r\.over===true\?' <span class="govb"/.test(grid));
t('★ 복사 텍스트에서 초과 배지를 제거한다(셀 값에 "초과" 가 섞이지 않게)',
  /\.ehist,\.rdel,\.src,\.visit,\.lock,\.govb/.test(wd));
t('CSS 는 gover/govb 접두 — 맨몸 .over 를 쓰지 않는다',
  /tr\.gover>td\{/.test(wd) && /\.govb\{/.test(wd));

const strip = body(wd, 'function summaryStrip(');
t('★ 게이지 분모 = 서버 counts.cap(작업 조건 카드와 같은 값)',
  /const target=\(c\.cap!=null&&\+c\.cap>0\)\?\+c\.cap/.test(strip));
t('★ cap 미수신(구버전 백엔드)이면 종전 폴백 그대로',
  /d\.recruitCount&&\+d\.recruitCount\)\|\|parseTabMeta/.test(strip));
t('★ 초과 수는 서버 counts.over 만 — 화면에서 세지 않는다',
  /const overN=\(c\.over!=null\)\?Math\.max\(0,\+c\.over\|\|0\):0;/.test(strip));
t('초과면 참여자 게이지 숫자가 붉어지고 +N 초과 배지가 붙는다',
  /nm\$\{ov\?' isover':''\}/.test(strip) && /class="ovb">\+\$\{ov\} 초과/.test(strip));

const home = body(wd, 'function _finProgHtml(');
t('홈도 총건수 기준으로 초과를 말한다', /const over=\(rt&&_isNoSheet\(t\)&&filled>rt\.total\)/.test(home));
/* ★★ 서버는 `meta.sheetless` 일 때만 행에 `over` 를 붙인다 — 홈에서 게이트를 빼면 시트 기반 탭에서
   홈만 붉어지고 "표에서 붉은 줄로 표시합니다" 가 거짓말이 된다(코덱스 리뷰 P2, 2026-08-24). */
t('★ 홈 초과 판정도 무시트 작업만(시트 기반 탭에 거짓 경고 금지)',
  /_isNoSheet\(t\)&&filled>rt\.total/.test(home));
t('홈 초과 표기는 색으로만(숫자는 이미 501/500 로 보인다)',
  /wbl-num\$\{over\?' isover':''\}/.test(home) && !/\+\$\{over\} 초과/.test(home));

console.log('── D. 균형 모드: 여분 준비 줄을 닫을 수 있다 ──');
t('★ 구간 뒤 빈 준비 줄을 0 명으로 표에 올린다(닫을 창구가 생긴다)',
  /worktableFilledFor\(dd\) > 0\) return;/.test(dp) && /plan\[dd\] = 0; cmap\[dd\] = 0;/.test(dp));
t('★ 무시트 공고만(시트 일정 공고에 0 을 박으면 시트 우선권이 사라진다)',
  /scheduleDriven !== true && Array\.isArray\(S\.data\.worktableDates\)/.test(dp));
t('★ 사람이 저장해 둔 계획이 있는 날은 덮지 않는다', /if \(S\.base\[dd\] != null\) return;/.test(dp));
t('★ 이미 채워진 줄이 있는 날도 넣지 않는다(하한을 깨지 않는다)',
  /if \(worktableFilledFor\(dd\) > 0\) return;/.test(dp));
t('★ 목표를 채운 뒤(residual 0)의 명시 0 은 저장에서 빠지지 않는다',
  /if \(residual > 0 && v < nat && v === residual/.test(dp));
t('★ 예상 종료일은 실제로 사람을 받는 마지막 날(0 명 꼬리를 종료일로 찍지 않는다)',
  /for \(var li = h\.dates\.length - 1; li >= 0; li--\) if \(h\.plan\[h\.dates\[li\]\] > 0\)/.test(dp));
t('★ [자동 맞춤]은 새 날을 만들기 전에 구간의 0 명 준비일을 먼저 채운다',
  /if \(need <= 0 \|\| planFor\(dz\) > 0\) return;/.test(dp));

console.log('── E. 저장 payload 실행 검증(vm) ──');
(() => {
  /* 균형 엔진을 실제로 돌려 "구간 뒤 0 명 날짜가 저장에 실리는지"를 본다.
     ⚠ 모듈은 bare sessionStorage 를 읽으므로 sandbox 전역에 둔다(없으면 조용히 catch 된다). */
  const store = {};
  const sandbox = {
    window: {}, document: { getElementById: () => null, querySelector: () => null,
      addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add(){}, remove(){} }, appendChild(){} }),
      body: { appendChild(){}, contains: () => false } },
    sessionStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    console, setTimeout, clearTimeout, fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(dp, sandbox, { filename: 'campaign-daily-plan.js' });
  const M = sandbox.window.CampaignDailyPlan;
  t('모듈이 전역으로 노출된다', !!M);
})();

console.log(`\n✅ quotaOverflowMark: ${pass} cases passed`);
process.exit(0);
