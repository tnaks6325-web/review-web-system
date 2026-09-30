const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const routes = read('server/src/routes/campaign.routes.js');
const cards = read('frontend/js/campaign-cards.js');
const recruit = read('frontend/js/index-recruit.js');
const campaign = read('frontend/campaign.html');
const creditService = read('server/src/services/popularCredit.service.js');
const apply = routes.slice(routes.indexOf('async function _applyParticipation'), routes.indexOf("router.post('/:id/apply'"));
const flags = routes.slice(routes.indexOf("router.post('/admin/:id/flags'"), routes.indexOf("router.post('/admin/create'"));

assert(creditService.includes('POPULAR_CREDIT_VALIDITY_DAYS = 1'), 'popular policy must expire normal credits after one day');
assert(creditService.includes('ca.submitted_at BETWEEN $1 AND $2'), 'popular policy must only count recent normal completions');
assert(creditService.includes('const credit = queue.credits[queue.next]'), 'popular policy must match credits with a linear FIFO queue');
assert(apply.includes('loadPopularCreditState(client, holdP8)'), 'popular apply must use the shared credit calculation');
assert(!apply.includes('campaign_popular_prerequisites'), 'legacy prerequisite queue must not gate popular participation');
assert(!apply.includes('_currentPopularPrerequisite'), 'popular apply must not select a required normal campaign');
assert(!flags.includes('campaign_popular_prerequisites'), 'popular flag setting must not write a prerequisite queue');
assert(/async function togglePopular\(campId, on\)/.test(cards), 'admin popular toggle must only send ON/OFF');
assert(!cards.includes('openPopularPriorityModal'), 'admin popular toggle must not open a priority modal');
assert(!recruit.includes('window.openPopularPriorityModal'), 'admin screen must not expose the priority modal');
assert(!campaign.includes('gateInfo.prerequisite'), 'reviewer gate must not require a specific normal campaign');
assert(!campaign.includes('prerequisiteId:String(id)'), 'popular return flow must not depend on a prerequisite id');

console.log('popularCreditPolicy: passed');
