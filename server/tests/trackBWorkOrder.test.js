/**
 * Track B 작업오더(발주) 연동 회귀가드 — 수동 링크(Track B 전용 테이블) + 작업세부 + 명단 골격(gap-fill).
 *   ★★ Track A 무접촉: linkWorkOrder는 work_orders 를 절대 UPDATE하지 않고 trackb_work_order_links(051)에만 씀
 *      (work_orders.linked_tab_* 는 order.routes 승인 흐름이 읽어 동작을 분기하므로).
 *   ★ prepareRosterSlots 부족분만 생성(멱등), 유효 링크 = Track B 링크 우선 → work_orders.linked_tab 폴백.
 * 실행: node tests/trackBWorkOrder.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');
const participants = require('../src/services/participants.service');

function makePool(scn = {}) {
  const q = [];
  return {
    q,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/AS cur,.*AS nextseq/.test(s)) return { rows: [{ cur: scn.cur == null ? 0 : scn.cur, nextseq: scn.nextseq || 900001, tab_gid: scn.tabGid || null }] };
      if (/INSERT INTO campaign_participants/.test(s)) return { rows: [] };
      if (/SELECT work_order_id FROM trackb_work_order_links/.test(s)) return { rows: scn.tbLink ? [{ work_order_id: scn.tbLink }] : [] };
      if (/FROM work_orders w LEFT JOIN LATERAL/.test(s)) return { rows: scn.woList || [] };
      if (/SELECT id FROM work_orders WHERE id=\$1/.test(s)) return { rows: scn.woExists === false ? [] : [{ id: (params && params[0]) || 'wo' }] };
      if (/INSERT INTO trackb_work_order_links/.test(s)) return { rows: [] };
      if (/UPDATE trackb_work_order_links SET deleted_at/.test(s)) return { rowCount: scn.unlinkRc == null ? 1 : scn.unlinkRc };
      if (/FROM work_orders WHERE deleted_at IS NULL AND \(\$3/.test(s)) return { rows: scn.linkedWo ? [scn.linkedWo] : [] };
      return { rows: [] };
    },
  };
}

async function run() {
  // ═══ 1. prepareRosterSlots — gap-fill·멱등 ═══
  let p = makePool({ cur: 52 }); participants.__setPoolForTest(p);
  let r = await participants.prepareRosterSlots({ sheetId: 'S1', tabName: 'T', target: 50 });
  assert.deepEqual(r, { target: 50, current: 52, created: 0 }, '1a: 충족이면 생성 0');
  assert.ok(!p.q.some(x => /INSERT INTO campaign_participants/.test(x.s)), '1a: INSERT 미실행(무오염)');

  p = makePool({ cur: 2, nextseq: 900010, tabGid: '11' }); participants.__setPoolForTest(p);
  r = await participants.prepareRosterSlots({ sheetId: 'S1', tabName: 'T', target: 5, options: ['A', 'B'], productName: '상품X', by: 'master' });
  assert.deepEqual(r, { target: 5, current: 2, created: 3 }, '1b: 부족분 3칸');
  const ins = p.q.find(x => /INSERT INTO campaign_participants/.test(x.s));
  assert.equal(ins.params.length, 12, '1b: 파라미터 12개(고정3 + 슬롯3×3)');
  assert.deepEqual([ins.params[3], ins.params[6], ins.params[9]], ['A', 'B', 'A'], '1b: 옵션 라운드로빈');

  p = makePool({ cur: 0 }); participants.__setPoolForTest(p);
  r = await participants.prepareRosterSlots({ sheetId: 'S1', tabName: 'T', target: 999999 });
  assert.equal(r.target, 2000, '1c: target 상한 2000 클램프');
  participants.__setPoolForTest(null);
  console.log('  1. prepareRosterSlots — gap-fill·멱등·라운드로빈·상한 ✓');

  // ═══ 2. listWorkOrders — Track B 링크상태 매핑(work_orders.linked_tab 미의존) ═══
  p = makePool({ woList: [
    { id: 'wo1', title: '멀티비타민', recruitCount: 50, status: 'published', createdAt: 't', linkSheetId: 'S1', linkTabName: 'T' },
    { id: 'wo2', title: '타탭', recruitCount: 30, status: 'done', createdAt: 't', linkSheetId: 'S9', linkTabName: 'X' },
    { id: 'wo3', title: '미연결', recruitCount: 10, status: 'submitted', createdAt: 't', linkSheetId: null, linkTabName: null },
  ] });
  svc.__setPoolForTest(p);
  const list = await svc.listWorkOrders({ sheetId: 'S1', tabName: 'T' });
  const g = (id) => list.find(x => x.id === id);
  assert.equal(g('wo1').linkedHere, true, '2a: 이 탭 Track B 링크 → linkedHere');
  assert.equal(g('wo2').linkedElsewhere, true, '2b: 타 탭 링크 → linkedElsewhere');
  assert.equal(g('wo3').linkedHere, false, '2c: 미연결');
  assert.equal(g('wo3').linkedElsewhere, false, '2c: 미연결은 elsewhere도 false');
  assert.equal(list[0].id, 'wo1', '2d: linkedHere가 목록 최상단');
  console.log('  2. listWorkOrders — Track B 링크 상태 매핑 ✓');

  // ═══ 3. linkWorkOrder / unlinkWorkOrder — work_orders 무접촉 ═══
  p = makePool({}); svc.__setPoolForTest(p);
  r = await svc.linkWorkOrder({ workOrderId: 'wo1', sheetId: 'S1', tabName: 'T', tabGid: '11' });
  assert.equal(r.ok, true, '3a: 링크 성공');
  assert.ok(p.q.some(x => /INSERT INTO trackb_work_order_links/.test(x.s)), '3a: Track B 링크 테이블에 INSERT');
  assert.ok(!p.q.some(x => /UPDATE work_orders/.test(x.s)), '3a: ★work_orders 절대 미접촉(Track A 승인흐름 무영향)');
  p = makePool({ woExists: false }); svc.__setPoolForTest(p);
  r = await svc.linkWorkOrder({ workOrderId: 'nope', sheetId: 'S1', tabName: 'T' });
  assert.equal(r.error, 'work_order_not_found', '3b: 없는 발주 → 거부');
  p = makePool({ unlinkRc: 1 }); svc.__setPoolForTest(p);
  r = await svc.unlinkWorkOrder({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.ok, true, '3c: 해제 성공');
  assert.ok(p.q.some(x => /UPDATE trackb_work_order_links SET deleted_at/.test(x.s)), '3c: Track B 링크 소프트삭제');
  assert.ok(!p.q.some(x => /UPDATE work_orders/.test(x.s)), '3c: 해제도 work_orders 무접촉');
  console.log('  3. link/unlink — Track B 전용 테이블(work_orders 무접촉) ✓');

  // ═══ 4. prepareRosterFromWorkOrder — 유효 링크 게이트 ═══
  p = makePool({ tbLink: null, linkedWo: null }); svc.__setPoolForTest(p);
  r = await svc.prepareRosterFromWorkOrder({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.error, 'no_linked_work_order', '4a: 연결 발주 없음');
  p = makePool({ tbLink: 'wo1', linkedWo: { recruitCount: 0, optionsJson: '', productOption: '', title: 't' } }); svc.__setPoolForTest(p);
  r = await svc.prepareRosterFromWorkOrder({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.error, 'recruit_count_zero', '4b: 모집 0 → 거부');
  svc.__setPoolForTest(makePool({ tbLink: 'wo1', linkedWo: { recruitCount: 5, optionsJson: '["A"]', productOption: '', title: '캠페인' } }));
  participants.__setPoolForTest(makePool({ cur: 0, nextseq: 900001 }));
  r = await svc.prepareRosterFromWorkOrder({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.ok, true, '4c: 위임 성공');
  assert.equal(r.created, 5, '4c: 모집 5 → 5칸 생성');
  svc.__setPoolForTest(null); participants.__setPoolForTest(null);
  console.log('  4. prepareRosterFromWorkOrder — no_link·zero·위임 ✓');

  console.log('✅ trackBWorkOrder 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
