const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = path.join(__dirname, '..');
const root = path.join(server, '..');
const readServer = (file) => fs.readFileSync(path.join(server, file), 'utf8');
const readFrontend = (file) => fs.readFileSync(path.join(root, 'frontend', file), 'utf8');

const routes = readServer('src/routes/campaign.routes.js');
const creditService = readServer('src/services/popularCredit.service.js');
const cards = readFrontend('js/campaign-cards.js');
const recruit = readFrontend('js/index-recruit.js');
const campaign = readFrontend('campaign.html');
const searchApp = readFrontend('js/search-app.js');
const manualOrder = readServer('src/services/manualOrder.service.js');
const apply = routes.slice(routes.indexOf('async function _applyParticipation'), routes.indexOf("router.post('/:id/apply'"));
const flags = routes.slice(routes.indexOf("router.post('/admin/:id/flags'"), routes.indexOf("router.post('/admin/create'"));

assert.match(creditService, /normal_done/, 'normal submitted campaigns are counted');
assert.match(creditService, /popular_used/, 'submitted and active popular holds are counted as consumed');
assert.match(creditService, /ca\.phone8 = \$1/, 'credit accounting is isolated by participating identity');
assert.match(routes, /is_popular_snapshot\)/, 'reviewer application stores immutable popularity');
assert.match(manualOrder, /is_popular_snapshot\)/, 'manual application stores immutable popularity');
assert.match(apply, /loadPopularCreditState\(client, holdP8\)/, 'apply evaluates credits after the identity lock');
assert.match(apply, /canUsePopularCredit\(creditState\)/, 'apply blocks only when no credit remains');
assert(apply.indexOf("'popular_locked'") < apply.indexOf('INSERT INTO campaign_applications'), 'a blocked application cannot create a hold');
assert(!apply.includes('campaign_popular_prerequisites'), 'legacy queue rows cannot gate popular participation');
assert(!flags.includes('campaign_popular_prerequisites'), 'admin popular toggle cannot write a legacy queue');
assert.match(cards, /async function togglePopular\(campId, on\)/, 'admin popularity toggle only persists ON/OFF');
assert(!cards.includes('openPopularPriorityModal'), 'admin toggle has no priority modal callback');
assert(!recruit.includes('legacyPopularToggle'), 'legacy priority UI is removed');
assert(!recruit.includes('popularPriorityQueue'), 'legacy priority queue DOM is removed');
assert(!campaign.includes('gateInfo.prerequisite'), 'reviewer UI never requires a specific normal campaign');
assert(!campaign.includes('requiredTitle'), 'reviewer UI has no stale prerequisite title state');
assert.match(campaign, /남은 참여권/, 'reviewer UI shows the remaining credit count');
assert.match(campaign, /_camp && _camp\.participation_mode && _camp\.is_popular !== true/, 'return CTA is limited to the selected normal participation campaign');
assert.match(campaign, /embed:'1',\s*mode:'form'/, 'embedded purchase forms force form mode even when a sheet link is unavailable');
assert(!campaign.includes('PREVIEW && !f.sheetId'), 'admin preview follows the same purchase-form mode as the reviewer path for unlinked campaigns');
assert.match(searchApp, /const isFormMode = !!sheetId \|\| params\.get\("mode"\) === "form"/, 'search page supports an explicit form-mode entry');
assert.match(searchApp, /if \(!ctx\.sheetId \|\| \(!ctx\.tabName && !ctx\.gid\)\)/, 'missing sheet mapping blocks submission instead of routing to the home screen');

console.log('campaignPinnedPopular: passed');
