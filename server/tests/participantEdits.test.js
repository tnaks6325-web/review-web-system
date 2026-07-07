/**
 * Track B 편집 오버레이 회귀가드 — read-time 합성 + 앵커 도출 + parity 편집분류.
 *   레드-블루-심판 최종본 검증: 오버레이-only(물리행 무편집)·정렬면역 앵커·bool FALSE 보존·
 *   ambiguous 게이트·orphan 노출·order>identity 우선·화이트리스트·동시편집 backstop.
 * 실행: node tests/participantEdits.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');

// db.query 기반(workdeskTab·parityReport) 목
function makeQueryPool(scn) {
  const q = [];
  return {
    q,
    async query(sql) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push(s);
      if (/FROM tab_configs/.test(s)) return { rows: scn.meta || [] };
      if (/FROM work_orders/.test(s)) return { rows: scn.wo || [] };
      if (/FROM advertiser_campaigns ac JOIN advertisers a/.test(s)) return { rows: scn.staffScope || [] };  // scopedTabsForStaff
      if (/tab_gid FROM raw_sheet_tabs WHERE sheet_id=\$1 AND tab_name=\$2/.test(s)) {
        if (Array.isArray(scn.tabGidRows)) return { rows: scn.tabGidRows.map(g => ({ tab_gid: g })) };  // 동명탭(여러 gid)
        return { rows: scn.tabGidRow ? [{ tab_gid: scn.tabGidRow }] : [] };
      }
      if (/FROM participant_edits/.test(s)) return { rows: scn.edits || [] };
      if (/reviewer_name AS name.*FROM campaign_participants.*ORDER BY seq/.test(s)) return { rows: scn.roster || [] };
      return { rows: [] };
    },
  };
}

// db.connect 기반(editWorkdeskRow) 목 — client.query 매칭
function makeConnectPool(scn) {
  const q = [];
  const client = {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/^BEGIN|^ROLLBACK|^COMMIT/.test(s)) return { rows: [] };
      if (/FROM campaign_participants WHERE id=\$1 .* FOR UPDATE/.test(s)) return { rows: scn.row ? [scn.row] : [] };
      if (/UPDATE campaign_participants SET identity_key/.test(s)) return { rows: [] };
      if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(s)) return { rows: [{ n: scn.dupCount || 1 }] };
      if (/FROM raw_sheet_tabs/.test(s)) return { rows: scn.detectedHeaders ? [{ detected_headers: scn.detectedHeaders }] : [] };
      if (/UPDATE participant_edits SET reverted_at/.test(s)) return { rows: [], rowCount: (scn.revertN == null ? 1 : scn.revertN) };
      if (/INSERT INTO participant_edits/.test(s)) {
        if (scn.insertThrows) { const e = new Error('dup'); e.code = '23505'; throw e; }
        scn._ins = params;   // 마지막 insert 파라미터 캡처(검증용)
        return { rows: [{ id: 42 }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return { q, client, async connect() { return client; } };
}

async function run() {
  // ═══ 1. workdeskTab read-time 합성 ═══
  const pool = makeQueryPool({
    meta: [{ campaignName: 'C' }],
    roster: [
      // order 앵커. 물리 submitted=true 인데 편집 is_submitted=false 로 덮음(FALSE 폴스루 방지)
      { id: 'r1', seq: 1, name: 'A', recipient: null, phone8: '11112222', round: '1', option: 'o', product: 'p', submitted: true, paid: false, source: 'import', order_submission_id: 'ord-1', identity_key: 'num:100000', row_json: {} },
      // identity 앵커(유일). 편집 reviewer_name='편집B'
      { id: 'r2', seq: 2, name: 'B', recipient: null, phone8: '33334444', round: '1', option: '', product: '', submitted: false, paid: false, source: 'import', order_submission_id: null, identity_key: 'phone8:33334444', row_json: {} },
      // identity 중복(2행) → ambiguous, 편집 미적용
      { id: 'r3', seq: 3, name: 'C1', recipient: null, phone8: '55556666', round: '1', option: '', product: '', submitted: false, paid: false, source: 'import', order_submission_id: null, identity_key: 'phone8:55556666', row_json: {} },
      { id: 'r4', seq: 4, name: 'C2', recipient: null, phone8: '55556666', round: '2', option: '', product: '', submitted: false, paid: false, source: 'import', order_submission_id: null, identity_key: 'phone8:55556666', row_json: {} },
      // order 앵커 + _hidden 편집 → 목록서 제외
      { id: 'r5', seq: 5, name: 'H', recipient: null, phone8: '77778888', round: '1', option: '', product: '', submitted: false, paid: false, source: 'import', order_submission_id: 'ord-5', identity_key: 'num:500000', row_json: {} },
    ],
    edits: [
      { anchor_type: 'order', anchor_value: 'ord-1', field: 'is_submitted', kind: 'bool', value_bool: false, value_text: null },
      { anchor_type: 'identity', anchor_value: 'phone8:33334444', field: 'reviewer_name', kind: 'text', value_bool: null, value_text: '편집B' },
      { anchor_type: 'identity', anchor_value: 'phone8:55556666', field: 'reviewer_name', kind: 'text', value_bool: null, value_text: '무시됨(ambiguous)' },
      { anchor_type: 'order', anchor_value: 'ord-5', field: '_hidden', kind: 'bool', value_bool: true, value_text: null },
      // 앵커가 어떤 활성행에도 안 붙음 → orphan
      { anchor_type: 'identity', anchor_value: 'phone8:99999999', field: 'round', kind: 'text', value_bool: null, value_text: 'X' },
    ],
  });
  svc.__setPoolForTest(pool);
  const wd = await svc.workdeskTab({ sheetId: 's', tabName: 'T', role: 'master' });
  const byId = Object.fromEntries(wd.roster.map(r => [r.id, r]));
  assert.equal(byId.r1.submitted, false, '1a: bool FALSE 편집이 물리 true 를 덮음(폴스루 아님)');
  assert.equal(byId.r2.name, '편집B', '1b: text 편집 합성');
  assert.ok(byId.r3.ambiguous === true && byId.r3.editable === false, '1c: 중복 identity → ambiguous·편집잠금');
  assert.equal(byId.r3.name, 'C1', '1d: ambiguous 행은 편집 미적용(물리값 유지)');
  assert.ok(!byId.r5, '1e: _hidden 편집 행은 로스터 제외');
  assert.equal(wd.hiddenRows.length, 1, '1f: 숨김 행은 hiddenRows 로 노출');
  assert.equal(wd.orphanEdits.count, 1, '1g: 미부착 편집은 orphan 카운트');
  assert.equal(wd.orphanEdits.byType.identity, 1, '1h: orphan 타입별 집계');
  assert.equal(wd.counts.ambiguous, 2, '1i: ambiguous 카운트(중복 identity 2행 각각)');
  console.log('  1. workdeskTab 합성 — FALSE보존·text·ambiguous·hidden·orphan ✓');

  // ═══ 2. 광고주 렌즈: 스코프 밖 거부 + PII 마스킹 + 편집메타 미노출 ═══
  const pool2 = makeQueryPool({ meta: [], roster: [
    { id: 'r1', seq: 1, name: 'A', recipient: null, phone8: '11112222', round: '1', option: '', product: '', submitted: false, paid: false, source: 'import', order_submission_id: null, identity_key: 'phone8:11112222', row_json: {} },
  ], edits: [] });
  // scopedTabsForAdvertiser 는 별도 query — 소유로 통과시키기 위해 목 확장
  pool2.query = (function (orig) {
    return async function (sql) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM advertiser_campaigns WHERE advertiser_id/.test(s)) return { rows: [{ sheetId: 's', tabGid: null }] };
      return orig(sql);
    };
  })(pool2.query);
  svc.__setPoolForTest(pool2);
  const wda = await svc.workdeskTab({ sheetId: 's', tabName: 'T', role: 'advertiser', advertiserId: 'adv_1' });
  assert.equal(wda.maskPII, true, '2a: 광고주 마스킹 on');
  assert.ok(/••••/.test(wda.roster[0].phone8), '2b: phone8 마스킹');
  assert.equal(wda.roster[0].editedFields, undefined, '2c: 광고주엔 편집메타 미노출');
  assert.equal(wda.orphanEdits, undefined, '2d: 광고주엔 orphan 미노출');
  const wdDenied = await svc.workdeskTab({ sheetId: 'other', tabName: 'T', role: 'advertiser', advertiserId: 'adv_1' });
  assert.ok(wdDenied.denied === true, '2e: 소유 스코프 밖 거부');
  console.log('  2. 광고주 렌즈 — 스코프·마스킹·편집메타 은닉 ✓');

  // ═══ 3. editWorkdeskRow 앵커 도출 + 거부 ═══
  // 3a: order 우선
  let cp = makeConnectPool({ row: { id: 'r1', source: 'import', order_submission_id: 'ord-1', identity_key: 'phone8:1', phone8: '1', recipient_name: null, option_text: null, row_json: {} } });
  svc.__setPoolForTest(cp);
  let e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'is_paid', value: true });
  assert.ok(e.ok && e.anchorType === 'order', '3a: order_submission_id 있으면 order 앵커');
  const ins = cp.q.find(x => /INSERT INTO participant_edits/.test(x.s));
  assert.ok(ins && ins.params.includes('ord-1'), '3a2: 오버레이가 order 앵커값 저장');
  // 3b: manual 앵커
  cp = makeConnectPool({ row: { id: 'm9', source: 'manual', order_submission_id: null, identity_key: null, phone8: '2', recipient_name: null, option_text: null, row_json: {} } });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'm9', field: 'round', value: '3' });
  assert.ok(e.ok && e.anchorType === 'manual', '3b: manual 행은 manual 앵커(물리행 id)');
  // 3c: identity 유일
  cp = makeConnectPool({ row: { id: 'r2', source: 'import', order_submission_id: null, identity_key: 'phone8:33334444', phone8: '33334444', recipient_name: null, option_text: null, row_json: {} }, dupCount: 1 });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r2', field: 'reviewer_name', value: 'X' });
  assert.ok(e.ok && e.anchorType === 'identity', '3c: identity 유일 → identity 앵커');
  // 3d: identity 중복 → 거부
  cp = makeConnectPool({ row: { id: 'r3', source: 'import', order_submission_id: null, identity_key: 'phone8:55556666', phone8: '55556666', recipient_name: null, option_text: null, row_json: {} }, dupCount: 2 });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r3', field: 'round', value: '9' });
  assert.ok(!e.ok && e.error === 'ambiguous_identity', '3d: 중복 identity 편집 거부');
  // 3e: 앵커 전무 → 거부
  cp = makeConnectPool({ row: { id: 'r6', source: 'import', order_submission_id: null, identity_key: null, phone8: '', recipient_name: null, option_text: null, row_json: {} } });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r6', field: 'round', value: '9' });
  assert.ok(!e.ok && e.error === 'no_stable_anchor', '3e: 안정 앵커 없으면 거부');
  // 3f: 화이트리스트 밖 field 거부(row 조회 전)
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'sheet_id', value: 'evil' });
  assert.ok(!e.ok && e.error === 'field_not_editable', '3f: 화이트리스트 외 field 거부');
  // 3g: row 스코프 밖(조회 0) 거부
  cp = makeConnectPool({ row: null });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'nope', field: 'round', value: '1' });
  assert.ok(!e.ok && e.error === 'row_not_found', '3g: rowId 스코프 밖 거부');
  // 3h: bool 값은 value_bool 로 저장(캐스팅 예외 차단)
  cp = makeConnectPool({ row: { id: 'r1', source: 'import', order_submission_id: 'ord-1', identity_key: null, phone8: '1', recipient_name: null, option_text: null, row_json: {} } });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'is_submitted', value: 'true' });
  const ins2 = cp.q.find(x => /INSERT INTO participant_edits/.test(x.s));
  // params: [sheet,tab,type,val,field,kind,value_bool,value_text,by]
  assert.equal(ins2.params[5], 'bool', '3h: kind=bool');
  assert.equal(ins2.params[6], true, '3h2: value_bool=true');
  assert.equal(ins2.params[7], null, '3h3: value_text=null');
  // 3i: 23505 → concurrent_edit_conflict
  cp = makeConnectPool({ row: { id: 'r1', source: 'import', order_submission_id: 'ord-1', identity_key: null, phone8: '1', recipient_name: null, option_text: null, row_json: {} }, insertThrows: true });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'round', value: '1' });
  assert.ok(!e.ok && e.error === 'concurrent_edit_conflict', '3i: 부분유니크 위반 → concurrent_edit_conflict');
  assert.ok(cp.q.some(x => /^ROLLBACK/.test(x.s)), '3i2: 실패 시 ROLLBACK');
  // 3j: col:<헤더> — detected_headers 에 실재하면 text 오버레이로 수락
  cp = makeConnectPool({ row: { id: 'r1', source: 'manual', order_submission_id: null, identity_key: null, phone8: '1', recipient_name: null, option_text: null, row_json: {}, tab_gid: '9' }, detectedHeaders: ['번호', '주소', '수취인'] });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'col:주소', value: '서울 …', by: 'm' });
  assert.ok(e.ok && e.anchorType === 'manual' && e.field === 'col:주소', '3j: 실재 시트컬럼 col: 수락');
  const insC = cp.q.find(x => /INSERT INTO participant_edits/.test(x.s));
  assert.equal(insC.params[4], 'col:주소', '3j2: field=col:주소 저장'); assert.equal(insC.params[5], 'text', '3j3: kind=text');
  // 3k: col:<헤더> — detected_headers 에도 없고 row_json 키에도 없으면 거부
  cp = makeConnectPool({ row: { id: 'r1', source: 'manual', order_submission_id: null, identity_key: null, phone8: '1', recipient_name: null, option_text: null, row_json: { 번호: '1' }, tab_gid: '9' }, detectedHeaders: ['번호', '주소'] });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'col:없는컬럼', value: 'x' });
  assert.ok(!e.ok && e.error === 'field_not_editable', '3k: 미실재 col: 컬럼 거부');
  assert.ok(cp.q.some(x => /^ROLLBACK/.test(x.s)), '3k2: 거부 시 ROLLBACK');
  // 3l: detected_headers NULL 이어도 그 행 row_json 키에 있으면 수락(그리드 폴백 정합)
  cp = makeConnectPool({ row: { id: 'r1', source: 'manual', order_submission_id: null, identity_key: null, phone8: '1', recipient_name: null, option_text: null, row_json: { 비고: '메모' }, tab_gid: '9' } });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'col:비고', value: 'y' });
  assert.ok(e.ok && e.field === 'col:비고', '3l: detected_headers NULL → row_json 키 폴백 수락');
  // 3m: col:리뷰제출 편집 → 물리 is_submitted 토글도 함께 기록(카운트 연동)
  cp = makeConnectPool({ row: { id: 'r1', source: 'manual', order_submission_id: null, identity_key: null, phone8: '1', recipient_name: null, option_text: null, row_json: {}, tab_gid: '9' }, detectedHeaders: ['리뷰제출', '입금'] });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'col:리뷰제출', value: '6/20', by: 'm' });
  assert.ok(e.ok && e.linkedField === 'is_submitted', '3m: col:리뷰제출 → linkedField=is_submitted');
  const insList = cp.q.filter(x => /INSERT INTO participant_edits/.test(x.s));
  assert.equal(insList.length, 2, '3m2: 오버레이 2건(col:리뷰제출 + is_submitted)');
  const boolIns = insList.find(x => x.params[4] === 'is_submitted');   // 링크 insert 파라미터: [sheet,tab,type,val,field,value_bool,by]
  assert.ok(boolIns && boolIns.params[5] === true, '3m3: is_submitted value_bool=true(값 있음)');
  // 3n: col:입금자명(정보열)은 링크 토글 안 함 — is_paid 오탐 차단(리뷰 지적 #1)
  cp = makeConnectPool({ row: { id: 'r1', source: 'manual', order_submission_id: null, identity_key: null, phone8: '1', recipient_name: null, option_text: null, row_json: {}, tab_gid: '9' }, detectedHeaders: ['입금자명', '입금'] });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'col:입금자명', value: '김철수', by: 'm' });
  assert.ok(e.ok && e.linkedField == null, '3n: 입금자명은 상태 토글 연동 안 함');
  assert.equal(cp.q.filter(x => /INSERT INTO participant_edits/.test(x.s)).length, 1, '3n2: 오버레이 1건(연동 없음)');
  console.log('  3. editWorkdeskRow — 앵커·거부·bool분리·레이스 + col:검증 + 카운트연동(오탐차단) ✓');

  // ═══ 5. revertWorkdeskEdit 연동 되돌리기 — primary 실제 revert 시에만 연쇄(리뷰 지적 #2) ═══
  const rrow = { id: 'r1', source: 'manual', order_submission_id: null, identity_key: null, phone8: '1', recipient_name: null, option_text: null, row_json: {} };
  // 5a: col:리뷰제출 revert 되고(revertN=1) → is_submitted 도 함께 revert(2회)
  cp = makeConnectPool({ row: rrow, revertN: 1 }); svc.__setPoolForTest(cp);
  await svc.revertWorkdeskEdit({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'col:리뷰제출', by: 'm' });
  assert.equal(cp.q.filter(x => /UPDATE participant_edits SET reverted_at/.test(x.s)).length, 2, '5a: primary 되돌림 시 링크 토글도 되돌림(2회)');
  // 5b: col:리뷰제출 활성 편집 없음(revertN=0) → 링크 토글 건드리지 않음(1회) — 독립 토글 보호
  cp = makeConnectPool({ row: rrow, revertN: 0 }); svc.__setPoolForTest(cp);
  await svc.revertWorkdeskEdit({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'col:리뷰제출', by: 'm' });
  assert.equal(cp.q.filter(x => /UPDATE participant_edits SET reverted_at/.test(x.s)).length, 1, '5b: primary 미되돌림 시 링크 미연쇄(독립 토글 보호)');
  console.log('  5. revertWorkdeskEdit — 연동 되돌리기 provenance 게이트 ✓');

  // ═══ 4. classifyParity editedKeys → BD-8 benign(하위호환 기본 Set) ═══
  const A = [{ phone8: '11112222', name: 'A', submitted: false, paid: false, round: '1' }];
  const B = [{ phone8: '11112222', name: 'A', submitted: true, paid: false, round: '1', source: 'import' }];
  const noEdit = svc.classifyParity(A, B);
  assert.equal(noEdit.buckets.real, 1, '4a: 편집셋 없으면 상태차 = real');
  const edited = svc.classifyParity(A, B, new Set(['11112222']));
  assert.equal(edited.buckets.real, 0, '4b: 편집 phone8 은 real 아님');
  assert.equal(edited.buckets.benign, 1, '4c: 편집 상태차 = benign(BD-8)');
  // B-only 편집분도 benign
  const bOnly = svc.classifyParity([], [{ phone8: '99998888', name: 'Z', submitted: true, paid: false, round: '1', source: 'import' }], new Set(['99998888']));
  assert.equal(bOnly.buckets.benign, 1, '4d: B-only 편집분 = benign');
  assert.equal(bOnly.buckets.real, 0, '4e: B-only 편집분 real 아님');
  console.log('  4. classifyParity editedKeys — BD-8 benign·하위호환 ✓');

  // ═══ 6. AE(staff) 스코프 — 담당 탭만 접근(교차 차단) ═══
  let p6 = makeQueryPool({ staffScope: [{ sheetId: 'S1', tabGid: null }] }); svc.__setPoolForTest(p6);
  assert.equal(await svc.canAccessTab({ role: 'staff', staffName: '김수만', sheetId: 'S1', tabName: 'T' }), true, '6a: 시트 전체 소유 → 접근 허용');
  assert.equal(await svc.canAccessTab({ role: 'staff', staffName: '김수만', sheetId: 'OTHER', tabName: 'T' }), false, '6a2: 소유 밖 시트 → 차단');
  p6 = makeQueryPool({ staffScope: [{ sheetId: 'S1', tabGid: '99' }], tabGidRow: '99' }); svc.__setPoolForTest(p6);
  assert.equal(await svc.canAccessTab({ role: 'staff', staffName: '김수만', sheetId: 'S1', tabName: 'T' }), true, '6b: 담당 탭(gid 일치) → 허용');
  p6 = makeQueryPool({ staffScope: [{ sheetId: 'S1', tabGid: '99' }], tabGidRow: '77' }); svc.__setPoolForTest(p6);
  assert.equal(await svc.canAccessTab({ role: 'staff', staffName: '김수만', sheetId: 'S1', tabName: 'T' }), false, '6c: 다른 탭(gid 불일치) → 차단');
  p6 = makeQueryPool({ staffScope: [] }); svc.__setPoolForTest(p6);
  assert.equal(await svc.canAccessTab({ role: 'staff', staffName: '무담당', sheetId: 'S1', tabName: 'T' }), false, '6d: 담당 업체 없음 → 차단');
  assert.equal(await svc.canAccessTab({ role: 'master', sheetId: 'X', tabName: 'Y' }), true, '6e: master 전체 허용(스코프 무관)');
  // 6f: 동명탭(같은 tab_name 여러 gid) — 소유 gid가 하나라도 있으면 결정적으로 허용(LIMIT 1 비결정 제거)
  p6 = makeQueryPool({ staffScope: [{ sheetId: 'S1', tabGid: '99' }], tabGidRows: ['77', '99'] }); svc.__setPoolForTest(p6);
  assert.equal(await svc.canAccessTab({ role: 'staff', staffName: '김수만', sheetId: 'S1', tabName: 'T' }), true, '6f: 동명탭 중 소유 gid 존재 → 허용(결정적)');
  p6 = makeQueryPool({ staffScope: [{ sheetId: 'S1', tabGid: '99' }], tabGidRows: ['77', '88'] }); svc.__setPoolForTest(p6);
  assert.equal(await svc.canAccessTab({ role: 'staff', staffName: '김수만', sheetId: 'S1', tabName: 'T' }), false, '6f2: 동명탭 전부 미소유 → 차단');
  console.log('  6. AE(staff) 스코프 — canAccessTab 담당/차단(교차 접근 차단) ✓');

  console.log('✅ participantEdits 테스트 전체 통과');
}

run().then(() => process.exit(0)).catch(e => { console.error('❌', e.message, '\n', e.stack); process.exit(1); });
