'use strict';

const assert = require('assert');
const { mergeDepositStamps, removeDepositStamp } = require('../src/utils/depositStamp');

assert.equal(mergeDepositStamps('8/12', '8/11'), '8/11, 8/12', 'earlier manual payment must be retained alongside a later transfer');
assert.equal(mergeDepositStamps('2026.8.11, 8/12', '8/11'), '8/11, 8/12', 'the same payment date must not be duplicated');
assert.equal(mergeDepositStamps('8/11, 8/12', '8/12'), '8/11, 8/12', 're-applying a result must be idempotent');
assert.equal(removeDepositStamp('8/11, 8/12', '8/12'), '8/11', 'a verified correction may move only the later transfer date');
assert.equal(removeDepositStamp('8/11, 8/12', '8/13'), '8/11, 8/12', 'an absent date must never alter the payment audit trail');

console.log('deposit stamp merge contract passed');
