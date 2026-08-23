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
      /* ★★ 폐기된 '_hidden'(행 숨김) 레코드가 남아 있어도 **행을 감추지 않는다**(사용자 확정 2026-08-23).
         화면에서만 줄을 빼면 표의 줄 수와 진행 현황·마감자료가 다른 사실을 말한다(참여자 85명 → 게이지 82). */
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
  assert.ok(byId.r5, '1e: 옛 _hidden 레코드가 있어도 행은 로스터에 남는다(숨김 기능 폐기)');
  assert.ok(!(byId.r5.editedFields || []).includes('_hidden'), '1e2: 폐기 필드는 편집 배지로 세지 않는다');
  assert.ok(!('hiddenRows' in wd), '1f: hiddenRows 응답 자체가 없다(창구 제거)');
  assert.ok(!('hidden' in wd.counts), '1f2: counts.hidden 도 없다');
  assert.equal(wd.orphanEdits.count, 1, '1g: 미부착 편집은 orphan 카운트');
  assert.equal(wd.orphanEdits.byType.identity, 1, '1h: orphan 타입별 집계');
  assert.equal(wd.counts.ambiguous, 2, '1i: ambiguous 카운트(중복 identity 2행 각각)');
  console.log('  1. workdeskTab 합성 — FALSE보존·text·ambiguous·hidden·orphan ✓');
  /* ═══ 1B. order 앵커 중복 게이트 (2026-08-19 실사고) ═══
     `order_submission_id` 는 유니크가 아니다. 같은 주문이 여러 줄로 복제된 탭에서 종전엔
     order 앵커에 게이트가 없어 입금칸 수기 표기 1건이 **중복 줄 전부에 번져** 리뷰 미작성 줄에
     입금일이 보이고 `counts.paid`(입금완료)가 부풀었다. → 어느 줄인지 모르면 어느 줄에도 적용 금지. */
  const dupPool = makeQueryPool({
    meta: [{ campaignName: 'C' }],
    roster: [
      { id: 'd1', seq: 179, name: '박', recipient: null, phone8: '11112222', round: '', option: '', product: '', submitted: true,  paid: false, source: 'import', order_submission_id: 'os-dup', identity_key: 'num:20260818147149', row_json: {} },
      { id: 'd2', seq: 189, name: '박', recipient: null, phone8: '11112222', round: '', option: '', product: '', submitted: false, paid: false, source: 'import', order_submission_id: 'os-dup', identity_key: 'num:20260818147149', row_json: {} },
      { id: 'd3', seq: 199, name: '박', recipient: null, phone8: '11112222', round: '', option: '', product: '', submitted: false, paid: false, source: 'import', order_submission_id: 'os-dup', identity_key: 'num:20260818147149', row_json: {} },
      // 정상(유일 order 앵커) — 무회귀 확인용
      { id: 'd9', seq: 9, name: '김', recipient: null, phone8: '33334444', round: '', option: '', product: '', submitted: true, paid: false, source: 'import', order_submission_id: 'os-one', identity_key: 'num:1', row_json: {} },
    ],
    edits: [
      { anchor_type: 'order', anchor_value: 'os-dup', field: 'is_paid', kind: 'bool', value_bool: true, value_text: null },
      { anchor_type: 'order', anchor_value: 'os-one', field: 'is_paid', kind: 'bool', value_bool: true, value_text: null },
    ],
  });
  svc.__setPoolForTest(dupPool);
  const wdDup = await svc.workdeskTab({ sheetId: 's', tabName: 'T', role: 'master' });
  const dById = Object.fromEntries(wdDup.roster.map(r => [r.id, r]));
  assert.equal(dById.d1.paid, false, '1B-a: 중복 order 앵커 편집은 어느 줄에도 적용되지 않는다');
  assert.equal(dById.d2.paid, false, '1B-b: 리뷰 미작성 줄에 입금 표시가 번지면 안 된다');
  assert.equal(dById.d3.paid, false, '1B-c: 세 번째 중복 줄도 마찬가지');
  assert.ok(dById.d1.ambiguous === true && dById.d1.editable === false, '1B-d: 중복 줄은 ambiguous·편집잠금');
  assert.equal(dById.d9.paid, true, '1B-e: 유일한 order 앵커는 종전대로 적용된다(무회귀)');
  assert.ok(dById.d9.ambiguous !== true, '1B-f: 정상 행은 ambiguous 아님');
  assert.equal(wdDup.counts.paid, 1, '1B-g: 입금완료 집계가 부풀지 않는다(1건)');
  assert.equal(wdDup.counts.ambiguous, 3, '1B-h: 중복 줄 수를 화면이 말한다');
  console.log('  1B. order 앵커 중복 게이트 — 번짐 차단·집계 정상·무회귀 ✓');


  // ═══ 2. 광고주 렌즈: 기본 소유 스코프 + 작업보드 전체 열람 시 PII 마스킹 + 편집메타 미노출 ═══
  const pool2 = makeQueryPool({ meta: [], roster: [
    { id: 'r1', seq: 1, name: '홍길동', recipient: '김철수', phone8: '11112222', round: '1', option: '', product: '', submitted: false, paid: false, source: 'import', order_submission_id: null, identity_key: 'phone8:11112222', row_json: {} },
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
  assert.equal(wda.roster[0].name, '홍○○', '2b2: 이름 부분마스킹(첫글자+○)');
  assert.equal(wda.roster[0].recipient, '김○○', '2b3: 수취인 부분마스킹');
  assert.equal(wda.roster[0].editedFields, undefined, '2c: 광고주엔 편집메타 미노출');
  assert.equal(wda.orphanEdits, undefined, '2d: 광고주엔 orphan 미노출');
  const wdDenied = await svc.workdeskTab({ sheetId: 'other', tabName: 'T', role: 'advertiser', advertiserId: 'adv_1' });
  assert.ok(wdDenied.denied === true, '2e: 소유 스코프 밖 거부');
  const wdAll = await svc.workdeskTab({ sheetId: 'other', tabName: 'T', role: 'advertiser', advertiserId: 'adv_1', allowAllWorkdesk: true });
  assert.equal(wdAll.denied, undefined, '2f: 작업보드 전체 열람은 타 업체 작업도 연다');
  assert.equal(wdAll.maskPII, true, '2g: 전체 열람에도 PII 마스킹 유지');
  assert.equal(wdAll.roster[0].editedFields, undefined, '2h: 전체 열람에도 편집메타 미노출');
  console.log('  2. 광고주 렌즈 — 기본 스코프·작업보드 전체열람·마스킹·편집메타 은닉 ✓');

  // ═══ 3. editWorkdeskRow 앵커 도출 + 거부 ═══
  // 3a: order 우선
  let cp = makeConnectPool({ row: { id: 'r1', source: 'import', order_submission_id: 'ord-1', identity_key: 'phone8:1', phone8: '1', recipient_name: null, option_text: null, row_json: {} } });
  svc.__setPoolForTest(cp);
  // ★ 상태칸(is_paid/is_submitted)은 시스템 전용으로 잠겼다 — 앵커 우선순위 검사는 일반 필드로 한다.
  let e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'round', value: '2' });
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
  // 3e: 앵커 전무(빈 준비 자리) → **물리행 앵커**로 저장한다(사용자 확정 2026-08-19).
  //   종전엔 거부였는데, 그러면 아직 배정되지 않은 빈 줄에 송장·비고를 미리 적어 두는
  //   시트 시절의 일상 작업이 작업보드에서 구조적으로 불가능했다. 물리행 id 는 투영 업서트가
  //   (sheet_id, tab_name, seq) 로 보존하므로 manual 물리행과 같은 수준으로 안정적이다.
  cp = makeConnectPool({ row: { id: 'r6', source: 'import', order_submission_id: null, identity_key: null, phone8: '', recipient_name: null, option_text: null, row_json: {} } });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r6', field: 'round', value: '9' });
  assert.ok(e.ok && e.anchorType === 'manual', '3e: 앵커 없는 빈 줄은 물리행 앵커로 저장');
  assert.strictEqual(cp.q.find(x => /INSERT INTO participant_edits/.test(x.s)).params[3], 'r6',
    '3e-2: 그 앵커 값은 물리행 id 다(seq·정렬에 기대지 않는다)');
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
  /* ★★ 3h: '_hidden'(행 숨김)은 **저장 자체가 거부된다** — 화이트리스트에서 뺐다(사용자 확정 2026-08-23).
     되살리면 "표의 줄 수 ≠ 진행 현황" 사고가 그대로 재현된다. 쓰기 0건까지 확인한다. */
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: '_hidden', value: 'true' });
  assert.ok(!e.ok && e.error === 'field_not_editable', '3h: _hidden 편집 거부(숨김 기능 폐기)');
  assert.ok(!cp.q.some(x => /INSERT INTO participant_edits/.test(x.s)), '3h2: 거부 시 쓰기 0건');
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
  /* 3m: 상태칸(리뷰제출·입금)은 **시스템 전용**이라 셀 편집 API 도 거부한다.
     ★ 종전엔 `col:리뷰제출` 편집이 물리 토글까지 함께 기록했는데, 그 경로가 수기 입금일 오염의
       입구였다(입금칸 수기 표기 → is_paid 연동 → 중복 줄로 번짐). 잠금을 풀어 이 가드를
       되살리지 말 것 — 통과시키려면 코드를 사고 이전으로 되돌리게 된다. */
  for (const f of ['col:리뷰제출', 'col:입금']) {
    cp = makeConnectPool({ row: { id: 'r1', source: 'manual', order_submission_id: null, identity_key: null, phone8: '1', recipient_name: null, option_text: null, row_json: {}, tab_gid: '9' }, detectedHeaders: ['리뷰제출', '입금'] });
    svc.__setPoolForTest(cp);
    e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: f, value: '6/20', by: 'm' });
    assert.ok(!e.ok && e.error === 'status_column_locked', `3m: ${f} 편집은 거부해야 한다`);
    assert.ok(!cp.q.some(x => /INSERT INTO participant_edits/.test(x.s)), `3m2: ${f} 는 오버레이를 만들지 않는다`);
  }
  // 3n: col:입금자명(정보열)은 링크 토글 안 함 — is_paid 오탐 차단(리뷰 지적 #1)
  cp = makeConnectPool({ row: { id: 'r1', source: 'manual', order_submission_id: null, identity_key: null, phone8: '1', recipient_name: null, option_text: null, row_json: {}, tab_gid: '9' }, detectedHeaders: ['입금자명', '입금'] });
  svc.__setPoolForTest(cp);
  e = await svc.editWorkdeskRow({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'col:입금자명', value: '김철수', by: 'm' });
  assert.ok(e.ok && e.linkedField == null, '3n: 입금자명은 상태 토글 연동 안 함');
  assert.equal(cp.q.filter(x => /INSERT INTO participant_edits/.test(x.s)).length, 1, '3n2: 오버레이 1건(연동 없음)');
  console.log('  3. editWorkdeskRow — 앵커·거부·bool분리·레이스 + col:검증 + 카운트연동(오탐차단) ✓');

  // ═══ 5. revertWorkdeskEdit 연동 되돌리기 — primary 실제 revert 시에만 연쇄(리뷰 지적 #2) ═══
  const rrow = { id: 'r1', source: 'manual', order_submission_id: null, identity_key: null, phone8: '1', recipient_name: null, option_text: null, row_json: {} };
  // 5a: 상태칸은 되돌리기도 시스템 전용 — 거부하고 아무것도 건드리지 않는다
  for (const f of ['col:리뷰제출', 'col:입금', 'is_submitted', 'is_paid']) {
    cp = makeConnectPool({ row: rrow, revertN: 1 }); svc.__setPoolForTest(cp);
    const rr = await svc.revertWorkdeskEdit({ sheetId: 's', tabName: 'T', rowId: 'r1', field: f, by: 'm' });
    assert.ok(!rr.ok && rr.error === 'status_column_locked', `5a: ${f} 되돌리기는 거부해야 한다`);
    assert.equal(cp.q.filter(x => /UPDATE participant_edits SET reverted_at/.test(x.s)).length, 0,
      `5a2: ${f} 거부 시 쓰기 0`);
  }
  // 5b: 일반 열은 종전대로 1회 되돌림(무회귀)
  cp = makeConnectPool({ row: rrow, revertN: 1 }); svc.__setPoolForTest(cp);
  await svc.revertWorkdeskEdit({ sheetId: 's', tabName: 'T', rowId: 'r1', field: 'col:비고', by: 'm' });
  assert.equal(cp.q.filter(x => /UPDATE participant_edits SET reverted_at/.test(x.s)).length, 1, '5b: 일반 열 되돌리기는 종전대로');
  console.log('  5. revertWorkdeskEdit — 상태칸 잠금 + 일반 열 무회귀 ✓');

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
  assert.ok(p6.q.some(s => /TRIM\(a\.inad_pm\)\s*=\s*\$1/.test(s)), '6a-trim: 담당 매칭은 inad_pm 양쪽 TRIM(공백·표기차 footgun 차단)');
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
