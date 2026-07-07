/**
 * Track B P2 상태 토글 write-back 회귀가드 — 심판 확정 최소 설계.
 *   ★ Track A 리스크 0 증명: (1) 게이트(env·cutover) 없으면 시트 무접촉, (2) _buildToggleWrite가
 *     submit_col/submit_col2 **두 열에만** range 생성(연락처/수취인/주소 물리적 미접촉 → 소유권키 오염 불가),
 *     (3) blank-only(사람셀 클로버 금지)·멱등 no-op, (4) executeWriteback가 Track A 변이함수 미참조.
 *   격리 불변식(source_of_truth 소비처는 Track B 파일뿐)은 tests/trackBSourceOfTruth.test.js 가 별도 고정.
 * 실행: node tests/trackBWriteback.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');

function makePool(scn = {}) {
  const q = [];
  return {
    q,
    async query(sql) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push(s);
      if (/source_of_truth AS "sourceOfTruth" FROM tab_configs/.test(s)) return { rows: scn.sot ? [{ sourceOfTruth: scn.sot }] : [] };
      if (/FROM participant_edits[\s\S]*field IN \('is_submitted','is_paid'\)/.test(s) && /reverted_at IS NULL/.test(s) && /writeback_status IS NULL OR writeback_status='blocked'/.test(s)) return { rows: scn.edits || [] };
      if (/FROM campaign_participants/.test(s)) return { rows: scn.roster || [] };
      if (/UPDATE participant_edits SET writeback_status/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  };
}

// 시트 헤더: 연락처(C, idx2)·수취인(D, idx3)·리뷰제출(F, idx5)·입금(H, idx7) — 상태칸과 신원칸을 떨어뜨려 배치.
const HEADERS = ['번호', '참여자', '연락처', '수취인', '주소', '리뷰제출', '비고', '입금'];

async function run() {
  const SAVED = { wb: process.env.TRACK_B_WRITEBACK };

  // ═══ 1. 게이트: env 미설정 → 시트/DB 무접촉 ═══
  delete process.env.TRACK_B_WRITEBACK;
  let p = makePool({}); svc.__setPoolForTest(p);
  let r = await svc.executeWriteback({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.skipped, true); assert.equal(r.reason, 'gate_off', '1a: env off → gate_off');
  assert.equal(p.q.length, 0, '1a: gate off면 쿼리 0(완전 inert)');
  r = await svc.writebackSweep({});
  assert.equal(r.skipped, true, '1b: sweep도 gate_off');

  // ═══ 2. 이중게이트: cutover 아님(source_of_truth!=db) → skip ═══
  process.env.TRACK_B_WRITEBACK = '1';
  p = makePool({ sot: 'sheet' }); svc.__setPoolForTest(p);
  r = await svc.executeWriteback({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.reason, 'not_cutover', '2a: source_of_truth=sheet → not_cutover');
  assert.ok(!p.q.some(s => /FROM campaign_participants/.test(s)), '2a: cutover 아니면 로스터 미조회');

  // ═══ 3. cutover지만 미반영 편집 없음 → no_pending(시트 무접촉) ═══
  p = makePool({ sot: 'db', edits: [] }); svc.__setPoolForTest(p);
  r = await svc.executeWriteback({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.reason, 'no_pending', '3: 미반영 토글 없음 → no_pending');
  console.log('  1~3. 게이트(env·cutover·no_pending) — 무접촉 skip ✓');

  // ═══ 4. _buildToggleWrite 구조 안전(순수) — 상태칸 2열에만 쓰기 ═══
  // 4a: 빈칸 → 리뷰제출(F)·입금(H)에만 write, 연락처(C)/수취인(D) range 절대 없음.
  let w = svc._buildToggleWrite({ tabName: 'T', headers: HEADERS, submitCol: '리뷰제출', submitCol2: '입금',
    wantSubmitted: true, wantPaid: true, cells: ['', '', ''], minC: 5, sheetRow: 10 });
  assert.equal(w.writeData.length, 2, '4a: 빈칸 2개 → 2 write');
  for (const wd of w.writeData) {
    assert.ok(/!F10$|!H10$/.test(wd.range), `4a: range는 F(리뷰제출)/H(입금)만 — got ${wd.range}`);
    assert.ok(!/!C\d|!D\d/.test(wd.range), `4a: 연락처(C)/수취인(D) 절대 미접촉 — got ${wd.range}`);
  }
  assert.equal(w.conflict, false, '4a: 빈칸이면 conflict 없음');

  // 4b: blank-only — 사람이 채운 셀(≠want)은 안 씀 + conflict.
  w = svc._buildToggleWrite({ tabName: 'T', headers: HEADERS, submitCol: '리뷰제출', submitCol2: '입금',
    wantSubmitted: true, wantPaid: true, cells: ['보류', '', 'X'], minC: 5, sheetRow: 10 });
  // cells: idx5='보류'(리뷰제출, 사람값≠O), idx7='X'(입금, 사람값≠O) → 둘 다 conflict, write 0
  assert.equal(w.writeData.length, 0, '4b: 사람셀은 클로버 금지(write 0)');
  assert.equal(w.conflict, true, '4b: conflict 표기');

  // 4c: 멱등 no-op — 이미 O면 안 씀.
  w = svc._buildToggleWrite({ tabName: 'T', headers: HEADERS, submitCol: '리뷰제출', submitCol2: '입금',
    wantSubmitted: true, wantPaid: true, cells: ['O', '', '완료'], minC: 5, sheetRow: 10 });
  assert.equal(w.writeData.length, 0, '4c: 이미 반영(O/완료 동치) → no-op');
  assert.equal(w.conflict, false, '4c: 동치는 conflict 아님');

  // 4d: 해제(want=false)는 blank-only상 기존 O를 못 지움(conflict, un-write 불가).
  w = svc._buildToggleWrite({ tabName: 'T', headers: HEADERS, submitCol: '리뷰제출', submitCol2: '입금',
    wantSubmitted: false, wantPaid: null, cells: ['O', '', ''], minC: 5, sheetRow: 10 });
  assert.equal(w.writeData.length, 0, '4d: 해제는 시트에 안 씀');
  assert.equal(w.conflict, true, '4d: 기존 O 해제 시도 → conflict(보존)');
  console.log('  4. _buildToggleWrite — 상태칸 2열 전용·blank-only·멱등·un-write 금지 ✓');

  // ═══ 5. Track A 변이함수 미참조(구조 격리) ═══
  const src = svc.executeWriteback.toString() + svc.writebackSweep.toString() + svc._buildToggleWrite.toString();
  for (const banned of ['recordReviewIdentity', 'recordParticipationLink', 'claimRow', 'createOrderLedgerEntry', 'buildCandidateRows']) {
    assert.ok(!src.includes(banned), `5: write-back이 Track A 변이함수 '${banned}' 미참조(주문/신원 원장 무접촉)`);
  }
  console.log('  5. Track A 변이함수(claimRow/record*/원장) 미참조 — 주문·소유권키 무접촉 ✓');

  if (SAVED.wb === undefined) delete process.env.TRACK_B_WRITEBACK; else process.env.TRACK_B_WRITEBACK = SAVED.wb;
  console.log('✅ trackBWriteback 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
