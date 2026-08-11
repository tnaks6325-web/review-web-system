'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

test('renders the B-style work-order command summary', () => {
  assert.match(source, /class="wbcmd"/);
  assert.match(source, /class="wbsignal"/);
  assert.match(source, /#wohead \.wbcmd\{/);
  assert.match(source, /#wohead \.wbsignal\{/);
  assert.doesNotMatch(source, /^\s*\.wbcmd\{/m);
  assert.doesNotMatch(source, /^\s*\.wbsignal\{/m);
});

test('keeps the real 1120px list width and processing column', () => {
  assert.match(source, /#wohead \.mh\{max-width:1120px/);
  assert.match(source, /#wobody \.lgwrap\{max-width:1120px/);
  assert.match(source, /th style="width:320px">처리<\/th>/);
});

test('keeps existing processing actions in the real work-order renderer', () => {
  assert.match(source, /function _woEditActions\(o\)/);
  assert.match(source, /접수하기/);
  assert.match(source, /상태변경/);
  assert.match(source, /관리자 수정/);
});

if (!process.exitCode) console.log('\nwork-order B-style checks passed');
