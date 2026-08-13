'use strict';

const assert = require('assert');
const { mergeDepositStamps, removeDepositStamp } = require('../src/utils/depositStamp');
const { nowStamp } = require('../src/services/paymentApply.service');

assert.equal(nowStamp(new Date('2026-08-13T09:36:00Z')), '8/13 18:36', '입금일은 리뷰제출일과 같은 M/D HH:mm 형식이다');
assert.equal(mergeDepositStamps('2026.8.13', '2026.8.13 18:36'), '8/13 18:36', '기존 연도 표기는 실제 이체 시각이 있는 M/D HH:mm으로 보정한다');

assert.equal(mergeDepositStamps('8/12', '8/11'), '8/11, 8/12', 'earlier manual payment must be retained alongside a later transfer');
assert.equal(mergeDepositStamps('2026.8.11, 8/12', '8/11'), '8/11, 8/12', 'the same payment date must not be duplicated');
assert.equal(mergeDepositStamps('8/11, 8/12', '8/12'), '8/11, 8/12', 're-applying a result must be idempotent');
assert.equal(removeDepositStamp('8/11, 8/12', '8/12'), '8/11', 'a verified correction may move only the later transfer date');
assert.equal(removeDepositStamp('8/11, 8/12', '8/13'), '8/11, 8/12', 'an absent date must never alter the payment audit trail');

console.log('deposit stamp merge contract passed');
