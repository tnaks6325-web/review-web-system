'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const service = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', 'services', name), 'utf8');
const result = service('paymentResult.service.js');
const status = service('sheetlessStatus.service.js');

// A payment batch remembers the old review-index row.  If a sheetless board
// was rebuilt in the meantime, the current participant sequence may differ.
// The write must resolve a unique live participant before it can claim success.
assert.match(result, /COALESCE\(p\.seq, i\.row_index\) AS target_row_index/);
assert.match(result, /cp\.seq = i\.row_index/);
assert.match(result, /same_phone\.phone8 = i\.phone8/);
assert.match(result, /AND 1 = \(\s*SELECT COUNT\(\*\)/);
assert.match(result, /LEFT JOIN recruit_campaigns rc ON rc\.id = i\.campaign_id/);
assert.match(result, /rc\.linked_sheet_id/);
assert.match(result, /rc\.linked_tab_name/);

// The workdesk renders campaign_participants.row_json, not raw_sheet_rows.
// A confirmation using another projection would reintroduce false-green UI.
const verify = status.slice(status.indexOf('async function verifyStatusCell'), status.indexOf('async function markSheetlessMemo'));
assert.match(verify, /FROM campaign_participants/);
assert.match(verify, /row_json ->> \$4/);
assert.doesNotMatch(verify, /raw_sheet_rows/);

console.log('payment deposit backfill target tests passed');
