'use strict';
// 칸 순서가 다르거나 칸이 빠진 구매양식 — 값의 생김새로 자리를 찾는다(사용자 확정 2026-11-06).
// ① 이름이 하나뿐이면 리뷰어·수취인·예금주 세 칸에 모두 ② 이름이 둘이면 계좌번호 바로 옆 이름 = 예금주, 남은 이름 = 리뷰어·수취인
// ③ 아이디 칸이 없으면 빈칸. 자동 배치는 반드시 드러낸다(repairs/warnings) · 애매하면 넣지 않고 오류.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSlashLine } = require('../src/utils/slashForm');

const ADDR = '경기도 안산시 단원구 도일로26, 휴먼시아904동211호';
const USER_LINE = `김수만/sungmin0809@naver.com/010-8592-6325/${ADDR}/하나은행/338-910-330-03807/김수만`;

const shown = r => (r.repairs || []).concat(r.warnings || []).join(' | ');

test('user sample: one name (twice), no recipient column, no price → all filled, price missing', () => {
  const r = parseSlashLine(USER_LINE);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['결제금액']);
  const f = r.fields;
  assert.equal(f.reviewerName, '김수만');
  assert.equal(f.recipient, '김수만');
  assert.equal(f.depositor, '김수만');
  assert.equal(f.userId, 'sungmin0809@naver.com');
  assert.equal(f.phone, '010-8592-6325');
  assert.equal(f.address, ADDR);
  assert.equal(f.bank, '하나은행');
  assert.equal(f.account, '338-910-330-03807');
  assert.equal(f.price == null, true);
  assert.match(shown(r), /자동 배치/);
});

test('user sample + price → ok, flagged as auto-placed', () => {
  const r = parseSlashLine(USER_LINE + '/15800');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.fields.price, 15800);
  assert.equal(r.fields.recipient, '김수만');
  assert.match(shown(r), /자동 배치/);
});

test('single name written once → reviewer = recipient = depositor', () => {
  const r = parseSlashLine(`010-8592-6325/김수만/하나은행/338-910-330-03807/${ADDR}/15,800원`);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.fields.reviewerName, '김수만');
  assert.equal(r.fields.recipient, '김수만');
  assert.equal(r.fields.depositor, '김수만');
  assert.equal(r.fields.userId, '');
  assert.equal(r.fields.price, 15800);
  assert.match(shown(r), /이름이 하나/);
});

test('two names: the one next to the account is the depositor, the other is reviewer and recipient', () => {
  const r = parseSlashLine(`박지영/kim01/010-1111-2222/${ADDR}/국민은행/123456-01-123456/김수만/15800`);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.fields.reviewerName, '박지영');
  assert.equal(r.fields.recipient, '박지영');
  assert.equal(r.fields.depositor, '김수만');
});

test('shuffled order is placed by shape', () => {
  const r = parseSlashLine(`15800/신한은행/110-123-456789/김수만/${ADDR}/010-1234-5678/sungmin08/김수만`);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.fields.bank, '신한은행');
  assert.equal(r.fields.account, '110-123-456789');
  assert.equal(r.fields.phone, '010-1234-5678');
  assert.equal(r.fields.userId, 'sungmin08');
  assert.equal(r.fields.depositor, '김수만');
  assert.match(shown(r), /자동 배치/);
});

test('canonical 9-field line is NOT flagged as auto-placed (unchanged path)', () => {
  const r = parseSlashLine(`김수만/김수만/sungmin08/010-1234-5678/${ADDR}/신한은행/110-123-456789/김수만/15800`);
  assert.equal(r.ok, true);
  assert.doesNotMatch(shown(r), /자동 배치/);
});

test('ambiguous: two account-like numbers → not placed (error)', () => {
  const r = parseSlashLine(`김수만/010-1234-5678/${ADDR}/신한은행/110-123-456789/110-999-888777/15800`);
  assert.equal(r.ok, false);
  assert.ok(!r.fields || !r.fields.account, 'nothing placed silently');
});

test('ambiguous: two phones (two people on one line) → error', () => {
  const r = parseSlashLine(`김수만/010-1234-5678/${ADDR}/박지영/010-2222-3333/신한은행/110-123-456789/15800`);
  assert.equal(r.ok, false);
});

test('ambiguous: two different names and none next to the account → error', () => {
  const r = parseSlashLine(`김수만/박지영/010-1234-5678/신한은행/110-123-456789/${ADDR}/15800`);
  assert.equal(r.ok, false);
});

test('unknown leftover value → error, not silently dropped', () => {
  const r = parseSlashLine(`김수만/010-1234-5678/${ADDR}/신한은행/110-123-456789/블랙 L 사이즈/15800`);
  assert.equal(r.ok, false);
});

test('no bank → error (required, cannot guess)', () => {
  const r = parseSlashLine(`김수만/010-1234-5678/${ADDR}/110-123-456789/15800`);
  assert.equal(r.ok, false);
});
