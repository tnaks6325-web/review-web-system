'use strict';

const assert = require('assert');
const { decideAutoApply } = require('../src/services/paymentResult.service');

process.on('uncaughtException', error => {
  console.error(error.stack || error);
  process.exit(1);
});

function decision(summary, duplicateApplied = false) {
  return decideAutoApply({ summary, duplicateApplied });
}

assert.deepStrictEqual(
  decision({ items: 10, matched: 9, unmatchedResults: 0 }),
  { allowed: true, matchRate: 0.9, blockers: [] },
  '회차 대상의 정확 매칭이 90%면 자동 반영한다');

assert.deepStrictEqual(
  decision({ items: 10, matched: 8, unmatchedResults: 0 }),
  { allowed: false, matchRate: 0.8, blockers: ['match_below_90'] },
  '정확 매칭이 90% 미만이면 자동 반영하지 않는다');

assert.deepStrictEqual(
  decision({ items: 10, matched: 10, unmatchedResults: 1 }),
  { allowed: false, matchRate: 1, blockers: ['result_outside_batch'] },
  '회차 밖 결과 행이 있으면 매칭률과 무관하게 자동 반영하지 않는다');

assert.deepStrictEqual(
  decision({ items: 10, matched: 10, unmatchedResults: 0 }, true),
  { allowed: false, matchRate: 1, blockers: ['duplicate_file'] },
  '이미 반영된 동일 결과 파일은 자동 반영하지 않는다');

assert.deepStrictEqual(
  decision({ items: 0, matched: 0, unmatchedResults: 0 }),
  { allowed: false, matchRate: 0, blockers: ['no_pending_items'] },
  '대상이 없는 결과 파일은 자동 반영하지 않는다');

console.log('payment result auto-apply decision tests passed');
