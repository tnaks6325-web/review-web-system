'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('uses the B-style full-width ownership shell instead of a visible sidebar', () => {
  assert.match(source, /<div class="own-wrap ovm-bwrap">/);
  assert.match(source, /\.own-wrap\.ovm-bwrap \.ovm-side\{display:none\}/);
  assert.match(source, /\.own-wrap\.ovm-bwrap \.own-panel\{max-width:1520px/);
});

test('renders B-style command dashboard and searchable company ledger', () => {
  assert.match(source, /function _ovmbSummaryHtml\(advs, works, total, free, bad, matchKnown, candKnown\)/);
  assert.match(source, /class="[^"]*ovm-bledger/);
  assert.match(source, /id="ovmbQ"/);
  assert.match(source, /function _ovmbFilterRows\(v\)/);
});

test('shows manager-specific workload in the dashboard summary', () => {
  const match = source.match(/function _ovmbSummaryHtml\([^)]*\)\{[\s\S]*?\n\}/);
  assert.ok(match, 'summary helper should be extractable');
  // ★ 지정 현황은 **작업(작업보드) 기준**(2026-08-23 사용자 확정) — 그 카운터는 스텁이 아니라
  //   구현을 그대로 넣는다(스텁을 두면 그 함수의 회귀를 여기서만 못 본다).
  const counts = source.match(/function _ovmTabCounts\(\)\{[\s\S]*?\n\}/);
  const unass = source.match(/function _ovmUnassignedTabs\(\)\{[^\n]*\}/);
  assert.ok(counts && unass, 'tab counters should be extractable');
  const sandbox = { esc: value => String(value), Number, String, Object, Array,
    STATE: { mapTabs: [{ sheetId: 'S1', tabGid: '1', advertiserId: 'adv_a' }, { sheetId: 'S1', tabGid: '2' }] } };
  vm.createContext(sandbox);
  vm.runInContext(unass[0] + '\n' + counts[0] + '\n' + match[0], sandbox);
  const html = sandbox._ovmbSummaryHtml([
    { inadPm: '만두', works: 7, noMatch: 1, finishCand: 0 },
    { inadPm: '망고', works: 4, noMatch: 0, finishCand: 2 },
  ], 11, 6, 1, false, true, true);
  assert.match(html, /만두 1개 업체 · 7건/);
  assert.match(html, /망고 1개 업체 · 4건/);
  assert.match(html, /업체 지정 작업/);            // 시트 개수가 아니라 작업 기준으로 말한다
  assert.match(html, /활성 작업 2건 · 미지정 1건/);
});

test('keeps rows safe and selectable through the existing company selector', () => {
  assert.match(source, /onclick="selAdv\(\$\{i\}\)"/);
  assert.match(source, /function selAdv\(i, opt\)/);
  assert.match(source, /document\.querySelectorAll\('\.advitem'\)/);
});

test('renders the ownership footer without relying on another function scope for admin access', () => {
  const footer = source.match(/function _ovmRenderFoot\(\)\{[\s\S]*?\n\}/);
  assert.ok(footer, 'ownership footer should be extractable');
  assert.match(footer[0], /const isAdmin\s*=\s*STATE\.role==='master'\s*\|\|\s*STATE\.role==='admin';/);
});

test('ends the loading state when the mapping-tab request rejects', () => {
  const view = source.match(/async function renderOwnershipView\(\)\{[\s\S]{0,4200}?catch\(err\)\{ _ovmLoadFailed\(err&&err\.message\); return; \}/);
  assert.ok(view, 'ownership view should have a terminating error handler');
  assert.match(view[0], /try\{[\s\S]{0,900}if\(!STATE\.mapTabs\|\|!STATE\.mapTabs\.length\)\{ const r=await api\('\/api\/trackb\/tabs\?limit=500&forMapping=1'\); STATE\.mapTabs=\(r&&r\.tabs\)\|\|\[\]; \}[\s\S]{0,260}buildTabIndex\(STATE\.mapTabs\)/);
});

test('renders an error state instead of leaving the B-style screen loading after a mapping-tab failure', async () => {
  const match = source.match(/async function renderOwnershipView\(\)\{[\s\S]*?\n\}\r?\n\r?\n\/\* ══ 업체관리 리디자인/);
  assert.ok(match, 'ownership view should be extractable');
  let failure = '';
  const sandbox = {
    STATE: { pendingAdv: null, mapTabs: null, role: 'admin' },
    _ovmAdvQ: '', _ovmAdvF: 'all', _ovmQ: '', _ovmF: 'all',
    _ovmCloseDrawer() {},
    $: selector => selector === '#viewroot' ? { innerHTML: '' } : null,
    api: async () => { throw new Error('mapping tabs unavailable'); },
    buildTabIndex() { throw new Error('should not build an index after a failed request'); },
    _ovmLoadFailed: reason => { failure = reason; },
  };
  vm.createContext(sandbox);
  vm.runInContext(match[0].replace(/\r?\n\/\* ══ 업체관리 리디자인$/, ''), sandbox);
  await vm.runInContext('renderOwnershipView()', sandbox);
  assert.equal(failure, 'mapping tabs unavailable');
});

/* ── 업체관리 개요 표: 검색 동작 + 업체별 뷰어 링크복사 (2026-08-19) ─────────────────────── */

test('hides filtered-out rows for real (grid display beats the UA [hidden] rule)', () => {
  // ★ 이 한 줄이 없으면 row.hidden 을 세워도 .ovm-ovt{display:grid} 가 이겨 검색이 무동작이 된다.
  assert.match(source, /\.ovm-ovt\[hidden\]\{display:none\}/);
  // 그 뒤에 .ovm-ovt 에 display 를 다시 세우는 규칙이 없어야 한다(있으면 다시 무동작).
  const after = source.slice(source.indexOf('.ovm-ovt[hidden]{display:none}'));
  assert.ok(!/\n\s*\.ovm-ovt(\.[a-z]+)?\{[^}]*display:/.test(after), '.ovm-ovt 에 display 재선언 금지');
});

test('search compares lowercase on both sides and reports an empty result', () => {
  const fn = source.match(/function _ovmbFilterRows\(v\)\{[\s\S]*?\n\}/);
  assert.ok(fn, 'filter helper should be extractable');
  // 행 쪽 값도 소문자로 저장해야 영문 담당AE 가 걸린다.
  assert.match(source, /data-ovmb-search="\$\{esc\(\(String\(a\.name\|\|''\)\+' '\+String\(a\.inadPm\|\|''\)\)\.toLowerCase\(\)\)\}"/);
  const rows = [
    { dataset: { ovmbSearch: '자연생각 김수만' }, hidden: false },
    { dataset: { ovmbSearch: '어니스트캄 kim ae' }, hidden: false },
  ];
  const out = { textContent: '' };
  const sandbox = { document: { querySelectorAll: () => rows }, $: sel => (sel === '#ovmbCnt' ? out : null) };
  vm.createContext(sandbox);
  vm.runInContext(fn[0], sandbox);
  sandbox._ovmbFilterRows('어니');
  assert.deepEqual(rows.map(r => r.hidden), [true, false]);
  assert.equal(out.textContent, '1개 업체');
  sandbox._ovmbFilterRows('KIM');           // 영문은 대소문 무관하게 걸려야 한다
  assert.deepEqual(rows.map(r => r.hidden), [true, false]);
  sandbox._ovmbFilterRows('없는업체');       // 0건은 조용히 빈 표로 두지 않는다
  assert.match(out.textContent, /검색 결과 없음/);
  sandbox._ovmbFilterRows('');
  assert.deepEqual(rows.map(r => r.hidden), [false, false]);
  assert.equal(out.textContent, '2개 업체');
});

test('every company row carries a viewer-link copy button that does not open the company', () => {
  assert.match(source, /class="ovm-lkcopy"[\s\S]{0,200}onclick="event\.stopPropagation\(\);_ovmCopyAdvLink\(\$\{i\},this\)"/);
  // 게이트 = 서버 라우트(internalMiddleware) 와 1:1 — AE 포함(2026-08-19 사용자 확정).
  assert.match(source, /class="ovm-lkcell">\$\{_isInternalRole\(\)\?\(lkb\+lkcopy\)/);
  assert.match(source, /const lkcopy = _isInternalRole\(\)/);
  // 업체 패널의 접속 링크 섹션도 같은 게이트여야 한다(복사 버튼이 안내하는 [다시 활성]에 갈 곳이 있어야 한다).
  assert.match(source, /function _advLinkHtml\(a\)\{[\s\S]{0,300}?if\(!_isInternalRole\(\)\) return '';/);
  // 헤더 칸 수 ≡ 행 칸 수 (열을 끼워 넣을 때 가장 흔히 깨지는 자리)
  const head = source.match(/<div class="ovm-ovt h">([\s\S]*?)<\/div>/);
  assert.ok(head, 'overview header should be extractable');
  assert.equal((head[1].match(/<span>/g) || []).length, 7);
});

test('copy button fetches the token on demand and refuses to hand out a revoked link', async () => {
  const parts = ['_ovmClipWrite', '_ovmCopyAdvLink', '_advLinkUrl'].map(name => {
    const re = name === '_ovmCopyAdvLink'
      ? /async function _ovmCopyAdvLink\(i, btn\)\{[\s\S]*?\n\}/
      : (name === '_ovmClipWrite' ? /function _ovmClipWrite\(text\)\{[\s\S]*?\n\}/ : /function _advLinkUrl\(token\)\{[^\n]*\}/);
    const m = source.match(re);
    assert.ok(m, name + ' should be extractable');
    return m[0];
  });
  const toasts = []; let calls = [];
  const sandbox = {
    STATE: { role: 'admin', advs: [{ id: 'a1', name: '어니스트캄' }] },
    toast: t => toasts.push(t),
    location: { origin: 'https://x.test' },
    navigator: { clipboard: { writeText: async () => {} } },
    document: { createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }), body: { appendChild() {} } },
    api: async (url, opt) => { calls.push([url, JSON.parse(opt.body)]); return { ok: true, link: { token: 'T1', active: true } }; },
  };
  vm.createContext(sandbox);
  vm.runInContext(parts.join('\n'), sandbox);

  const btn = { disabled: false, textContent: '🔗 링크복사' };
  await sandbox._ovmCopyAdvLink(0, btn);
  assert.deepEqual(calls[0], ['/api/trackb/advertiser-link', { action: 'ensure', advertiserId: 'a1' }]);
  assert.match(toasts.pop(), /복사됨/);
  assert.equal(btn.disabled, false);   // 실패·성공 어느 쪽이든 버튼은 되살아난다

  sandbox.api = async () => ({ ok: true, link: { token: 'T1', active: false } });
  await sandbox._ovmCopyAdvLink(0, btn);
  assert.match(toasts.pop(), /폐기 상태/);   // ★ 죽은 링크는 복사하지 않는다

  sandbox.api = async () => { throw new Error('net'); };
  await sandbox._ovmCopyAdvLink(0, btn);
  assert.match(toasts.pop(), /불러오지 못했습니다/);
  assert.equal(btn.disabled, false);
});

async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('  ok ' + name);
    } catch (error) {
      console.error('  not ok ' + name + '\n    ' + error.message);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) console.log('\nownership B-style checks passed');
}
run();
