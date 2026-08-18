const assert = require('assert');
const { displayRecruitTotal } = require('../src/services/linkedRecruitQuota.service');

const fromCampaign = displayRecruitTotal(300, 900);
assert.deepStrictEqual(fromCampaign, { total: 300, source: 'campaign' });

const fromWorkOrder = displayRecruitTotal(0, 900);
assert.deepStrictEqual(fromWorkOrder, { total: 900, source: 'work_order' });

const noFallback = displayRecruitTotal(0, 0);
assert.deepStrictEqual(noFallback, { total: 0, source: 'none' });

console.log('work-order recruit display fallback: ok');
