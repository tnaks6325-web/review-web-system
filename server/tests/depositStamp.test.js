'use strict';

const assert = require('assert');
const { mergeDepositStamps } = require('../src/utils/depositStamp');

assert.equal(mergeDepositStamps('8/12', '8/11'), '8/11, 8/12', 'earlier manual payment must be retained alongside a later transfer');
assert.equal(mergeDepositStamps('2026.8.11, 8/12', '8/11'), '8/11, 8/12', 'the same payment date must not be duplicated');
assert.equal(mergeDepositStamps('8/11, 8/12', '8/12'), '8/11, 8/12', 're-applying a result must be idempotent');

console.log('deposit stamp merge contract passed');
