/**
 * participants.service 회귀 가드 (Phase 1 shadow 임포트).
 *   - importTabFromIndex: review_index→campaign_participants 매핑(is_submitted2='PAID'→is_paid),
 *     dryRun 무쓰기, upsert가 is_submitted/is_paid를 conflict update SET에 넣지 않음(토글 보존).
 *   - setParticipantStatus: source='manual' + 상태 UPDATE.
 * 실행: node tests/participants.test.js
 */
const assert = require('assert');
const svc = require('../src/services/participants.service');

function makePool(scenario) {
  const q = [];
  return {
    q,
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      if (/FROM campaign_participants WHERE deleted_at IS NULL AND source='import' GROUP BY/.test(s)) return { rows: scenario.syncTabs || [] };
      if (/FROM review_index/.test(s)) return { rows: scenario.index || [] };
      if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(s)) return { rows: [{ n: scenario.existing || 0 }] };
      if (/SELECT COALESCE\(MAX\(seq\)/.test(s)) return { rows: [{ nextseq: scenario.nextseq || 900001, tab_gid: scenario.tabGid || null }] };
      if (/RETURNING id, seq/.test(s)) return { rows: [{ id: 'new-uuid', seq: params[3] }] };   // add
      if (/INSERT INTO campaign_participants/.test(s)) return { rows: [{ inserted: true }] };     // import upsert
      if (/UPDATE campaign_participants SET deleted_at/.test(s)) return { rows: scenario.delMiss ? [] : [{ id: params[0] }] };
      if (/UPDATE campaign_participants SET/.test(s)) return { rows: [{ id: params[0], isSubmitted: true, isPaid: false }] };
      return { rows: [] };
    },
  };
}

async function run() {
  // ── dryRun: 쓰기(INSERT) 없이 예상치만 ──
  let pool = makePool({ index: [
    { reviewer_name: '주문자A', tab_gid: '9', campaign_name: 'C', row_index: 2, is_submitted: true, is_submitted2: 'PAID', product_name: '샴푸', row_json: {}, round: '2', phone8: '11112222' },
    { reviewer_name: '주문자B', tab_gid: '9', campaign_name: 'C', row_index: 3, is_submitted: false, is_submitted2: 'NONE', product_name: '샴푸', row_json: {}, round: '2', phone8: '33334444' },
  ], existing: 0 });
  svc.__setPoolForTest(pool);
  let r = await svc.importTabFromIndex({ sheetId: 's1', tabName: 'T', dryRun: true });
  assert.equal(r.dryRun, true); assert.equal(r.indexRows, 2);
  assert.ok(!pool.q.some(x => /INSERT INTO campaign_participants/.test(x.s)), 'dryRun은 INSERT 없음');
  assert.equal(r.sample[0].paid, true, 'is_submitted2=PAID → paid true');
  assert.equal(r.sample[1].paid, false, 'NONE → paid false');
  assert.ok(/••••/.test(r.sample[0].phone8), 'phone8 마스킹');
  console.log('  dryRun 무쓰기·매핑 통과');

  // ── 실임포트: INSERT 발생 + upsert가 is_submitted/is_paid를 conflict update에 넣지 않음(토글 보존) ──
  pool = makePool({ index: [
    { reviewer_name: '주문자A', tab_gid: '9', campaign_name: 'C', row_index: 2, is_submitted: true, is_submitted2: 'PAID', product_name: '샴푸', product_url: null, start_date: null, end_date: null, row_json: { a: 1 }, round: '2', phone8: '11112222' },
  ], existing: 0 });
  svc.__setPoolForTest(pool);
  r = await svc.importTabFromIndex({ sheetId: 's1', tabName: 'T', by: 'master' });
  assert.equal(r.imported, 1); assert.equal(r.inserted, 1);
  const ins = pool.q.find(x => /INSERT INTO campaign_participants/.test(x.s));
  assert.ok(ins, 'INSERT 실행');
  assert.ok(/ON CONFLICT \(sheet_id, tab_name, seq\) DO UPDATE/.test(ins.s), '멱등 upsert 키');
  // Phase 4: conflict update가 is_submitted/is_paid를 CASE로 갱신하되 source='import'일 때만(수동 보존).
  const doUpdate = ins.s.split('DO UPDATE SET')[1] || '';
  // ★ 'worktable'(작업표가 미리 만든 빈 줄)도 import 처럼 따라간다 — 'manual'(사람이 손댄 행)만 보존.
  //   worktable 을 manual 로 두면 리뷰어가 리뷰를 내도 표시가 영영 안 켜진다(M2b-2).
  assert.ok(/is_submitted = CASE WHEN campaign_participants\.source IN \('import','worktable'\)/.test(doUpdate), 'import·worktable 행만 상태 최신화');
  assert.ok(/is_paid\s*=\s*CASE WHEN campaign_participants\.source IN \('import','worktable'\)/.test(doUpdate), 'import·worktable 행만 입금 최신화');
  assert.ok(!/IN \('import','worktable','manual'\)/.test(doUpdate), "manual(사람이 손댄 행)은 여전히 보존");
  // source 컬럼은 SET 대상이 아님(수동표시 보존): campaign_participants.source(조건참조) 외에 'source =' 할당 없음.
  assert.ok(!/source\s*=\s*(EXCLUDED|'manual')/.test(doUpdate), 'source 컬럼 미갱신(수동표시 보존)');
  assert.ok(/deleted_at = NULL/.test(doUpdate), '재임포트 시 소프트삭제 해제');
  console.log('  실임포트 upsert·상태최신화(수동보존) 통과');

  // ── setParticipantStatus: source='manual' + 상태 UPDATE ──
  pool = makePool({});
  svc.__setPoolForTest(pool);
  r = await svc.setParticipantStatus({ id: 'uuid-1', isSubmitted: true, by: 'master' });
  assert.equal(r.updated, 1);
  const upd = pool.q.find(x => /UPDATE campaign_participants SET/.test(x.s));
  assert.ok(/source = 'manual'/.test(upd.s), '토글은 source=manual 표시');
  assert.ok(/is_submitted = \$/.test(upd.s), 'is_submitted UPDATE');
  console.log('  status 토글 통과');

  // ── Phase 2a: 추가 — seq 900000+ 범위 + phone8 정규화 + source=manual ──
  pool = makePool({ nextseq: 900001 });
  svc.__setPoolForTest(pool);
  let a = await svc.addParticipant({ sheetId: 's1', tabName: 'T', reviewerName: '수동추가', phone: '010-9999-1234', by: 'master' });
  assert.equal(a.added, 1); assert.equal(a.seq, 900001, '수동 seq는 900000+ (import와 비충돌)');
  const ins2 = pool.q.find(x => /INSERT INTO campaign_participants[\s\S]*RETURNING id, seq/.test(x.s));
  assert.ok(/'manual'/.test(ins2.s), '추가는 source=manual');
  assert.equal(ins2.params[6], '99991234', 'phone→phone8 끝8자리 정규화'); // seq idx: sheet,gid,tab,seq,name,recip,phone8...
  console.log('  추가(seq범위·phone8·manual) 통과');

  // ── 수정: 화이트리스트 필드만 + source=manual ──
  pool = makePool({});
  svc.__setPoolForTest(pool);
  let u = await svc.updateParticipant({ id: 'x', fields: { reviewer_name: '수정됨', bogus: 'DROP', phone8: '010-1' }, by: 'master' });
  const upd2 = pool.q.find(x => /UPDATE campaign_participants SET reviewer_name/.test(x.s));
  assert.ok(upd2, 'reviewer_name 수정');
  assert.ok(!/bogus/.test(upd2.s), '화이트리스트 외 필드 무시(인젝션 방어)');
  assert.ok(/source='manual'/.test(upd2.s), '수정은 source=manual');
  // 빈 편집 → 400성
  const u0 = await svc.updateParticipant({ id: 'x', fields: { nope: 1 }, by: 'm' });
  assert.equal(u0.updated, 0); assert.equal(u0.reason, 'no_editable_fields');
  console.log('  수정(화이트리스트·no-op) 통과');

  // ── 삭제: 소프트삭제 ──
  pool = makePool({});
  svc.__setPoolForTest(pool);
  let d = await svc.softDeleteParticipant({ id: 'x', by: 'master' });
  assert.equal(d.deleted, 1);
  const del = pool.q.find(x => /UPDATE campaign_participants SET deleted_at/.test(x.s));
  assert.ok(/deleted_at=NOW\(\)/.test(del.s), '소프트삭제(deleted_at)');
  // 없는 id → deleted 0
  svc.__setPoolForTest(makePool({ delMiss: true }));
  const dMiss = await svc.softDeleteParticipant({ id: 'gone', by: 'm' });
  assert.equal(dMiss.deleted, 0, '없는 id → deleted 0');
  console.log('  삭제(소프트) 통과');

  // ── Phase 4: syncImportedTabs — 가져온 탭들을 순회하며 importTabFromIndex(시트 재읽기 0) ──
  pool = makePool({ syncTabs: [{ sheetId: 's1', tabName: 'T1' }, { sheetId: 's1', tabName: 'T2' }], index: [] });
  svc.__setPoolForTest(pool);
  const sy = await svc.syncImportedTabs({ by: 'cron' });
  assert.equal(sy.candidateTabs, 2, '가져온 탭 2개 후보');
  assert.equal(sy.tabsSynced, 2, '2탭 동기화');
  assert.ok(!pool.q.some(x => /getSpreadsheetMeta|readSheet/.test(x.s)), '시트 재읽기 없음(DB→DB)');
  console.log('  syncImportedTabs(DB→DB, 시트0) 통과');

  svc.__setPoolForTest(null);
}
run().then(() => console.log('participants tests passed')).catch(e => { console.error(e); process.exit(1); });
