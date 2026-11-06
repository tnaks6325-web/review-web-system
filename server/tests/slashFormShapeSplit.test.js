'use strict';
// 슬래시를 중간에 빼먹은 양식 — 칸 순서가 달라도(생김새로 자리 찾기) 붙은 칸을 나눠 제자리에 놓는다(사용자 2026-11-06).
// 나눈 곳은 반드시 드러낸다 · 나누는 방법이 둘 이상으로 갈리면 넣지 않고 오류.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSlashLine } = require('../src/utils/slashForm');

const A = '경기도 안산시 단원구 도일로26, 휴먼시아904동211호';
const ID = 'sungmin0809@naver.com';
const EXP = { reviewerName: '김수만', recipient: '김수만', userId: ID, phone: '010-8592-6325', address: A, bank: '하나은행', account: '338-910-330-03807', depositor: '김수만', price: 15800 };
const shown = r => (r.repairs || []).concat(r.warnings || []).join(' | ');

const CASES = [
  ['이름+아이디', `김수만${ID}/010-8592-6325/${A}/하나은행/338-910-330-03807/김수만/15800`],
  ['아이디+전화', `김수만/${ID}010-8592-6325/${A}/하나은행/338-910-330-03807/김수만/15800`],
  ['전화+주소', `김수만/${ID}/010-8592-6325${A}/하나은행/338-910-330-03807/김수만/15800`],
  ['주소+은행', `김수만/${ID}/010-8592-6325/${A}하나은행/338-910-330-03807/김수만/15800`],
  ['은행+계좌', `김수만/${ID}/010-8592-6325/${A}/하나은행338-910-330-03807/김수만/15800`],
  ['계좌+예금주', `김수만/${ID}/010-8592-6325/${A}/하나은행/338-910-330-03807김수만/15800`],
  ['예금주+금액', `김수만/${ID}/010-8592-6325/${A}/하나은행/338-910-330-03807/김수만15800`],
  ['두 곳 빠짐(주소+은행, 계좌+예금주)', `김수만/${ID}/010-8592-6325/${A}하나은행/338-910-330-03807김수만/15800`],
  ['순서 섞임 + 은행+계좌', `15800/하나은행338-910-330-03807/김수만/${A}/010-8592-6325/${ID}`],
];

for (const [name, line] of CASES) {
  test(`missing slash: ${name} → placed, flagged`, () => {
    const r = parseSlashLine(line);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    for (const k of Object.keys(EXP)) assert.equal(r.fields[k], EXP[k], `${k}: ${r.fields[k]}`);
    assert.ok(shown(r).length > 0, 'the repair is shown');
  });
}

test('missing slash with name+phone and no price → filled, price missing', () => {
  const r = parseSlashLine(`김수만010-8592-6325/${A}/하나은행/338-910-330-03807/김수만`);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['결제금액']);
  assert.equal(r.fields.phone, '010-8592-6325');
  assert.equal(r.fields.reviewerName, '김수만');
  assert.equal(r.fields.userId, '');
});

test('id containing Hangul is not accepted as an id', () => {
  const r = parseSlashLine(`김수만${ID}/010-8592-6325/${A}/하나은행/338-910-330-03807/김수만/15800`);
  assert.equal(r.fields.userId, ID);
});

test('address is not cut into pieces to invent a price', () => {
  // 금액 없음 + 주소에 숫자 — 주소를 '도일로'/'26…'으로 잘라 금액 26 을 만들면 안 된다
  const r = parseSlashLine(`김수만/${ID}/010-8592-6325/${A}/하나은행/338-910-330-03807/김수만`);
  assert.equal(r.fields.address, A);
  assert.equal(r.fields.price == null, true);
});

test('still ambiguous → error, nothing silently placed', () => {
  const r = parseSlashLine(`김수만/${ID}/010-8592-6325/${A}/하나은행/338-910-330-03807/110-222-333444/15800`);
  assert.equal(r.ok, false);
});

test('three missing slashes + no price (user-style line) → all 8 filled, price missing', () => {
  const r = parseSlashLine(`김수만/${ID}010-8592-6325/${A}하나은행/338-910-330-03807김수만`);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['결제금액']);
  for (const k of Object.keys(EXP)) if (k !== 'price') assert.equal(r.fields[k], EXP[k], k);
  assert.match(shown(r), /슬래시\(\/\)가 빠진 곳을 나눴습니다/);
});
