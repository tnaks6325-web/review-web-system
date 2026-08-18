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

test('server uses a DB-only campaign scope for every reviewer campaign', () => {
  assert.ok(/async function _resolveCampaignOrderScope/.test(submit), 'server-owned campaign scope resolver is missing');
  assert.ok(/sheetless: true/.test(submit), 'DB-only campaign branch is missing');
  assert.ok(/skipSheetMirror: orderScope\.sheetless/.test(submit), 'sheetless submissions must skip Google Sheet mirroring');
  assert.ok(/if \(!orderScope\) \{[\s\S]*?참여 문맥/.test(submit), 'anonymous sheetless submission must remain blocked');
  assert.ok(/if \(skipSheetMirror\) \{[\s\S]*?mirror_status = 'written'/.test(ledger),
    'DB-only submission must finish without row claim or sync queue');
});

test('campaign confirmation can explicitly bypass old sheet binding after server hold verification', () => {
  assert.ok(/skipTabBinding/.test(holds), 'DB-only campaign confirmation flag is missing');
  assert.ok(/if \(!skipTabBinding && !tabMatchesCampaign\(camp, sheetId, gid, tabName\)\)/.test(holds),
    'legacy sheet binding must be bypassed only on the explicit server path');
});

console.log(`\n${passed} sheetless purchase checks passed`);
