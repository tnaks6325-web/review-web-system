const fs = require('fs');
const path = require('path');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '../src/services/sheetlessOrder.service.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

assert.ok(/order_submission_id = \$3::uuid/.test(source), 'idempotent retry must find its existing worktable row');
assert.ok(/FOR UPDATE SKIP LOCKED/.test(source), 'concurrent submissions must claim different open slots');
assert.ok(/order_submission_id IS NULL/.test(source), 'only an unlinked slot may be claimed');
assert.ok(/order_submission_id = \$9::uuid/.test(source), 'the claimed worktable row must link to the order ledger');
assert.ok(/requestedSeq == null[\s\S]*?no_open_slot/.test(source), 'new sheetless orders must not append beyond prepared roster slots');
assert.ok(!/getSpreadsheetMeta\(/.test(source) && !/writeSheet\(/.test(source), 'worktable write must not call Google Sheets');
assert.ok(/recoverUnwrittenSheetlessOrders/.test(source), 'existing ledger-only orders need a DB worktable recovery path');
assert.ok(/reconcileCampaignWorktableLinks/.test(source), 'recovery must repair a missing campaign-to-worktable link before replaying submitted orders');
assert.ok(/rc\.source_work_order_id = wo\.id[\s\S]*?wo\.linked_campaign_id = rc\.id/.test(source), 'link repair must use persisted work-order identities, not title matching');
assert.ok(!/os\.sheet_id LIKE 'campaign:%'/.test(source), 'recovery must include pre-transition campaign orders that still carry legacy sheet keys');
assert.ok(/JOIN campaign_applications ca ON ca\.id = os\.campaign_application_id/.test(source), 'recovery must be scoped by the verified campaign application, not a client-supplied sheet key');
assert.ok(/COALESCE\(rc\.linked_sheet_id, ''\) <> ''/.test(source) && /COALESCE\(rc\.linked_tab_name, ''\) <> ''/.test(source), 'recovery must only write to campaigns with an internal worktable');
assert.ok(/NOT EXISTS \([\s\S]*?cp\.order_submission_id = os\.id/.test(source), 'recovery must skip orders already linked to a worktable row');
assert.ok(/startup-recovery/.test(app) && /recoverUnwrittenSheetlessOrders/.test(app), 'existing missing worktable rows must be recovered after deployment without reviewer resubmission');

console.log('sheetless worktable slot checks passed');
