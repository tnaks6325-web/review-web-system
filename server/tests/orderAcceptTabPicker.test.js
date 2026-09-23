'use strict';
/**
 * 회귀가드 — 작업오더 접수 gid 미발견 → 탭 골라 교정 재접수
 *
 * 실행: node tests/orderAcceptTabPicker.test.js
 *
 * 배경(2026-08-05 실사고): 작업오더의 작업시트탭URL gid(예 10798045)가 그 시트에 없어
 * (탭 삭제 후 재생성 = gid 변경 / 다른 시트의 gid가 붙은 URL) 접수가 404 막다른 길이었다.
 *
 * ★ 이 가드가 지키는 것:
 *   ① 서버: 404 응답에 availableTabs(그 시트 실제 탭 목록)와 gidNotFound 신호가 실린다
 *   ② 서버: body.gid(사람이 고른 탭)로 재접수하면 그 gid가 URL gid보다 우선하고,
 *      work_sheet_url 도 함께 교정된다(안 고치면 다음 재접수·프리필이 계속 죽은 gid를 본다)
 *   ③ 자동 이름매칭 폴백은 없다 — 고르는 것은 항상 사람("잘못된 탭 연결이 빈칸보다 나쁨")
 *   ④ 팝업(woAcceptTabPicker)은 공유 모듈 한 벌이고, 시트에서 온 탭명을 onclick 문자열에
 *      넣지 않는다(textContent 만 — M1 실측 XSS 규율). 런타임 실행으로 확인한다.
 *   ⑤ 두 호스트(관리자 대시보드 index-app.js · 리뷰웹시스템[3버전] workdesk.html)가
 *      gidNotFound 에서 팝업을 열고, 고른 gid로 재접수를 배선한다
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const routesSrc = fs.readFileSync(path.join(ROOT, 'server/src/routes/order.routes.js'), 'utf8');
const wodSrc = fs.readFileSync(path.join(ROOT, 'frontend/js/work-order-detail.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'frontend/js/index-app.js'), 'utf8');
const wdSrc = fs.readFileSync(path.join(ROOT, 'frontend/workdesk.html'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

console.log('\n[1] 서버 — /admin/accept 교정 흐름');

t('① 404 응답에 gidNotFound + availableTabs + urlGid 가 실린다', () => {
  const m = routesSrc.match(/gidNotFound:\s*true[\s\S]{0,300}availableTabs/) ||
            routesSrc.match(/availableTabs[\s\S]{0,300}gidNotFound:\s*true/);
  assert.ok(m, 'gidNotFound/availableTabs 응답 없음');
  assert.ok(/urlGid:\s*gid/.test(routesSrc), 'urlGid 없음');
  assert.ok(/hidden:\s*!!s\.properties\.hidden/.test(routesSrc), '숨김 탭 표시 없음');
});

t('② body.gid(pickGid)가 숫자 검증 후 URL gid 보다 우선한다', () => {
  assert.ok(/const pickGid = String\(\(req\.body \|\| \{\}\)\.gid \|\| ''\)\.trim\(\)/.test(routesSrc), 'pickGid 파싱 없음');
  assert.ok(/\/\^\\d\+\$\/\.test\(pickGid\) \? pickGid : gidMatch\[1\]/.test(routesSrc), 'gid 우선순위(pick 우선) 없음');
});

t('② work_sheet_url 교정 — gidCorrected 일 때만 COALESCE 로 덮는다', () => {
  assert.ok(/work_sheet_url = COALESCE\(\$7, work_sheet_url\)/.test(routesSrc), 'URL 교정 SET 없음');
  assert.ok(/gidCorrected \? tabSheetUrl : null/.test(routesSrc), '교정 시에만 값 전달하는 파라미터 없음');
  assert.ok(/gidCorrected,/.test(routesSrc), '응답 gidCorrected 없음');
});

t('③ 자동 이름매칭 폴백 없음 — 탭명으로 targetSheet 를 찾는 코드가 없다', () => {
  // gid 매칭 한 곳만 허용: meta.find(... sheetId) === gid). title 로 find 하는 폴백 금지.
  assert.ok(!/meta\.find\([^)]*title/.test(routesSrc), '탭명 자동매칭 폴백이 생겼다(사람 선택만 허용)');
});

console.log('\n[2] 공유 팝업 woAcceptTabPicker — 런타임 실행(XSS·배선)');

function makeStubDoc(log) {
  function el(tag) {
    const node = {
      tag, children: [], listeners: {}, style: {}, dataset: {},
      _text: '', _html: '',
      set textContent(v) { node._text = String(v); },
      get textContent() { return node._text; },
      set innerHTML(v) { node._html = String(v); log.htmlSets.push(String(v)); },
      get innerHTML() { return node._html; },
      appendChild(c) { node.children.push(c); return c; },
      addEventListener(ev, fn) { (node.listeners[ev] = node.listeners[ev] || []).push(fn); },
      remove() { node.removed = true; },
    };
    log.created.push(node);
    return node;
  }
  return {
    getElementById: () => null,
    createElement: tag => el(tag),
    body: { appendChild(n) { log.mounted = n; } },
  };
}

function runPicker(resp, onPick, confirmValue) {
  const log = { created: [], htmlSets: [], mounted: null };
  const sandbox = {
    window: {}, console,
    document: makeStubDoc(log),
    confirm: () => confirmValue,
  };
  sandbox.window = sandbox; // self-reference for safety
  vm.createContext(sandbox);
  // 모듈 전체를 로드(IIFE) — 팝업 함수가 전역으로 공개되는지까지 확인
  vm.runInContext(wodSrc, sandbox);
  assert.strictEqual(typeof sandbox.woAcceptTabPicker, 'function', 'woAcceptTabPicker 전역 공개 안 됨');
  sandbox.woAcceptTabPicker(resp, onPick);
  return log;
}

const EVIL = "x'),alert(1),String('<img src=x onerror=alert(2)>";

t("④ 악성 탭명이 innerHTML 로 들어가지 않는다(textContent 만)", () => {
  const log = runPicker({ urlGid: '10798045', availableTabs: [{ gid: '111', title: EVIL }] }, () => {}, true);
  const leaked = log.htmlSets.filter(h => h.includes('onerror') || h.includes('alert(1)'));
  assert.strictEqual(leaked.length, 0, '탭명이 innerHTML 에 보간됨: ' + leaked[0]);
  const btn = log.created.find(n => n.tag === 'button' && n._text.indexOf(EVIL) === 0);
  assert.ok(btn, '탭명이 textContent 버튼으로 렌더되지 않음');
});

t('④ 탭 버튼 클릭(confirm 승인) → onPick(gid) 호출', () => {
  let picked = null;
  const log = runPicker({ urlGid: '9', availableTabs: [{ gid: '222', title: '8/3(네이버)제주도아_제주갈치조림 10건' }] },
    g => { picked = g; }, true);
  const btn = log.created.find(n => n.tag === 'button' && n.listeners.click && n._text.includes('제주갈치조림'));
  assert.ok(btn, '탭 버튼 없음');
  btn.listeners.click.forEach(fn => fn({}));
  assert.strictEqual(picked, '222', 'onPick 미호출 또는 gid 불일치');
});

t('④ confirm 거부 시 onPick 미호출(사람 확인 게이트)', () => {
  let picked = null;
  const log = runPicker({ urlGid: '9', availableTabs: [{ gid: '333', title: 'T' }] }, g => { picked = g; }, false);
  const btn = log.created.find(n => n.tag === 'button' && n.listeners.click && n._text === 'T');
  btn.listeners.click.forEach(fn => fn({}));
  assert.strictEqual(picked, null, 'confirm 거부인데 onPick 호출됨');
});

console.log('\n[3] 호스트 배선 — 두 화면 모두');

t('⑤ index-app.js: gidNotFound → 팝업 → woAccept(id, g) 재시도', () => {
  assert.ok(/r\.gidNotFound && typeof woAcceptTabPicker === "function"/.test(appSrc), 'gidNotFound 분기 없음');
  // ★ 인자가 늘어도(광고주 연결 확인값 등) "고른 gid 로 재접수한다"는 계약은 같다.
  assert.ok(/woAcceptTabPicker\(r, g => woAccept\(id, g[,)]/.test(appSrc), '재접수 배선 없음');
  assert.ok(/gid: pickGid/.test(appSrc), '재접수 요청에 gid 미포함');
});

t('⑤ workdesk.html: gidNotFound → 팝업 → _woAccept(id, g) 재시도 + body 에 gid', () => {
  assert.ok(/r&&r\.gidNotFound&&typeof woAcceptTabPicker==='function'/.test(wdSrc), 'gidNotFound 분기 없음');
  assert.ok(/woAcceptTabPicker\(r, g=>_woAccept\(id, g[,)]/.test(wdSrc), '재접수 배선 없음');
  assert.ok(/pickGid \? \{id, gid:pickGid\} : \{id\}/.test(wdSrc), '재접수 body 에 gid 미포함');
});

t('⑤ 팝업 사본 금지 — woAcceptTabPicker 정의는 공유 모듈 한 곳뿐', () => {
  const defRe = /function woAcceptTabPicker/g;
  assert.strictEqual((wodSrc.match(defRe) || []).length, 1, '공유 모듈 정의 1개 아님');
  assert.ok(!/function woAcceptTabPicker/.test(appSrc), 'index-app.js 에 사본');
  assert.ok(!/function woAcceptTabPicker/.test(wdSrc), 'workdesk.html 에 사본');
});

console.log(`\n결과: ${pass} 통과 / ${fail} 실패\n`);
process.exit(fail ? 1 : 0);
