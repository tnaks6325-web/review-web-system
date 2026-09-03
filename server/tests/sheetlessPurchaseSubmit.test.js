const fs = require('fs');
const path = require('path');
const assert = require('assert');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const campaign = read('../../frontend/campaign.html');
const search = read('../../frontend/js/search-app.js');
const submit = read('../src/routes/submit.routes.js');
const ledger = read('../src/services/orderLedger.service.js');
const holds = read('../src/services/campaignHold.service.js');

let passed = 0;
const test = (name, fn) => { fn(); console.log('  ok  ' + name); passed++; };

test('campaign iframe does not put sheetId/tabName/gid in the reviewer URL', () => {
  const start = campaign.indexOf('const qp = new URLSearchParams({ embed');
  const end = campaign.indexOf('// 관리자 미리보기', start);
  const block = campaign.slice(start, end);
  assert.ok(start >= 0 && /embed:'1'/.test(block), 'iframe query construction is missing');
  assert.ok(!/\bs:f\.sheetId|\bg:f\.gid|\bt:f\.tabName/.test(block), 'reviewer URL still depends on sheet parameters');
});

test('embedded purchase form opens and submits without sheet parameters', () => {
  assert.ok(/const isFormMode = !!sheetId \|\| !!_EMBED_CTX \|\| params\.get\("mode"\) === "form";/.test(search),
    'embed=1 must be a valid purchase form entry point');
  const body = search.slice(search.indexOf('async function submitOrderForm'), search.indexOf('function _renderCaptureChecklist'));
  assert.ok(!/잘못된 링크입니다\. \(sheetId\/tabName 또는 gid 필요\)/.test(body),
    'client must not reject a reviewer because sheet identifiers are absent');
  assert.ok(!/서버 연결 정보가 없습니다/.test(body),
    'legacy GAS URL configuration must not block API-based submission');
});

test('server uses a DB-only campaign scope and writes the verified order to the DB worktable', () => {
  assert.ok(/async function _resolveCampaignOrderScope/.test(submit), 'server-owned campaign scope resolver is missing');
  assert.ok(/sheetless: true/.test(submit), 'DB-only campaign branch is missing');
  assert.ok(/skipSheetMirror: skipSheetMirrorForWrite/.test(submit), 'sheetless submissions must skip Google Sheet mirroring');
  assert.ok(/const skipSheetMirrorForWrite = !!orderScope\.sheetless \|\| queuedWorkboardApply/.test(submit),
    'an approved queued workboard target must skip legacy sheet-row claiming even for a non-campaign submission');
  assert.ok(/if \(!orderScope\) \{[\s\S]*?참여 문맥/.test(submit), 'anonymous sheetless submission must remain blocked');
  assert.ok(/if \(skipSheetMirror\) \{[\s\S]*?mirror_status = 'written'/.test(ledger),
    'DB-only submission must finish without row claim or sync queue');
  assert.ok(/linked_sheet_id, linked_tab_name, linked_tab_gid/.test(submit),
    'verified campaign must resolve its DB worktable key');
  assert.ok(/orderScope\.worktable/.test(submit) && /writeOrderToWorktable/.test(submit),
    'DB-only submission must be written to the worktable, not only the order ledger');
});

test('sheetless worktable write failure is persisted instead of leaving the ledger pending', () => {
  const start = submit.indexOf('if (ledger.sheetRow && !queuedWorkboardApply)');
  const end = submit.indexOf('if (ledger.sheetRow && !sheetlessDone && !queuedWorkboardApply)', start);
  const branch = submit.slice(start, end);
  assert.ok(start >= 0 && end > start, 'sheetless follow-up branch is missing');
  assert.ok(/if \(!sheetlessDone\.ok\) \{[\s\S]*?try \{[\s\S]*?await markOrderMirrorFailed\(ledger\.orderSubmissionId, sheetlessDone\.message \|\| sheetlessDone\.reason\)[\s\S]*?\} catch \(statusErr\)/.test(branch),
    'failed sheetless worktable writes must persist failed status and the reason');
  assert.ok(/무시트 실패상태 저장 실패\(원장 저장은 완료\)/.test(branch),
    'a secondary status-write failure must not turn a saved submission into a client-visible failure');
});

test('approved workboard queue targets always enqueue outside the campaign-only branch', () => {
  const queueStart = submit.indexOf('if (queuedWorkboardApply) {');
  const queueEnd = submit.indexOf('} else if (orderScope.sheetless) {', queueStart);
  const queueBranch = submit.slice(queueStart, queueEnd);
  assert.ok(queueStart >= 0 && queueEnd > queueStart, 'queued workboard branch must precede the campaign-only direct branch');
  assert.ok(/enqueue\('workboard_apply'/.test(queueBranch) && /await markOrderQueued\(ledger\.orderSubmissionId\)/.test(queueBranch),
    'an approved target must either be queued and marked queued before any direct-write branch is considered');
});

test('queued workboard registration failure is persisted rather than left pending', () => {
  const dispatchStart = submit.indexOf('if (queuedWorkboardApply) {');
  const dispatchEnd = submit.indexOf('if (ledger.sheetRow && !queuedWorkboardApply)', dispatchStart);
  const dispatch = submit.slice(dispatchStart, dispatchEnd);
  assert.ok(/if \(sheetlessDone && !sheetlessDone\.ok\) \{[\s\S]*?await markOrderMirrorFailed\(ledger\.orderSubmissionId, sheetlessDone\.message \|\| sheetlessDone\.reason\)/.test(dispatch),
    'a failed queue registration must transition the durable order ledger to failed');
});

test('campaign confirmation can explicitly bypass old sheet binding after server hold verification', () => {
  assert.ok(/skipTabBinding/.test(holds), 'DB-only campaign confirmation flag is missing');
  assert.ok(/if \(!skipTabBinding && !tabMatchesCampaign\(camp, sheetId, gid, tabName\)\)/.test(holds),
    'legacy sheet binding must be bypassed only on the explicit server path');
});

console.log(`\n${passed} sheetless purchase checks passed`);
