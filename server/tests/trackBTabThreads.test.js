/**
 * P1 탭 스레드(협업 코멘트 + 확인요청 + 내부 메모) 회귀가드.
 *   1. 광고주 조회 = internal_only 글 서버 제외(WHERE internal_only=FALSE).
 *   2. 광고주 작성 = internal_only 강제 FALSE(외부인이 내부 전용 글 못 만듦).
 *   3. request 상태전이(open→confirming→done, done 시 resolved 기록) · comment/없는 글 거부.
 *   4. deleteThread 권한(작성자 본인 or admin/master; 타인 글 거부).
 *   5. unseenCounts = last_seen 이후 + 볼 수 있는 글(광고주 internal 제외).
 *   6. _threadUserKey(내부='role:name' · 광고주='adv:<id>').
 * 실행: node tests/trackBTabThreads.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');

// 간이 목: SQL 패턴별 응답 + 캡처. addThread/list 는 INSERT/SELECT 파라미터 검증 위주.
function makePool(handlers = {}) {
  const q = [];
  return {
    q,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      q.push({ s, params });
      for (const [re, fn] of handlers._list || []) if (re.test(s)) return fn(s, params);
      return { rows: [] };
    },
    on(re, fn) { (this._h || (this._h = [])).push([re, fn]); return this; },
  };
}
function pool(routes) {
  const q = [];
  return { q, async query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').trim(); q.push({ s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(s, params);
    return { rows: [] };
  } };
}

async function run() {
  // ═══ 6. _threadUserKey (내부/광고주 seen 키) — 공개되지 않았으니 markThreadSeen 파라미터로 검증 ═══
  let p = pool([[/INSERT INTO trackb_thread_seen/, () => ({ rows: [] })]]);
  svc.__setPoolForTest(p);
  await svc.markThreadSeen({ sheetId: 'S1', tabName: 'T', role: 'staff', name: '김수만' });
  assert.equal(p.q[0].params[0], 'staff:김수만', '6a: 내부 seen 키 = role:name');
  p = pool([[/INSERT INTO trackb_thread_seen/, () => ({ rows: [] })]]); svc.__setPoolForTest(p);
  await svc.markThreadSeen({ sheetId: 'S1', tabName: 'T', role: 'advertiser', advertiserId: 'adv_1' });
  assert.equal(p.q[0].params[0], 'adv:adv_1', '6b: 광고주 seen 키 = adv:<id>');
  console.log('  6. _threadUserKey — 내부 role:name · 광고주 adv:id ✓');

  // ═══ 1. 광고주 조회 = internal_only 서버 필터 ═══
  p = pool([[/FROM trackb_tab_threads WHERE/, () => ({ rows: [] })]]); svc.__setPoolForTest(p);
  await svc.listThread({ sheetId: 'S1', tabName: 'T', role: 'advertiser' });
  assert.ok(/internal_only = FALSE/.test(p.q[0].s), '1a: 광고주 조회에 internal_only=FALSE 필터');
  p = pool([[/FROM trackb_tab_threads WHERE/, () => ({ rows: [] })]]); svc.__setPoolForTest(p);
  await svc.listThread({ sheetId: 'S1', tabName: 'T', role: 'staff' });
  assert.ok(!/internal_only = FALSE/.test(p.q[0].s), '1b: 내부(staff) 조회는 필터 없음(내부글 포함)');
  console.log('  1. listThread — 광고주만 internal_only 제외 ✓');

  // ═══ 2. 광고주 작성 internal_only 강제 FALSE ═══
  let captured;
  p = pool([[/INSERT INTO trackb_tab_threads/, (s, prm) => { captured = prm; return { rows: [{ id: 1 }] }; }]]);
  svc.__setPoolForTest(p);
  await svc.addThread({ sheetId: 'S1', tabName: 'T', body: '내부글 시도', internalOnly: true, role: 'advertiser', name: '광고주A' });
  // INSERT params: [sheetId, tabName, kind, body, internal, status, role, name]
  assert.equal(captured[4], false, '2a: 광고주는 internalOnly=true 요청해도 FALSE 강제');
  await svc.addThread({ sheetId: 'S1', tabName: 'T', body: '내부메모', internalOnly: true, role: 'staff', name: '김수만' });
  assert.equal(p.q[p.q.length - 1].params[4], true, '2b: 내부인은 internalOnly 반영');
  // 빈 body 거부
  const empty = await svc.addThread({ sheetId: 'S1', tabName: 'T', body: '   ', role: 'staff' });
  assert.equal(empty.ok, false, '2c: 빈 내용 거부'); assert.equal(empty.code, 400);
  // asRequest → kind=request, status=open
  p = pool([[/INSERT INTO trackb_tab_threads/, (s, prm) => { captured = prm; return { rows: [{ id: 2 }] }; }]]); svc.__setPoolForTest(p);
  await svc.addThread({ sheetId: 'S1', tabName: 'T', body: '확인요청', asRequest: true, role: 'advertiser', name: '광고주A' });
  assert.equal(captured[2], 'request', '2d: asRequest → kind=request'); assert.equal(captured[5], 'open', '2d: status=open');
  console.log('  2. addThread — 광고주 internal 강제 FALSE · 빈값 거부 · request open ✓');

  // ═══ 3. request 상태전이 ═══
  p = pool([[/UPDATE trackb_tab_threads SET status/, (s, prm) => prm[1] === 'done'
    ? { rows: [{ id: 5, status: 'done', resolvedAt: 'now', resolvedBy: prm[3] }] }
    : { rows: [{ id: 5, status: 'confirming', resolvedAt: null, resolvedBy: null }] }]]);
  svc.__setPoolForTest(p);
  let r = await svc.setRequestStatus({ id: 5, status: 'confirming', role: 'staff', name: '김수만' });
  assert.equal(r.ok, true); assert.equal(r.item.status, 'confirming', '3a: confirming 전이');
  r = await svc.setRequestStatus({ id: 5, status: 'done', role: 'staff', name: '김수만' });
  assert.equal(r.item.resolvedBy, '김수만', '3b: done 시 resolved_by 기록');
  assert.ok(/kind='request'/.test(p.q[p.q.length - 1].s), '3c: request 만 대상(comment 불가)');
  r = await svc.setRequestStatus({ id: 5, status: 'garbage' });
  assert.equal(r.ok, false, '3d: 잘못된 상태값 거부');
  // 대상 없음 → 404
  p = pool([[/UPDATE trackb_tab_threads SET status/, () => ({ rows: [] })]]); svc.__setPoolForTest(p);
  r = await svc.setRequestStatus({ id: 99, status: 'done' });
  assert.equal(r.code, 404, '3e: 없는 request → 404');
  console.log('  3. setRequestStatus — open→confirming→done·resolved·request전용·검증 ✓');

  // ═══ 4. deleteThread 권한 ═══
  const mkDel = (author) => pool([
    [/SELECT author_role, author_name FROM trackb_tab_threads/, () => ({ rows: [author] })],
    [/UPDATE trackb_tab_threads SET deleted_at/, () => ({ rows: [] })],
  ]);
  p = mkDel({ author_role: 'staff', author_name: '김수만' }); svc.__setPoolForTest(p);
  r = await svc.deleteThread({ id: 1, role: 'staff', name: '김수만' });
  assert.equal(r.ok, true, '4a: 작성자 본인 삭제 허용');
  p = mkDel({ author_role: 'staff', author_name: '박세희' }); svc.__setPoolForTest(p);
  r = await svc.deleteThread({ id: 1, role: 'staff', name: '김수만' });
  assert.equal(r.code, 403, '4b: 타인 글 삭제 거부(staff)');
  p = mkDel({ author_role: 'advertiser', author_name: '광고주A' }); svc.__setPoolForTest(p);
  r = await svc.deleteThread({ id: 1, role: 'admin', name: 'root' });
  assert.equal(r.ok, true, '4c: admin 은 타인 글도 삭제');
  p = pool([[/SELECT author_role, author_name/, () => ({ rows: [] })]]); svc.__setPoolForTest(p);
  r = await svc.deleteThread({ id: 9, role: 'admin' });
  assert.equal(r.code, 404, '4d: 없는 글 404');
  console.log('  4. deleteThread — 작성자/admin 만·타인 거부·404 ✓');

  // ═══ 5. unseenCounts ═══
  p = pool([[/FROM trackb_tab_threads t LEFT JOIN trackb_thread_seen s/, (s, prm) => ({
    rows: [{ sheetId: 'S1', tabName: 'A', n: 3 }, { sheetId: 'S1', tabName: 'B', n: 1 }] })]]);
  svc.__setPoolForTest(p);
  r = await svc.unseenCounts({ role: 'advertiser', advertiserId: 'adv_1' });
  assert.ok(/internal_only = FALSE/.test(p.q[0].s), '5a: 광고주 미확인도 internal 제외');
  assert.equal(r.total, 4, '5b: total 합산'); assert.equal(r.map['S1\tA'], 3, '5c: 탭별 맵');
  assert.equal(p.q[0].params[0], 'adv:adv_1', '5d: seen 키 = adv:id');
  p = pool([[/FROM trackb_tab_threads t LEFT JOIN trackb_thread_seen s/, () => ({ rows: [] })]]); svc.__setPoolForTest(p);
  await svc.unseenCounts({ role: 'staff', name: '김수만', tabs: [{ sheetId: 'S1', tabName: 'A' }] });
  assert.ok(!/internal_only = FALSE/.test(p.q[0].s), '5e: 내부는 internal 필터 없음');
  assert.ok(/t.sheet_id=\$2 AND t.tab_name=\$3/.test(p.q[0].s), '5f: tabs 스코프 필터');
  console.log('  5. unseenCounts — 광고주 internal 제외·total/맵·tabs 스코프 ✓');

  svc.__setPoolForTest(null);
  console.log('✅ trackBTabThreads 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
