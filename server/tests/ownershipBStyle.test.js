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
  const sandbox = { esc: value => String(value) };
  vm.createContext(sandbox);
  vm.runInContext(match[0], sandbox);
  const html = sandbox._ovmbSummaryHtml([
    { inadPm: '만두', works: 7, noMatch: 1, finishCand: 0 },
    { inadPm: '망고', works: 4, noMatch: 0, finishCand: 2 },
  ], 11, 6, 1, false, true, true);
  assert.match(html, /만두 1개 업체 · 7건/);
  assert.match(html, /망고 1개 업체 · 4건/);
});

test('keeps rows safe and selectable through the existing company selector', () => {
  assert.match(source, /onclick="selAdv\(\$\{i\}\)"/);
  assert.match(source, /function selAdv\(i, opt\)/);
  assert.match(source, /document\.querySelectorAll\('\.advitem'\)/);
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
