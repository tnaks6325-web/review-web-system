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
const participants = require('../src/services/participants.service');

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

  // ═══ 3. request 상태전이 (+ B1: (sheetId,tabName) 결속) ═══
  p = pool([[/UPDATE trackb_tab_threads SET status/, (s, prm) => prm[1] === 'done'
    ? { rows: [{ id: 5, status: 'done', resolvedAt: 'now', resolvedBy: prm[3] }] }
    : { rows: [{ id: 5, status: 'confirming', resolvedAt: null, resolvedBy: null }] }]]);
  svc.__setPoolForTest(p);
  let r = await svc.setRequestStatus({ id: 5, sheetId: 'S1', tabName: 'T', status: 'confirming', role: 'staff', name: '김수만' });
  assert.equal(r.ok, true); assert.equal(r.item.status, 'confirming', '3a: confirming 전이');
  assert.ok(/sheet_id=\$5 AND tab_name=\$6/.test(p.q[p.q.length - 1].s), '3a2: B1 — UPDATE가 (sheetId,tabName)에 결속');
  r = await svc.setRequestStatus({ id: 5, sheetId: 'S1', tabName: 'T', status: 'done', role: 'staff', name: '김수만' });
  assert.equal(r.item.resolvedBy, '김수만', '3b: done 시 resolved_by 기록');
  assert.ok(/kind='request'/.test(p.q[p.q.length - 1].s), '3c: request 만 대상(comment 불가)');
  r = await svc.setRequestStatus({ id: 5, sheetId: 'S1', tabName: 'T', status: 'garbage' });
  assert.equal(r.ok, false, '3d: 잘못된 상태값 거부');
  r = await svc.setRequestStatus({ id: 5, status: 'done' });  // sheetId/tabName 누락
  assert.equal(r.ok, false, '3d2: sheetId/tabName 없으면 거부');
  // 대상 없음(또는 타 탭 id) → 404
  p = pool([[/UPDATE trackb_tab_threads SET status/, () => ({ rows: [] })]]); svc.__setPoolForTest(p);
  r = await svc.setRequestStatus({ id: 99, sheetId: 'S1', tabName: 'T', status: 'done' });
  assert.equal(r.code, 404, '3e: 없는(또는 타 탭) request → 404');
  console.log('  3. setRequestStatus — 상태전이·resolved·request전용·(sheetId,tabName) 결속(B1) ✓');

  // ═══ 4. deleteThread 권한 (+ S1: (sheetId,tabName) 결속) ═══
  const mkDel = (author) => pool([
    [/SELECT author_role, author_name FROM trackb_tab_threads/, () => ({ rows: [author] })],
    [/UPDATE trackb_tab_threads SET deleted_at/, () => ({ rows: [] })],
  ]);
  p = mkDel({ author_role: 'staff', author_name: '김수만' }); svc.__setPoolForTest(p);
  r = await svc.deleteThread({ id: 1, sheetId: 'S1', tabName: 'T', role: 'staff', name: '김수만' });
  assert.equal(r.ok, true, '4a: 작성자 본인 삭제 허용');
  assert.ok(/WHERE id=\$1 AND sheet_id=\$2 AND tab_name=\$3/.test(p.q[0].s), '4a2: S1 — SELECT가 (sheetId,tabName)에 결속');
  p = mkDel({ author_role: 'staff', author_name: '박세희' }); svc.__setPoolForTest(p);
  r = await svc.deleteThread({ id: 1, sheetId: 'S1', tabName: 'T', role: 'staff', name: '김수만' });
  assert.equal(r.code, 403, '4b: 타인 글 삭제 거부(staff)');
  p = mkDel({ author_role: 'advertiser', author_name: '광고주A' }); svc.__setPoolForTest(p);
  r = await svc.deleteThread({ id: 1, sheetId: 'S1', tabName: 'T', role: 'admin', name: 'root' });
  assert.equal(r.ok, true, '4c: admin 은 타인 글도 삭제');
  r = await svc.deleteThread({ id: 1, role: 'admin' });  // sheetId/tabName 누락
  assert.equal(r.ok, false, '4c2: sheetId/tabName 없으면 거부');
  p = pool([[/SELECT author_role, author_name/, () => ({ rows: [] })]]); svc.__setPoolForTest(p);
  r = await svc.deleteThread({ id: 9, sheetId: 'S1', tabName: 'T', role: 'admin' });
  assert.equal(r.code, 404, '4d: 없는(또는 타 탭) 글 404');
  console.log('  4. deleteThread — 작성자/admin·타인 거부·404·(sheetId,tabName) 결속(S1) ✓');

  // ═══ 5. unseenCounts (master/admin: 전체·tabs 그대로) ═══
  p = pool([[/FROM trackb_tab_threads t LEFT JOIN trackb_thread_seen s/, (s, prm) => ({
    rows: [{ sheetId: 'S1', tabName: 'A', n: 3 }, { sheetId: 'S1', tabName: 'B', n: 1 }] })]]);
  svc.__setPoolForTest(p);
  r = await svc.unseenCounts({ role: 'master', name: 'root' });
  assert.equal(r.total, 4, '5a: master total 합산'); assert.equal(r.map['S1\tA'], 3, '5b: 탭별 맵');
  assert.ok(!/internal_only = FALSE/.test(p.q[0].s), '5c: 내부는 internal 필터 없음');
  assert.equal(p.q[0].params[0], 'master:root', '5d: seen 키 = role:name');

  // staff의 작업보드 전체 운영 모드에서는 담당/소유 집합으로 다시 줄이지 않는다.
  p = pool([[/FROM trackb_tab_threads t LEFT JOIN trackb_thread_seen s/, () => ({ rows: [{ sheetId: 'S2', tabName: 'X', n: 2 }] })]]);
  svc.__setPoolForTest(p);
  r = await svc.unseenCounts({ role: 'staff', name: 'ae', allWorkdesk: true, tabs: [{ sheetId: 'S2', tabName: 'X' }] });
  assert.equal(r.total, 2, '5e: staff 전체 작업보드 미확인 수');
  assert.ok(p.q.some(x => /FROM trackb_tab_threads t LEFT JOIN/.test(x.s)), '5f: staff 전체 모드는 스레드 집계 실행');

  // ═══ 5.5 B2: staff/advertiser 는 소유 탭으로 서버 강제 제한 ═══
  //   scopedActiveTabs 목: participants.listActiveTabs(전체 탭) + svc 풀(advertiser_campaigns 스코프/주석).
  //   광고주 adv_1 은 시트 S1 전체 소유 → S1 탭만. S2(타 업체)는 소유 아님.
  const allTabs = [
    { sheetId: 'S1', tabName: 'A', tabGid: '11', spreadsheetTitle: '내시트' },
    { sheetId: 'S2', tabName: 'X', tabGid: '21', spreadsheetTitle: '타시트' },
  ];
  participants.__setPoolForTest({ async query() { return { rows: allTabs.map(t => ({ ...t, rowCount: 1 })) }; } });
  const svcPool = pool([
    [/FROM advertiser_campaigns WHERE advertiser_id/, () => ({ rows: [{ sheetId: 'S1', tabGid: null }] })],           // 소유 = S1 전체
    [/FROM advertiser_campaigns ac JOIN advertisers a/, () => ({ rows: [{ sheetId: 'S1', tabGid: null, advId: 'adv_1', advName: '어니스트캄' }] })],
    [/FROM trackb_tab_threads t LEFT JOIN trackb_thread_seen s/, () => ({ rows: [{ sheetId: 'S1', tabName: 'A', n: 2 }] })],
  ]);
  svc.__setPoolForTest(svcPool);
  // 광고주가 소유 S1/A + 타 업체 S2/X 를 요청 → S2/X 는 드롭(교차 메타 유출 차단)
  r = await svc.unseenCounts({ role: 'advertiser', advertiserId: 'adv_1', tabs: [{ sheetId: 'S1', tabName: 'A' }, { sheetId: 'S2', tabName: 'X' }] });
  const threadQ = svcPool.q.find(x => /FROM trackb_tab_threads t LEFT JOIN/.test(x.s));
  assert.ok(threadQ, '5.5a: 스레드 쿼리 실행됨');
  assert.ok(/internal_only = FALSE/.test(threadQ.s), '5.5a2: 광고주 internal 제외');
  const qparams = threadQ.params.slice(1);   // params[0]=userKey
  assert.ok(qparams.includes('S1') && qparams.includes('A'), '5.5b: 소유 S1/A 는 쿼리에 포함');
  assert.ok(!qparams.includes('S2') && !qparams.includes('X'), '5.5c: B2 — 타 업체 S2/X 는 서버가 드롭(교차 메타 유출 차단)');
  assert.equal(r.map['S1\tA'], 2, '5.5d: 소유 탭 카운트');

  // 소유가 전혀 없는 광고주 → 전역 쿼리 없이 빈 결과
  participants.__setPoolForTest({ async query() { return { rows: allTabs.map(t => ({ ...t, rowCount: 1 })) }; } });
  const emptyPool = pool([[/FROM advertiser_campaigns WHERE advertiser_id/, () => ({ rows: [] })]]);
  svc.__setPoolForTest(emptyPool);
  r = await svc.unseenCounts({ role: 'advertiser', advertiserId: 'adv_none', tabs: [{ sheetId: 'S2', tabName: 'X' }] });
  assert.deepEqual(r, { map: {}, total: 0 }, '5.5e: 무소유 → 빈 결과');
  assert.ok(!emptyPool.q.some(x => /FROM trackb_tab_threads t LEFT JOIN/.test(x.s)), '5.5f: 무소유는 전역 스레드 쿼리 미실행');
  console.log('  5. unseenCounts — master 전체 + B2 staff/advertiser 소유 강제(교차 드롭·무소유 빈결과) ✓');

  participants.__setPoolForTest(null);
  svc.__setPoolForTest(null);
  console.log('✅ trackBTabThreads 테스트 전체 통과');
}

run().catch(e => { console.error('❌', e); process.exit(1); });
