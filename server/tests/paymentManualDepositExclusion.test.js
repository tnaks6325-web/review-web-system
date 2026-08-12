/* `8/11` manual deposit markers on the workboard must suppress payment targets. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../src/services/payment.service.js'), 'utf8');
const listStart = source.indexOf('async function listPaymentTargets');
const listEnd = source.indexOf('\nasync function _loadCampaigns', listStart);
const listSource = source.slice(listStart, listEnd);

assert.match(listSource, /participant_edits pe/, 'manual workboard edits must be part of payment target filtering');
assert.match(listSource, /pe\.field\s*=\s*'col:입금'/, 'only the deposit column may trigger exclusion');
assert.match(listSource, /btrim\(pe\.value_text\)\s*=\s*'8\/11'/, 'only the approved 8/11 marker may trigger exclusion');
assert.match(listSource, /pe\.reverted_at\s+IS\s+NULL/, 'cleared or reverted markers must not exclude a target');
assert.match(listSource, /cp\.seq\s*=\s*ri\.row_index/, 'manual marker must match the same workboard row');
assert.doesNotMatch(listSource, /btrim\(pe\.value_text\)\s*<>\s*''/, 'other non-empty manual values such as errors must not exclude a target');

console.log('payment manual deposit exclusion contract passed');
