/** 중복 줄 정리 뒤 단일 연결 공고의 빈 슬롯을 총 모집수까지 보충하는 회귀가드. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const quota = fs.readFileSync(path.join(__dirname, '../src/services/linkedRecruitQuota.service.js'), 'utf8');
const ledger = fs.readFileSync(path.join(__dirname, '../src/services/sheetlessLedger.service.js'), 'utf8');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

ok('보충 함수가 단일 공고만 선택한다',
  /tier\.length !== 1[\s\S]*shared_worktable/.test(quota));
ok('연결 공고 전체를 읽어 오래된 공유 공고도 놓치지 않는다', (() => {
  const start = quota.indexOf('async function replenishWorktableSlotsToLinkedQuota');
  const end = quota.indexOf('// 과거의 빈 초과 슬롯만 정리한다', start);
  return start > -1 && !/LIMIT 10/.test(quota.slice(start, end));
})());
ok('임시저장과 게시 중 공고를 우선한다',
  /status === 'draft' \|\| r\.status === 'active'/.test(quota));
ok('목표 이상인 표는 줄이지 않는다',
  /checked\.add <= 0[\s\S]*already_at_or_above_target/.test(quota));
ok('기존 정원 동기화 실행부로만 슬롯을 쓴다',
  /syncWorktableSlotsInTx\(client, campaign, target, by\)/.test(quota));
ok('중복 주문을 정리한 뒤 보충하고 그 다음 번호를 다시 매긴다', (() => {
  const cancel = ledger.indexOf('softDeleteDuplicateOrders(cancelOsIds');
  const replenish = ledger.indexOf('.replenishWorktableSlotsToLinkedQuota(', cancel);
  const renumber = ledger.indexOf('_renumberAfterRetire(sheetId, tabName', replenish);
  return cancel > -1 && replenish > cancel && renumber > replenish;
})());
ok('보충 실패를 성공으로 숨기지 않고 결과에 싣는다',
  /quotaReplenishError/.test(ledger) && /quotaReplenish, quotaReplenishError/.test(ledger));

// 운영 사고와 같은 93/100 상태를 서비스 함수로 실행해 7칸만 추가되는지 확인한다.
const poolPath = require.resolve('../src/db/pool');
let inserted = 0;
const filledRows = Array.from({ length: 93 }, (_, i) => ({
  id: `row-${i}`, seq: i + 1, reviewer_name: `reviewer-${i}`,
  recipient_name: '', phone8: '', order_submission_id: `order-${i}`, tab_gid: '893285617',
}));
const client = {
  query: async (sql) => {
    const s = String(sql);
    if (/AS work_order_recruit_total/.test(s)) return { rows: [{
      id: 'camp-0807', linked_sheet_id: 'sheet', linked_tab_name: 'tab', linked_tab_gid: '893285617',
      recruit_total: 100, status: 'draft', source_work_order_id: null, work_order_recruit_total: null,
    }] };
    if (/SELECT COALESCE\(sheetless/.test(s)) return { rows: [{ s: true }] };
    if (/WHERE participation_mode AND status='active'/.test(s)) return { rows: [] };
    if (/COUNT\(\*\)::int AS live/.test(s)) return { rows: [{ live: 93 }] };
    if (/SELECT id, seq, tab_gid, reviewer_name/.test(s)) return { rows: filledRows };
    if (/SELECT reviewer_name, recipient_name, phone8/.test(s)) return { rows: filledRows };
    if (/SELECT COALESCE\(MAX\(seq\)/.test(s)) return { rows: [{ max_seq: 156 }] };
    if (/INSERT INTO campaign_participants/.test(s)) { inserted++; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  },
  release: () => {},
};
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { connect: async () => client, query: (...args) => client.query(...args) },
};
delete require.cache[require.resolve('../src/services/linkedRecruitQuota.service')];

(async () => {
  const svc = require('../src/services/linkedRecruitQuota.service');
  const result = await svc.replenishWorktableSlotsToLinkedQuota({ sheetId: 'sheet', tabName: 'tab', by: 'test' });
  ok('93/100 작업보드에는 빈 슬롯 7개만 보충한다', result.add === 7 && inserted === 7);
  ok('보충 뒤 목표 정원을 결과에 남긴다', result.target === 100);
  console.log(`dedupeQuotaReplenish: ${passed} passed`);
})().catch(err => { console.error(err); process.exit(1); });
