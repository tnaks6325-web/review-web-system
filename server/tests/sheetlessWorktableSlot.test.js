const fs = require('fs');
const path = require('path');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '../src/services/sheetlessOrder.service.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

assert.ok(/order_submission_id = \$3::uuid/.test(source), 'idempotent retry must find its existing worktable row');
assert.ok(/FOR UPDATE SKIP LOCKED/.test(source), 'concurrent submissions must claim different open slots');
assert.ok(/order_submission_id IS NULL/.test(source), 'only an unlinked slot may be claimed');
assert.ok(/order_submission_id = \$9::uuid/.test(source), 'the claimed worktable row must link to the order ledger');
/* ★★ 작업보드의 모집 정원은 실제 행 수와 같아야 한다. 일반 제출·재시도·복구는 빈 슬롯이
   없으면 행을 늘리지 않고, 외부모집 수동제출만 원장의 출처·수취인·연락처를 확인한 뒤 예외로
   이어붙일 수 있다. 이 경계가 풀리면 300건 작업에 빈 301번 슬롯이 생긴다. */
assert.ok(/async function _isConfirmedExternalManualOrder/.test(source), 'external-manual overflow gate must exist');
assert.ok(/order\.source === 'admin_external'/.test(source), 'only admin_external orders may overflow the planned row count');
assert.ok(/order\.recipient/.test(source) && /phone_digits/.test(source), 'overflow must require confirmed recipient and phone data');
assert.ok(/const confirmedExternalManual = await _isConfirmedExternalManualOrder/.test(source), 'no-slot branch must check the ledger-backed external-manual gate');
assert.ok(/if \(!confirmedExternalManual\) \{[\s\S]{0,360}?reason: 'no_open_slot'/.test(source),
  'ordinary no-slot writes must roll back instead of preparing an overflow row');
assert.ok(/confirmedExternalManual[\s\S]{0,1400}?appendSlot\(client/.test(source),
  'only the confirmed external-manual branch may append a physical overflow row');
assert.ok(/const confirmedExternalManual = await _isConfirmedExternalManualOrder\(client, orderSubmissionId\);[\s\S]{0,420}?없는 지정 행 거부/.test(source),
  'a missing explicitly assigned row must also reject ordinary orders instead of recreating an overflow slot');
/* ★ "문자열이 있나"로 재면 호출을 죽여도(`if(false)` · 다른 함수로 교체) 통과한다 —
   변이시험이 실제로 뚫었다. 호출 형태와 **순서**를 고정한다. */
assert.ok(/await client\.query\('SELECT pg_advisory_xact_lock\(hashtext\(\$1\)\)'/.test(source),
  'the per-tab advisory lock must be a real query on the write transaction');
assert.ok(source.indexOf('pg_advisory_xact_lock') < source.indexOf('FOR UPDATE SKIP LOCKED'),
  'the lock must be taken before slots are claimed, otherwise two orders can take the same seq');
assert.ok(/if \(!tc\.length \|\| !tc\[0\]\.sheetless\) \{[\s\S]{0,200}?no_open_slot/.test(source),
  'append must be fail-closed to sheetless-registered tabs (the branch, not just the query text)');
assert.ok(!/INSERT INTO campaign_participants[\s\S]{0,200}?COALESCE\(MAX\(seq\)/.test(source), 'the append INSERT belongs to participants.service (single writer), not here');
assert.ok(!/getSpreadsheetMeta\(/.test(source) && !/writeSheet\(/.test(source), 'worktable write must not call Google Sheets');
assert.ok(/SELECT row_json FROM campaign_participants/.test(source), 'legacy worktables without RAW metadata must recover headers from their prepared DB slots');
assert.ok(/recoverUnwrittenSheetlessOrders/.test(source), 'existing ledger-only orders need a DB worktable recovery path');
assert.ok(/reconcileCampaignWorktableLinks/.test(source), 'recovery must repair a missing campaign-to-worktable link before replaying submitted orders');
assert.ok(/rc\.source_work_order_id = wo\.id[\s\S]*?wo\.linked_campaign_id = rc\.id/.test(source), 'link repair must use persisted work-order identities, not title matching');
// ★★ 이 검사는 **복구 함수 본문에만** 적용한다 — 파일 전체를 훑으면, 나중에 합류한
//   `repairWrittenMarkForBoardRows`(작업보드 줄은 있는데 원장만 미완결인 주문을 정정)가
//   `campaign:%` 를 **일부러** 대상으로 삼는 것까지 잡아 멀쩡한 코드를 회귀로 신고한다(실제로 그랬다).
const recoverySrc = (() => {
  const i = source.indexOf('async function recoverUnwrittenSheetlessOrders(');
  assert.ok(i > -1, 'recovery function not found');
  const nextDoc = source.indexOf('작업보드 줄은 **이미 있는데**', i);
  const e = source.lastIndexOf('/**', nextDoc);
  assert.ok(e > i, 'recovery function end not found');
  return source.slice(i, e);
})();
assert.ok(!/os\.sheet_id LIKE 'campaign:%'/.test(recoverySrc), 'recovery must include pre-transition campaign orders that still carry legacy sheet keys');
assert.ok(/JOIN campaign_applications ca/.test(source), 'recovery must be scoped by the verified campaign application, not a client-supplied sheet key');
assert.ok(/COALESCE\(rc\.linked_sheet_id, ''\) <> ''/.test(source) && /COALESCE\(rc\.linked_tab_name, ''\) <> ''/.test(source), 'recovery must only write to campaigns with an internal worktable');
assert.ok(/os\.campaign_application_id = ca\.id[\s\S]*?ca\.order_submission_id = os\.id[\s\S]*?ca\.late_order_id = os\.id/.test(source), 'recovery must include legacy orders linked from the application record');
assert.ok(/NOT EXISTS \([\s\S]*?cp\.order_submission_id = os\.id/.test(source), 'recovery must skip orders already linked to a worktable row');
assert.ok(/ORDER BY os\.submitted_at ASC/.test(source), 'recovery must order the order ledger by submitted_at; order_submissions has no created_at column');
assert.ok(!/os\.created_at/.test(source), 'recovery must never read the non-existent order_submissions.created_at column');
// ★★ 2026-08-19 긴급 조치: 부팅 자동 복구는 **기본 OFF**.
//   이 잡은 os 행 단위로만 멱등이라, 같은 실물 주문의 중복 os 가 부팅마다 빈 슬롯을 하나씩 더 소비했다
//   (작업보드 중복 반영 · 정원 초과의 직접 원인). 되살리려면 중복 방어(주문 1건 = 줄 1개)를 먼저 세울 것.
assert.ok(/recoverUnwrittenSheetlessOrders/.test(app), 'the manual/opt-in recovery wiring must stay in app.js');
assert.ok(/SHEETLESS_RECOVER_ON_BOOT === '1'/.test(app), 'startup recovery must stay behind an explicit opt-in env flag');
{
  const hook = app.slice(app.indexOf("SHEETLESS_RECOVER_ON_BOOT === '1'"));
  const gateIdx = hook.indexOf('SHEETLESS_RECOVER_ON_BOOT');
  const callIdx = hook.indexOf('recoverUnwrittenSheetlessOrders');
  assert.ok(gateIdx >= 0 && callIdx > gateIdx, 'the env gate must come before the recovery call, not after it');
}
// 사람이 직접 돌릴 수 있는 창구는 남아 있어야 한다(막다른 길 금지).
const diagSrc = fs.readFileSync(path.join(__dirname, '../src/routes/diag.routes.js'), 'utf8');
assert.ok(/router\.post\('\/sheetless-worktable-recover', authMiddleware, adminOrMasterMiddleware/.test(diagSrc),
  'manual recovery endpoint must remain available to admin/master');

console.log('sheetless worktable slot checks passed');
