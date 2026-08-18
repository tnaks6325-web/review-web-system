const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { allocateOptionQuotas, firstRoundQuota } = require('../src/services/linkedRecruitQuota.service');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('ok - ' + name); }
  catch (err) { console.error('not ok - ' + name); throw err; }
}

test('활성 옵션 정원은 작업오더 목표에 맞춰 기존 비율로 배분한다', () => {
  const next = allocateOptionQuotas([
    { opt_key: 'A', recruit_total: 10, status: 'active' },
    { opt_key: 'B', recruit_total: 30, status: 'active' },
  ], 80);
  assert.strictEqual(next.get('A'), 20);
  assert.strictEqual(next.get('B'), 60);
});

test('기존 정원이 모두 0이면 활성 옵션에 균등 배분한다', () => {
  const next = allocateOptionQuotas([
    { opt_key: 'A', recruit_total: 0, status: 'active' },
    { opt_key: 'B', recruit_total: 0, status: 'active' },
    { opt_key: 'C', recruit_total: 0, status: 'active' },
  ], 10);
  assert.deepStrictEqual([next.get('A'), next.get('B'), next.get('C')], [4, 3, 3]);
});

test('닫힌 옵션 정원은 보존하고 나머지만 활성 옵션에 배분한다', () => {
  const next = allocateOptionQuotas([
    { opt_key: '종료', recruit_total: 12, status: 'closed' },
    { opt_key: '진행', recruit_total: 8, status: 'active' },
  ], 30);
  assert.strictEqual(next.get('종료'), undefined);
  assert.strictEqual(next.get('진행'), 18);
});

test('참여 또는 진행 중인 인원보다 작게 줄이는 저장은 거부한다', () => {
  assert.throws(() => allocateOptionQuotas([
    { opt_key: 'A', recruit_total: 10, status: 'active' },
  ], 4, new Map([['A', 5]])), err => err.code === 'recruit_quota_below_used');
});

test('차수 공고는 후속 차수를 보존하고 1차를 조절해 총원을 맞춘다', () => {
  assert.deepStrictEqual(firstRoundQuota([
    { round_no: 1, slot_count: 100 }, { round_no: 2, slot_count: 30 },
  ], 180), { roundNo: 1, slotCount: 150 });
});

test('후속 차수 합계보다 낮은 목표는 차수 불변식을 깨므로 거부한다', () => {
  assert.throws(() => firstRoundQuota([
    { round_no: 1, slot_count: 100 }, { round_no: 2, slot_count: 30 },
  ], 30), err => err.code === 'recruit_quota_round_conflict');
});

test('공고 수정과 작업오더의 세 저장 경로가 공통 동기화기를 호출한다', () => {
  const campaignRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/campaign.routes.js'), 'utf8');
  const orderRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/order.routes.js'), 'utf8');
  assert.match(campaignRoutes, /syncCampaignRecruitTotal\(\{ campaignId: rows\[0\]\.id/);
  assert.match(campaignRoutes, /syncCampaignRecruitTotal\(\{ campaignId: id/);
  assert.strictEqual((orderRoutes.match(/syncWorkOrderRecruitTotal\(/g) || []).length, 3);
  assert.strictEqual((orderRoutes.match(/assertWorkOrderQuota\(/g) || []).length, 3);
});

console.log(`linkedRecruitQuota: ${passed} passed`);
