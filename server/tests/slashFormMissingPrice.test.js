'use strict';
// 결제금액만 빠진 구매양식 — 나머지 8칸은 채워 보여 주고 금액만 비운다(사용자 확정 2026-11-06).
// 금액은 지어내지 않는다: ok:false + missing ['결제금액'] → 화면에서 금액 칸에 직접 넣으면 그 줄이 정상으로 바뀐다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSlashLine } = require('../src/utils/slashForm');

const EIGHT = '김수만/김수만/sungmin08/010-1234-5678/서울시 마포구 월드컵로 12, 302호/신한은행/110-123-456789/김수만';

function assertFilledNoPrice(r) {
  assert.equal(r.ok, false, 'price is genuinely missing — the row must not pass on its own');
  assert.deepEqual(r.missing, ['결제금액']);
  assert.equal(r.fields.reviewerName, '김수만');
  assert.equal(r.fields.recipient, '김수만');
  assert.equal(r.fields.userId, 'sungmin08');
  assert.equal(r.fields.phone, '010-1234-5678');
  assert.equal(r.fields.bank, '신한은행');
  assert.equal(r.fields.account, '110-123-456789');
  assert.equal(r.fields.depositor, '김수만');
  assert.equal(r.fields.price == null || r.fields.price === '', true, 'price is never invented');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /결제금액이 없습니다/);
  assert.doesNotMatch(r.errors[0], /칸이 \d+개뿐/, 'not routed to the AI repair fallback (the amount is not in the text)');
}

test('8 fields (price missing) → the 8 fields are filled, only the price stays empty', () => {
  const r = parseSlashLine(EIGHT);
  assertFilledNoPrice(r);
  assert.equal(r.fields.address, '서울시 마포구 월드컵로 12, 302호');
});

test('trailing slash with empty price → same as missing price', () => {
  assertFilledNoPrice(parseSlashLine(EIGHT + '/'));
});

test('address containing a slash + missing price → address merged, price empty', () => {
  const r = parseSlashLine('김수만/김수만/sungmin08/010-1234-5678/서울시 마포구 월드컵로 12/3, 302호/신한은행/110-123-456789/김수만');
  assertFilledNoPrice(r);
  assert.equal(r.fields.address, '서울시 마포구 월드컵로 12/3, 302호');
});

test('sub-account (reviewer ≠ recipient) + missing price keeps the sub-account flag', () => {
  const r = parseSlashLine('박지영/김수만/sungmin08/010-1234-5678/서울시 마포구 12/신한은행/110-123-456789/김수만');
  assert.equal(r.ok, false);
  assert.equal(r.fields.isSubAccount, true);
});

test('complete 9-field line is unchanged', () => {
  const r = parseSlashLine(EIGHT + '/15800');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.fields.price, 15800);
  assert.deepEqual(r.missing, []);
});

test('8 fields missing something other than the price keep the old error', () => {
  // 아이디 칸 빠짐(금액은 있음)
  const r = parseSlashLine('김수만/김수만/010-1234-5678/서울시 마포구 12/신한은행/110-123-456789/김수만/15800');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /칸이 8개뿐/);
  assert.deepEqual(r.fields, {});
});

test('8 fields with bank/account swapped are not silently filled', () => {
  const r = parseSlashLine('김수만/김수만/sungmin08/010-1234-5678/서울시 마포구 12/110-123-456789/신한은행/김수만');
  assert.equal(r.ok, false);
  assert.notEqual(r.fields && r.fields.bank, '110-123-456789');
});

test('screen: a row whose other fields were split gives an empty input for the missing field (no dead end)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../frontend/js/manual-order.js'), 'utf8');
  const i = src.indexOf("FIELD_OF_LABEL[l] === key");
  assert.ok(i > 0);
  const seg = src.slice(i, i + 900);
  assert.match(seg, /if \(Object\.keys\(f\)\.length\)/);
  assert.match(seg, /placeholder="없음"/);
  assert.match(seg, /ManualOrder\.edit\(\$\{i\},'\$\{key\}',this\.value\)/);
});
