/**
 * Track B P2/P2-2 통합 write-back 엔진 회귀가드 — 심판 확정(경로 정합).
 *   ★ Track A 리스크 0 증명: (1) 게이트(env·cutover) 없으면 시트/DB 무접촉, (2) _buildToggleWrite가
 *     submit_col/submit_col2 두 열에만 range 생성, (3) blank-only·멱등 no-op·un-write 금지,
 *     (4) 엔진이 Track A 변이함수·rowIdentityMatches(전체 digits equality 잠복버그) 미참조,
 *     (5) _wbIdentityOk = 전화 끝8자리 fail-closed, (6) _wbOrderMappedMask = 주문매핑칸 disjoint 자동 차단,
 *     (7) status 어휘 {written,held,blocked} 고정 + base/full 픽업 SQL 술어(_hidden/소유권키 제외).
 * 실행: node tests/trackBWriteback.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');
const ol = require('../src/services/orderLedger.service');

function makePool(scn = {}) {
  const q = [];
  return {
    q,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push({ s, params: params || [] });
      if (/source_of_truth AS "sourceOfTruth" FROM tab_configs/.test(s)) return { rows: scn.sot ? [{ sourceOfTruth: scn.sot }] : [] };
      if (/FROM participant_edits/.test(s) && /reverted_at IS NULL/.test(s) && !/UPDATE/.test(s)) return { rows: scn.edits || [] };
      if (/FROM campaign_participants/.test(s)) return { rows: scn.roster || [] };
      if (/UPDATE participant_edits SET writeback_status/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  };
}
// orderLedger.loadRawTabContext 용 — raw_sheet_tabs 미러 메타 반환.
function olPool(headers) {
  return { async query(sql) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/FROM raw_sheet_tabs/.test(s)) return { rows: [{ sheet_id: 'S1', tab_gid: '11', tab_name: 'T', detected_headers: headers, header_row_index: 1, data_start_row: 2, _dup: 1 }] };
    return { rows: [] };
  } };
}

// 시트 헤더: 연락처(C, idx2)·수취인(D, idx3)·리뷰제출(F, idx5)·입금(H, idx7) — 상태칸과 신원칸을 떨어뜨려 배치.
const HEADERS = ['번호', '참여자', '연락처', '수취인', '주소', '리뷰제출', '비고', '입금'];

async function run() {
  const SAVED = { wb: process.env.TRACK_B_WRITEBACK, full: process.env.TRACK_B_WRITEBACK_FULL };

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
  assert.ok(!p.q.some(x => /FROM campaign_participants/.test(x.s)), '2a: cutover 아니면 로스터 미조회');

  // ═══ 3. no_pending + base 픽업 술어 고정(R2/R3) ═══
  p = makePool({ sot: 'db', edits: [] }); svc.__setPoolForTest(p);
  r = await svc.executeWriteback({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.reason, 'no_pending', '3: 미반영 토글 없음 → no_pending');
  const pickup = p.q.find(x => /FROM participant_edits/.test(x.s));
  assert.ok(/field IN \('is_submitted','is_paid'\)/.test(pickup.s), '3b: base 픽업=토글만(_hidden 원천 제외)');
  assert.ok(/writeback_status IS NULL OR writeback_status='blocked'/.test(pickup.s), '3c: 미반영|blocked만 재픽업');
  assert.ok(/reverted_at IS NULL/.test(pickup.s), '3d: 되돌린 편집 제외');
  console.log('  1~3. 게이트(env·cutover·no_pending) + base 픽업 술어 ✓');

  // ═══ 4. _buildToggleWrite 구조 안전(순수) — 상태칸 2열에만 쓰기 ═══
  let w = svc._buildToggleWrite({ tabName: 'T', headers: HEADERS, submitCol: '리뷰제출', submitCol2: '입금',
    wantSubmitted: true, wantPaid: true, cells: ['', '', ''], minC: 5, sheetRow: 10 });
  assert.equal(w.writeData.length, 2, '4a: 빈칸 2개 → 2 write');
  for (const wd of w.writeData) {
    assert.ok(/!F10$|!H10$/.test(wd.range), `4a: range는 F(리뷰제출)/H(입금)만 — got ${wd.range}`);
    assert.ok(!/!C\d|!D\d/.test(wd.range), `4a: 연락처(C)/수취인(D) 절대 미접촉 — got ${wd.range}`);
  }
  assert.equal(w.conflict, false, '4a: 빈칸이면 conflict 없음');

  w = svc._buildToggleWrite({ tabName: 'T', headers: HEADERS, submitCol: '리뷰제출', submitCol2: '입금',
    wantSubmitted: true, wantPaid: true, cells: ['보류', '', 'X'], minC: 5, sheetRow: 10 });
  assert.equal(w.writeData.length, 0, '4b: 사람셀은 클로버 금지(write 0)');
  assert.equal(w.conflict, true, '4b: conflict 표기');

  w = svc._buildToggleWrite({ tabName: 'T', headers: HEADERS, submitCol: '리뷰제출', submitCol2: '입금',
    wantSubmitted: true, wantPaid: true, cells: ['O', '', '완료'], minC: 5, sheetRow: 10 });
  assert.equal(w.writeData.length, 0, '4c: 이미 반영(O/완료 동치) → no-op');
  assert.equal(w.conflict, false, '4c: 동치는 conflict 아님');

  w = svc._buildToggleWrite({ tabName: 'T', headers: HEADERS, submitCol: '리뷰제출', submitCol2: '입금',
    wantSubmitted: false, wantPaid: null, cells: ['O', '', ''], minC: 5, sheetRow: 10 });
  assert.equal(w.writeData.length, 0, '4d: 해제는 시트에 안 씀');
  assert.equal(w.conflict, true, '4d: 기존 O 해제 시도 → conflict(보존·un-write 불가)');
  console.log('  4. _buildToggleWrite — 상태칸 2열 전용·blank-only·멱등·un-write 금지 ✓');

  // ═══ 5. Track A 변이함수 + rowIdentityMatches(잠복버그 함수) 미참조 — 통합엔진 전체 소스 스캔 ═══
  const src = [svc.executeWriteback, svc.writebackSweep, svc.applyWritebackFull, svc.simulateWriteback,
    svc._writebackEngine, svc._computeWritebackPlan, svc._buildToggleWrite].map(f => f.toString()).join('\n');
  for (const banned of ['recordReviewIdentity', 'recordParticipationLink', 'claimRow', 'createOrderLedgerEntry', 'buildCandidateRows', 'rowIdentityMatches']) {
    assert.ok(!src.includes(banned), `5: write-back이 '${banned}' 미참조(주문/신원 원장 무접촉 + digits 전체비교 잠복버그 봉인)`);
  }
  console.log('  5. Track A 변이함수·rowIdentityMatches 미참조 ✓');

  // ═══ 6. _wbIdentityOk — 전화 끝8자리(잠복버그 수정 고정) + fail-closed ═══
  const okArgs = { cells: ['010-1234-5678', '김철수'], minC: 2, phoneCol: 2, recipCol: 3, phone8: '12345678', recipient: '김철수' };
  assert.equal(svc._wbIdentityOk(okArgs), true, '6a: 시트 전체번호 vs DB 끝8자리 → 일치(구현이 전체 equality면 여기서 실패)');
  assert.equal(svc._wbIdentityOk({ ...okArgs, phone8: '99998888' }), false, '6b: 전화 불일치 → 거부');
  assert.equal(svc._wbIdentityOk({ ...okArgs, cells: ['', '김철수'] }), false, '6c: 시트 전화 공란 → fail-closed');
  assert.equal(svc._wbIdentityOk({ ...okArgs, cells: ['010-1234-5678', '양미경'] }), false, '6d: 수취인 불일치(AND)');
  assert.equal(svc._wbIdentityOk({ cells: [], minC: 0, phoneCol: -1, recipCol: -1, phone8: '12345678', recipient: '김' }), false, '6e: 비교 불가 → fail-closed');
  console.log('  6. _wbIdentityOk — 끝8자리 비교·AND·fail-closed ✓');

  // ═══ 7. _wbOrderMappedMask — 주문매핑칸 자동 식별(컬럼 disjoint 근거) ═══
  const mask = svc._wbOrderMappedMask(HEADERS);
  assert.deepEqual(HEADERS.filter((h, i) => mask[i]), ['연락처', '수취인', '주소', '비고'],
    '7a: 주문매핑칸 = 연락처·수취인·주소·비고(빈 orderData에도 non-null 반환 검증)');
  assert.ok(!mask[HEADERS.indexOf('리뷰제출')] && !mask[HEADERS.indexOf('입금')], '7b: 상태 토글칸은 비매핑(쓰기 허용)');
  console.log('  7. _wbOrderMappedMask — 주문매핑칸 disjoint 자동 유도 ✓');

  // ═══ 8. base 엔진 사전가드 마킹(시트 무접촉 경로): 주문매핑 토글칸→held · 앵커없음→blocked · 어휘 고정 ═══
  const H8 = ['번호', '참여자', '연락처', '수취인', '리뷰제출', '입금일자'];
  const roster8 = [{ id: 'r1', seq: 1, reviewer_name: '홍', recipient_name: '김', phone8: '11112222', round: '', option_text: '',
    product_name: '', sheet_row: 10, tab_gid: '11', submit_col: '리뷰제출', submit_col2: '입금일자', source: 'import',
    order_submission_id: 'o1', identity_key: 'phone8:11112222', deleted_at: null, active: true }];
  const edits8 = [
    { id: 'e1', anchor_type: 'order', anchor_value: 'o1', field: 'is_paid', kind: 'bool', value_bool: true, value_text: null },
    { id: 'e2', anchor_type: 'order', anchor_value: 'zzz', field: 'is_submitted', kind: 'bool', value_bool: true, value_text: null },
  ];
  p = makePool({ sot: 'db', edits: edits8, roster: roster8 }); svc.__setPoolForTest(p);
  ol.__setPoolForTest(olPool(H8));
  r = await svc.executeWriteback({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.held, 1, '8a: 입금일자(주문매핑 일자칸) 토글 → held(disjoint 차단·비재시도)');
  assert.equal(r.blocked, 1, '8b: 앵커없음 → blocked(자가치유 재시도)');
  assert.equal(r.written, 0, '8c: 시트 무접촉(write 0)');
  const marks = p.q.filter(x => /UPDATE participant_edits SET writeback_status/.test(x.s));
  assert.ok(marks.length >= 2 && marks.every(m => ['written', 'held', 'blocked'].includes(m.params[1])),
    '8d: status 어휘 {written,held,blocked} 밖 기록 없음(R3)');
  ol.__setPoolForTest(null);
  console.log('  8. base 엔진 — 주문매핑 토글칸 held·앵커없음 blocked·어휘 고정 ✓');

  // ═══ 9. full 픽업 SQL 술어(R2/R9) + add/clear 는 시뮬 전용(editId 없음 → 실행·마킹 금지, R11) ═══
  process.env.TRACK_B_WRITEBACK_FULL = '1';
  p = makePool({ sot: 'db', edits: [], roster: [] }); svc.__setPoolForTest(p);
  r = await svc.applyWritebackFull({ sheetId: 'S1', tabName: 'T' });
  assert.equal(r.reason, 'no_pending', '9a: full 미반영 없음 → no_pending');
  const fp = p.q.find(x => /FROM participant_edits/.test(x.s));
  assert.ok(/field <> '_hidden'/.test(fp.s), '9b: full 픽업에서 _hidden SQL 제외(영구 재픽업 원천 차단)');
  assert.ok(/NOT IN \('phone8','recipient_name'\)/.test(fp.s), '9c: 소유권키 필드 SQL 제외(실행·오마킹 자체 없음)');
  assert.ok(/writeback_status IS NULL OR writeback_status='blocked'/.test(fp.s), '9d: full도 미반영|blocked만');
  // 플랜 scope 검증: manual add 는 scope='all'(시뮬)에만 생성되고 editId 가 없다.
  const manualRoster = [{ id: 'm1', seq: 2, reviewer_name: '추가행', recipient_name: '', phone8: null, round: '', option_text: '',
    product_name: '', sheet_row: null, tab_gid: null, submit_col: null, submit_col2: null, source: 'manual',
    order_submission_id: null, identity_key: null, deleted_at: null, active: true }];
  const dbAll = makePool({ edits: [], roster: manualRoster }); ol.__setPoolForTest(olPool(H8));
  const planAll = await svc._computeWritebackPlan(dbAll, 'S1', 'T', { scope: 'all' });
  const addOps = planAll.ops.filter(o => o.type === 'add');
  assert.equal(addOps.length, 1, '9e: 시뮬 플랜엔 manual add 노출');
  assert.ok(!addOps[0].editId, '9f: add op는 editId 없음(엔진 마킹·실행 구조적 불가)');
  const dbFull = makePool({ edits: [], roster: manualRoster });
  const planFull = await svc._computeWritebackPlan(dbFull, 'S1', 'T', { scope: 'full' });
  assert.equal(planFull.noPending, true, '9g: full 플랜은 add/clear 미생성(편집 없으면 no_pending)');
  ol.__setPoolForTest(null);
  console.log('  9. full 픽업 술어 + add/clear 시뮬 전용(R11) ✓');

  svc.__setPoolForTest(null);
  if (SAVED.wb === undefined) delete process.env.TRACK_B_WRITEBACK; else process.env.TRACK_B_WRITEBACK = SAVED.wb;
  if (SAVED.full === undefined) delete process.env.TRACK_B_WRITEBACK_FULL; else process.env.TRACK_B_WRITEBACK_FULL = SAVED.full;
  console.log('✅ trackBWriteback 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
