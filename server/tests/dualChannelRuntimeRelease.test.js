'use strict';
// 결정 341 「출시(켜기)」 — 준비 상태의 기본값은 코드에 박힌 출시 상태(모두 열림)다.
// 끄는 길은 이 커밋 되돌리기뿐이고, 시험에서만 __setReadinessForTest({}) 로 닫을 수 있다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const OPS = ['settings', 'roundtrip', 'recruitment', 'purchase', 'review', 'payment'];
const fresh = () => {
  delete require.cache[require.resolve('../src/services/dualChannelRuntime.service')];
  return require('../src/services/dualChannelRuntime.service');
};

test('출시 상태: 주입 없이 모든 동시진행 operation 이 열려 있다', () => {
  const rt = fresh();
  for (const op of OPS) {
    assert.equal(rt.isDualChannelReady(op), true, op);
    assert.doesNotThrow(() => rt.assertDualChannelReady(op), op);
  }
  const state = rt.getDualChannelReadiness();
  for (const key of [...OPS, 'operationalEnabled']) assert.equal(state[key], true, key);
});

test('시험 주입 __setReadinessForTest({}) 로 닫으면 모든 operation 이 닫힌다', () => {
  const rt = fresh();
  rt.__setReadinessForTest({});
  for (const op of OPS) {
    assert.equal(rt.isDualChannelReady(op), false, op);
    assert.throws(() => rt.assertDualChannelReady(op), e => e.code === 'dual_channel_not_ready', op);
  }
});

test('환경변수·NODE_ENV 로 출시 상태를 바꾸는 길이 코드에 없다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/dualChannelRuntime.service.js'), 'utf8');
  // NODE_ENV 는 시험 주입 함수의 "시험에서만" 확인에만 쓰인다.
  const envUses = src.match(/process\.env\.[A-Z_]+/g) || [];
  assert.deepEqual([...new Set(envUses)], ['process.env.NODE_ENV']);
  assert.equal((src.match(/process\.env/g) || []).length, 1);
  assert.doesNotMatch(src, /require\(['"][^'"]*(db|pool|config|settings)['"]\)/i);
  const rt = fresh();
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { assert.throws(() => rt.__setReadinessForTest({}), /test dependency injection only/); }
  finally { process.env.NODE_ENV = prev; }
  assert.equal(rt.isDualChannelReady('recruitment'), true);
});
