const assert = require('assert');
const fs = require('fs');
const path = require('path');

const quota = require('../src/services/linkedRecruitQuota.service');
const scope = require('../src/utils/sheetlessScope');

async function run() {
  const before = scope.isSheetless;
  const calls = [];
  const rows = [
    { id: 'p1', seq: 1, reviewer_name: '참여자', recipient_name: '', phone8: '', order_submission_id: null },
    { id: 'p2', seq: 2, reviewer_name: '', recipient_name: '', phone8: '', order_submission_id: 'order-2' },
    { id: 'e3', seq: 3, reviewer_name: '', recipient_name: '', phone8: '', order_submission_id: null },
    { id: 'e4', seq: 4, reviewer_name: '', recipient_name: '', phone8: '', order_submission_id: null },
    { id: 'e5', seq: 5, reviewer_name: '', recipient_name: '', phone8: '', order_submission_id: null },
    { id: 'e6', seq: 6, reviewer_name: '', recipient_name: '', phone8: '', order_submission_id: null },
  ];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/SELECT id, seq, tab_gid, reviewer_name/.test(String(sql))) return { rows };
      if (/UPDATE campaign_participants/.test(String(sql))) return { rowCount: 2, rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  try {
    scope.isSheetless = async () => true;
    const out = await quota.syncWorktableSlotsInTx(client,
      { linked_sheet_id: 'sheet', linked_tab_name: 'tab' }, 4, 'row-cap-test');
    assert.deepStrictEqual(
      { target: out.target, add: out.add, retire: out.retire },
      { target: 4, add: 0, retire: 2 },
    );
    const retire = calls.find(x => /UPDATE campaign_participants/.test(x.sql));
    assert.deepStrictEqual(retire.params[0], ['e6', 'e5']);

    await assert.rejects(
      () => quota.syncWorktableSlotsInTx(client,
        { linked_sheet_id: 'sheet', linked_tab_name: 'tab' }, 1, 'row-cap-test'),
      err => err.code === 'recruit_quota_worktable_below_used',
    );

    const sharedClient = {
      async query(sql) {
        if (/FROM recruit_campaigns/.test(String(sql))) return { rows: [{ id: 'other-campaign' }, { id: 'this-campaign' }] };
        throw new Error(`participants must not be changed for a shared worktable: ${sql}`);
      },
    };
    const shared = await quota.syncWorktableSlotsInTx(sharedClient,
      { id: 'this-campaign', linked_sheet_id: 'sheet', linked_tab_name: 'tab' }, 4, 'row-cap-test');
    assert.deepStrictEqual({ synced: shared.synced, reason: shared.reason }, { synced: false, reason: 'shared_worktable' });
  } finally {
    scope.isSheetless = before;
  }

  const planSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'campaignPlan.service.js'), 'utf8');
  { // 조절 저장 = 슬롯 상한 동기화 뒤에 날짜 맞추기(수동 재구성은 결정 185 로 제거 — 이 경로 하나)
    const sp = planSource.slice(planSource.indexOf('async function savePlans'));
    assert.ok(sp.indexOf('syncWorktableSlotsInTx(') > 0 && sp.indexOf('syncWorktableSlotsInTx(') < sp.indexOf('await _relayInTx(client, camp, today'),
      '조절 저장은 슬롯 상한 동기화 뒤에 날짜를 재배치해야 합니다.');
  }
  // ★ 결정 182 — 날짜 맞추기(relay)는 줄을 만들지 않는다. 줄 수를 바꾸는 곳은 슬롯 상한 동기화뿐이어야 상한이 지켜진다.
  const dailySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'sheetlessDailyPlan.service.js'), 'utf8');
  assert.doesNotMatch(dailySource, /INSERT INTO campaign_participants/,
    '작업표 날짜 맞추기는 줄을 새로 만들면 안 됩니다(총 인원 상한을 넘긴다).');
  assert.doesNotMatch(planSource, /rebuildAdjustedPlansToWorktable|syncAdjustedPlansToWorktable/,
    '줄을 만들던 옛 재배치 함수가 되살아나면 안 됩니다.');
  assert.match(planSource, /const totalCap = _totalCapFor\(camp, schedule, orderTotal\)/,
    '조절 저장은 연결 발주 정원을 포함한 실제 총건수를 상한으로 써야 합니다.');
  assert.match(planSource, /SELECT \* FROM recruit_campaigns WHERE id = \$1 FOR UPDATE', \[campaignId\]/,
    '조절 저장은 잠금된 최신 공고 행으로 상한을 계산해야 합니다.');
  console.log('worktableRowCapInvariant: 5 passed');
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
