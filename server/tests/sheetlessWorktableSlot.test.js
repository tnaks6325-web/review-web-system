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
assert.ok(/SELECT row_json FROM campaign_participants/.test(source), 'legacy worktables without RAW metadata must recover headers from their prepared DB slots');
assert.ok(/recoverUnwrittenSheetlessOrders/.test(source), 'existing ledger-only orders need a DB worktable recovery path');
assert.ok(/reconcileCampaignWorktableLinks/.test(source), 'recovery must repair a missing campaign-to-worktable link before replaying submitted orders');
assert.ok(/rc\.source_work_order_id = wo\.id[\s\S]*?wo\.linked_campaign_id = rc\.id/.test(source), 'link repair must use persisted work-order identities, not title matching');
assert.ok(!/os\.sheet_id LIKE 'campaign:%'/.test(source), 'recovery must include pre-transition campaign orders that still carry legacy sheet keys');
assert.ok(/JOIN campaign_applications ca/.test(source), 'recovery must be scoped by the verified campaign application, not a client-supplied sheet key');
assert.ok(/COALESCE\(rc\.linked_sheet_id, ''\) <> ''/.test(source) && /COALESCE\(rc\.linked_tab_name, ''\) <> ''/.test(source), 'recovery must only write to campaigns with an internal worktable');
assert.ok(/os\.campaign_application_id = ca\.id[\s\S]*?ca\.order_submission_id = os\.id[\s\S]*?ca\.late_order_id = os\.id/.test(source), 'recovery must include legacy orders linked from the application record');
assert.ok(/NOT EXISTS \([\s\S]*?cp\.order_submission_id = os\.id/.test(source), 'recovery must skip orders already linked to a worktable row');
assert.ok(/ORDER BY os\.submitted_at ASC/.test(source), 'recovery must order the order ledger by submitted_at; order_submissions has no created_at column');
assert.ok(!/os\.created_at/.test(source), 'recovery must never read the non-existent order_submissions.created_at column');
assert.ok(/startup-recovery/.test(app) && /recoverUnwrittenSheetlessOrders/.test(app), 'existing missing worktable rows must be recovered after deployment without reviewer resubmission');

console.log('sheetless worktable slot checks passed');
