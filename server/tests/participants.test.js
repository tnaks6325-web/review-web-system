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
      if (/FROM review_index/.test(s)) return { rows: scenario.index || [] };
      if (/COUNT\(\*\)::int AS n FROM campaign_participants/.test(s)) return { rows: [{ n: scenario.existing || 0 }] };
      if (/INSERT INTO campaign_participants/.test(s)) return { rows: [{ inserted: true }] };
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
  // conflict update SET 절에 is_submitted/is_paid/source가 없어야 함(토글·출처 보존)
  const doUpdate = ins.s.split('DO UPDATE SET')[1] || '';
  assert.ok(!/is_submitted\s*=/.test(doUpdate), 'conflict update에 is_submitted 미포함(토글 보존)');
  assert.ok(!/is_paid\s*=/.test(doUpdate), 'conflict update에 is_paid 미포함(토글 보존)');
  assert.ok(!/source\s*=/.test(doUpdate), 'conflict update에 source 미포함(수동표시 보존)');
  assert.ok(/deleted_at = NULL/.test(doUpdate), '재임포트 시 소프트삭제 해제');
  console.log('  실임포트 upsert·토글보존 통과');

  // ── setParticipantStatus: source='manual' + 상태 UPDATE ──
  pool = makePool({});
  svc.__setPoolForTest(pool);
  r = await svc.setParticipantStatus({ id: 'uuid-1', isSubmitted: true, by: 'master' });
  assert.equal(r.updated, 1);
  const upd = pool.q.find(x => /UPDATE campaign_participants SET/.test(x.s));
  assert.ok(/source = 'manual'/.test(upd.s), '토글은 source=manual 표시');
  assert.ok(/is_submitted = \$/.test(upd.s), 'is_submitted UPDATE');
  console.log('  status 토글 통과');

  svc.__setPoolForTest(null);
}
run().then(() => console.log('participants tests passed')).catch(e => { console.error(e); process.exit(1); });
