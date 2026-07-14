/**
 * Track B P2-2 write-back 시뮬레이터 회귀가드 — 심판 확정(경로 정합: 플랜=유일 op 산출원).
 *   ★ 시뮬레이션은 시트 무접촉(플랜만) · 실제 적용은 TRACK_B_WRITEBACK_FULL 트리거 뒤에서만(기본 OFF=완전 inert).
 *   가드 분류: 안전군 ok / 위험군(소유권키·주문매핑칸·manual) risky_* / 차단(앵커·컬럼·행·gid 없음).
 *   ★ 계약 변경(심판): 옵션칸은 mapOrderToSheetRow 주문매핑칸 → 'ok'가 아니라 'risky_order_mapped'
 *     (컬럼 disjoint Blocker — order_append 와 같은 칸 접촉 금지).
 * 실행: node tests/trackBWritebackSim.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');
const ol = require('../src/services/orderLedger.service');

const HEADERS = ['번호', '참여자', '연락처', '수취인', '리뷰제출', '옵션', '입금'];

function svcPool(scn) {
  return { async query(sql) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/source_of_truth AS "sourceOfTruth" FROM tab_configs/.test(s)) return { rows: scn.sot ? [{ sourceOfTruth: scn.sot }] : [] };
    if (/SELECT id, anchor_type, anchor_value, field, kind, value_bool, value_text FROM participant_edits/.test(s)) return { rows: scn.edits || [] };
    if (/reviewer_name, recipient_name, phone8, round, option_text, product_name/.test(s) && /FROM campaign_participants/.test(s)) return { rows: scn.roster || [] };
    return { rows: [] };
  } };
}
function olPool() {
  return { async query(sql) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/FROM raw_sheet_tabs/.test(s)) return { rows: [{ sheet_id: 'S1', tab_gid: '11', tab_name: 'T', detected_headers: HEADERS, header_row_index: 1, data_start_row: 2, _dup: 1 }] };
    return { rows: [] };
  } };
}

async function run() {
  const SAVED = process.env.TRACK_B_WRITEBACK_FULL;

  // ═══ 1. simulateWriteback — 가드/tier 분류(시트 무접촉) ═══
  const roster = [{
    id: 'r1', seq: 1, reviewer_name: '홍길동', recipient_name: '김철수', phone8: '11112222', round: '1',
    option_text: '', product_name: '', sheet_row: 10, tab_gid: '11', submit_col: '리뷰제출', submit_col2: '입금',
    source: 'import', order_submission_id: 'o1', identity_key: 'phone8:11112222', deleted_at: null, active: true,
  }];
  const edits = [
    { id: 'e1', anchor_type: 'order', anchor_value: 'o1', field: 'is_submitted', kind: 'bool', value_bool: true, value_text: null },
    { id: 'e2', anchor_type: 'order', anchor_value: 'o1', field: 'option_text', kind: 'text', value_bool: null, value_text: 'A안' },
    { id: 'e3', anchor_type: 'order', anchor_value: 'o1', field: 'recipient_name', kind: 'text', value_bool: null, value_text: '새이름' },
    { id: 'e4', anchor_type: 'order', anchor_value: 'zzz', field: 'round', kind: 'text', value_bool: null, value_text: '2' },
  ];
  svc.__setPoolForTest(svcPool({ sot: 'db', edits, roster }));
  ol.__setPoolForTest(olPool());
  delete process.env.TRACK_B_WRITEBACK_FULL;

  const sim = await svc.simulateWriteback({ sheetId: 'S1', tabName: 'T' });
  assert.equal(sim.mode, 'simulate', '1a: 모드 simulate');
  assert.equal(sim.cutover, true, '1a: cutover 반영');
  assert.equal(sim.triggerOn, false, '1a: 트리거 OFF');
  assert.equal(sim.noMeta, false, '1a: 메타 있음 표기');
  const byField = {}; for (const o of sim.ops) byField[o.field || o.type] = o;
  assert.equal(byField['is_submitted'].type, 'toggle', '1b: 토글 op');
  assert.equal(byField['is_submitted'].guard, 'ok', '1b: 토글 → ok(리뷰제출 열 존재·비매핑)');
  assert.equal(byField['is_submitted'].column, 'E', '1b: 리뷰제출=E열(idx4)');
  assert.equal(byField['is_submitted'].tier, 'base', '1b: 토글=base tier(cron)');
  assert.equal(byField['option_text'].guard, 'risky_order_mapped', '1c: 옵션칸=주문매핑칸 → 위험(disjoint, 구 ok 계약 의도 변경)');
  assert.equal(byField['option_text'].column, 'F', '1c: 옵션=F열(idx5) — 좌표는 표시');
  assert.equal(byField['option_text'].tier, 'manual', '1c: 시뮬만·실적용 제외');
  assert.equal(byField['recipient_name'].guard, 'risky_ownership_key', '1d: 수취인 편집 → 위험(소유권키)');
  assert.equal(byField['round'].guard, 'no_anchor', '1e: 앵커 없는 편집 → 차단');
  assert.equal(sim.summary.ok, 1, '1f: 반영가능 1(토글만 — 옵션은 disjoint 제외)');
  assert.equal(sim.summary.risky, 2, '1f: 위험 2(옵션+수취인)');
  assert.equal(sim.summary.blocked, 1, '1f: 차단 1(앵커없음)');
  assert.equal(sim.summary.byTier.base, 1, '1g: byTier base=1');
  assert.equal(sim.summary.byTier.manual, 2, '1g: byTier manual=2');
  assert.equal(sim.summary.byTier.blocked, 1, '1g: byTier blocked=1');
  console.log('  1. simulateWriteback — 가드/tier 분류(토글ok·옵션 disjoint 위험·수취인 위험·앵커차단) ✓');

  // ═══ 2. applyWritebackFull — 트리거 OFF면 완전 inert ═══
  delete process.env.TRACK_B_WRITEBACK_FULL;
  svc.__setPoolForTest(svcPool({ sot: 'db', edits, roster }));   // cutover여도
  let r = await svc.applyWritebackFull({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.skipped, true, '2a: 트리거 OFF → skipped');
  assert.equal(r.reason, 'trigger_off', '2a: 트리거 OFF면 시트 무접촉(시뮬레이션만)');

  // 2b: 트리거 ON이어도 cutover 아니면 not_cutover
  process.env.TRACK_B_WRITEBACK_FULL = '1';
  svc.__setPoolForTest(svcPool({ sot: 'sheet', edits, roster }));
  r = await svc.applyWritebackFull({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.reason, 'not_cutover', '2b: 트리거 ON+비cutover → not_cutover');
  console.log('  2. applyWritebackFull — 트리거 OFF/비cutover 이중게이트(inert) ✓');

  svc.__setPoolForTest(null); ol.__setPoolForTest(null);
  if (SAVED === undefined) delete process.env.TRACK_B_WRITEBACK_FULL; else process.env.TRACK_B_WRITEBACK_FULL = SAVED;
  console.log('✅ trackBWritebackSim 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
