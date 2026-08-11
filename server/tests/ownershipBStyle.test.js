'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log('  ok ' + name);
  } catch (error) {
    console.error('  not ok ' + name + '\n    ' + error.message);
    process.exitCode = 1;
  }
}

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

if (!process.exitCode) console.log('\nownership B-style checks passed');
