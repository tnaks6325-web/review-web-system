'use strict';
/**
 * orderDeleteImpactPg.test.js — 결정 387(「가」 서버): 인트라넷에서 오더를 지울 때 리뷰웹에 **남는 모집공고·작업보드**를 알려 준다.
 * 발단(2026-11-18 세라모사이드): 첫 오더를 지웠는데 그 오더로 게시한 공고가 그대로 남아 다음 날 07시에 열렸다(194명 신청).
 *   리뷰웹 삭제 응답은 `{ ok, id }` 뿐이라 「공고·작업보드는 남겼다」를 아무에게도 알리지 않았다.
 *
 *   [1] 남는 공고 = 삭제 전·후 모두 보인다(역방향 짝 함수 liveCampaignForWorkOrders 는 삭제 뒤 공고를 놓친다 — 직접 조회)
 *   [2] 공고 상태 4종(게시 중·임시저장·멈춤·마감) · 보관 공고는 「남는 공고」가 아니다
 *   [3] 작업보드 「남음 / 정리 예정」 예측 = 실제 자동 정리(autoCleanupDeletedOrderTab)와 **같은 결과**(실제로 돌려 대조)
 *   [4] 조회 실패·시간 초과 = known:false — 절대 「남는 것 없음」으로 접지 않는다
 *   [5] 삭제 응답 kept(새 삭제·이미 삭제 두 갈래) · 기존 필드 불변 · 응답 뒤 정리 순서 불변
 *   [6] 삭제 전 미리보기 주소 — 인트라넷 열쇠는 헤더만(주소·본문 열쇠 401) · 개인정보·직원 이름 없음
 * 실 SQL(PGlite · 저장소 migrations 전부 적용 — 확장 탓에 못 도는 9개가 만드는 표는 최소 모양으로 채운다).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');

const SERVER = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(SERVER, p), 'utf8');

(async () => {
  const db = new PGlite();
  for (const f of fs.readdirSync(path.join(SERVER, 'migrations')).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(SERVER, 'migrations', f), 'utf8')); } catch (_) { /* pg_trgm·pgcrypto 등 확장 — 아래에서 표만 채운다 */ }
  }
  const query = async (sql, params) => { const r = await db.query(sql, params || []); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; };
  const pool = { query, connect: async () => ({ query, release() {} }), on() {}, end: async () => {} };
  const poolPath = require.resolve(path.join(SERVER, 'src/db/pool'));
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const q = (t, p) => pool.query(t, p);

  const svc = require('../src/services/workTabDelete.service');
  for (const t of [...svc.DELETE_TABLES, ...svc.MONEY_TABLES.map(m => m.table)]) {
    await q(`CREATE TABLE IF NOT EXISTS ${t} (id serial, sheet_id text, tab_name text)`);
  }
  const router = require('../src/routes/order.routes');

  let passed = 0;
  const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); throw e; } };

  // ── 고정구 ──────────────────────────────────────────────────────────────
  const mkOrder = async ({ id, title = id, tab = null, linkedCampaign = '' }) => {
    await q(`INSERT INTO work_orders (id, title, status, linked_tab_sheet_id, linked_tab_name, linked_campaign_id, source_review_order_id)
             VALUES ($1,$2,'published',$3,$4,$5,$6)`, [id, title, tab ? tab.s : '', tab ? tab.t : '', linkedCampaign, 'ro_' + id]);
  };
  const mkTab = async (s, t, { empty = 3, filled = 0 } = {}) => {
    await q(`INSERT INTO tab_configs (sheet_id, tab_name, sheetless) VALUES ($1,$2,true)`, [s, t]);
    let seq = 0;
    for (let i = 0; i < filled; i++) await q(`INSERT INTO campaign_participants (sheet_id, tab_name, seq, reviewer_name, phone8) VALUES ($1,$2,$3,'가상리뷰어','11112222')`, [s, t, ++seq]);
    for (let i = 0; i < empty; i++) await q(`INSERT INTO campaign_participants (sheet_id, tab_name, seq) VALUES ($1,$2,$3)`, [s, t, ++seq]);
    return { s, t };
  };
  const mkCampaign = async ({ id, title, status = 'active', tab = null, sourceWo = '', published = true, archived = false, paused = false }) => {
    await q(`INSERT INTO recruit_campaigns (id, title, status, participation_mode, linked_sheet_id, linked_tab_name, source_work_order_id,
                                            published_at, archived_at, soldout_paused_at)
             VALUES ($1,$2,$3,TRUE,$4,$5,$6, ${published ? 'NOW()' : 'NULL'}, ${archived ? 'NOW()' : 'NULL'}, ${paused ? 'NOW()' : 'NULL'})`,
      [id, title, status, tab ? tab.s : null, tab ? tab.t : null, sourceWo]);
  };
  const apply = async (campaignId, status, n) => {
    for (let i = 0; i < n; i++) await q(`INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, phone8, status, submitted_at)
                                          VALUES ($1,'신청자가상','01098765432','98765432',$2, CASE WHEN $2='submitted' THEN NOW() END)`, [campaignId, status]);
  };
  const tabExists = async tab => (await q(`SELECT 1 FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2`, [tab.s, tab.t])).rows.length > 0;

  // ── 라우트 호출기(실제 핸들러 · 실제 SQL) ─────────────────────────────────
  const handlerOf = (method, p) => {
    const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${p} 경로가 있어야 한다`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  const events = [];
  const call = async (method, p, { id, headers = {}, query: qs = {}, body = {} } = {}) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; events.push('json'); return this; } };
    let err = null;
    await handlerOf(method, p)({ headers, query: qs, body, params: { id } }, res, e => { err = e; });
    if (err) throw err;
    return res;
  };
  const KEY = 'test-intake-key';
  process.env.ORDER_INTAKE_KEY = KEY;
  const H = { 'x-intake-key': KEY };
  const pending = [];
  const origCleanup = svc.autoCleanupDeletedOrderTab;
  svc.autoCleanupDeletedOrderTab = (...a) => { events.push('cleanup'); const p = origCleanup(...a); pending.push(p); return p; };
  const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise(r => setImmediate(r)); } await Promise.all(pending.splice(0)); };
  const preview = async id => (await call('get', '/intake/:id/delete-impact', { id, headers: H })).body.kept;
  const del = async id => { events.length = 0; const r = await call('delete', '/intake/:id', { id, headers: H, body: { deleted_by: 'jhm', deleted_by_name: '정현민가상' } }); await settle(); return r; };

  // 세라모사이드 표본(2026-11-18 · 숫자는 줄임): 첫 오더 = 게시 공고 + 신청·제출 · 둘째 오더 = 보관된 초안 공고 + 빈 작업보드
  const T1 = await mkTab('wt_ceramo1', '11/19 오전7시 세라모사이드 이너뷰티캔디', { empty: 2, filled: 4 });
  await mkCampaign({ id: 'camp_ceramo1', title: '11/19 오전7시 세라모사이드 이너뷰티캔디', tab: T1, sourceWo: 'wo_ceramo1' });
  await mkOrder({ id: 'wo_ceramo1', tab: T1, linkedCampaign: 'camp_ceramo1' });
  await apply('camp_ceramo1', 'submitted', 4); await apply('camp_ceramo1', 'expired', 1); await apply('camp_ceramo1', 'cancelled', 1);
  const T2 = await mkTab('wt_ceramo2', '11/19 오전7시 세라모사이드 이너뷰티캔디', { empty: 3 });
  await mkCampaign({ id: 'camp_ceramo2', title: '세라모사이드 수량단계', status: 'draft', tab: T2, sourceWo: 'wo_ceramo2', published: false, archived: true });
  await mkOrder({ id: 'wo_ceramo2', tab: T2, linkedCampaign: 'camp_ceramo2' });

  console.log('\n[결정 387 · 오더 삭제 때 남는 공고·작업보드 알리기 · 실 SQL]');
  console.log('[1] 세라모사이드 첫 오더 — 게시 공고가 남는다');
  await ok('삭제 전 미리보기: 게시 중 공고 1개(신청 6 · 제출 4) · 작업보드 남음(채운 줄·살아 있는 공고·공고 신청)', async () => {
    const k = await preview('wo_ceramo1');
    assert.strictEqual(k.known, true);
    assert.strictEqual(k.phase, 'preview');
    assert.deepStrictEqual(k.campaigns, [{ id: 'camp_ceramo1', title: '11/19 오전7시 세라모사이드 이너뷰티캔디', state: 'open', applicants: 6, submitted: 4 }]);
    assert.strictEqual(k.worktable.outcome, 'remains');
    assert.strictEqual(k.worktable.will_remove, false);
    assert.strictEqual(k.worktable.predicted, true);
    assert.strictEqual(k.worktable.name, T1.t);
    for (const r of ['filled_rows', 'live_campaign', 'campaign_used']) assert.ok(k.worktable.reasons.includes(r), r);
    assert.ok(!k.worktable.reasons.includes('live_work_order'), '미리보기는 곧 지울 자기 오더를 「살아 있는 오더」로 세지 않는다');
  });
  await ok('삭제 응답: 기존 필드(ok·id) 그대로 + kept(삭제 뒤 기준) · 공고는 삭제 뒤에도 보인다 · 응답 → 정리 순서', async () => {
    const r = await del('wo_ceramo1');
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.id, 'wo_ceramo1');
    assert.ok(!('alreadyDeleted' in r.body));
    assert.strictEqual(r.body.kept.known, true);
    assert.strictEqual(r.body.kept.phase, 'after');
    assert.deepStrictEqual(r.body.kept.campaigns.map(c => [c.id, c.state, c.applicants, c.submitted]), [['camp_ceramo1', 'open', 6, 4]]);
    assert.strictEqual(r.body.kept.worktable.outcome, 'remains');
    assert.deepStrictEqual(events, ['json', 'cleanup'], '응답이 먼저, 정리는 그 뒤(종전 순서)');
    assert.strictEqual(await tabExists(T1), true, '예측대로 작업보드가 남았다');
    assert.strictEqual((await q(`SELECT 1 FROM recruit_campaigns WHERE id='camp_ceramo1' AND archived_at IS NULL`)).rows.length, 1, '공고 자동 보관·삭제 없음(정책 ⑧)');
  });
  await ok('응답에 개인정보·직원 이름 없음 · 공고 칸은 허용 목록 5개만', async () => {
    const r = await call('get', '/intake/:id/delete-impact', { id: 'wo_ceramo1', headers: H });
    const s = JSON.stringify(r.body);
    for (const bad of ['신청자가상', '01098765432', '98765432', '가상리뷰어', '11112222', '정현민가상', 'jhm']) assert.ok(!s.includes(bad), bad);
    for (const c of r.body.kept.campaigns) assert.deepStrictEqual(Object.keys(c).sort(), ['applicants', 'id', 'state', 'submitted', 'title']);
    assert.deepStrictEqual(Object.keys(r.body.kept.worktable).sort(), ['name', 'outcome', 'predicted', 'reasons', 'will_remove']);
  });

  console.log('[2] 세라모사이드 둘째 오더 — 보관 공고만 · 빈 작업보드 = 정리 예정 → 실제로 정리됨');
  await ok('미리보기: 남는 공고 0(보관 공고는 남는 공고가 아니다) · 작업보드 정리 예정', async () => {
    const k = await preview('wo_ceramo2');
    assert.strictEqual(k.known, true);
    assert.deepStrictEqual(k.campaigns, []);
    assert.strictEqual(k.worktable.outcome, 'will_remove');
    assert.strictEqual(k.worktable.will_remove, true);
    assert.deepStrictEqual(k.worktable.reasons, []);
  });
  await ok('삭제 → 예측대로 실제 자동 정리가 작업보드·보관 초안 공고를 지웠다', async () => {
    const r = await del('wo_ceramo2');
    assert.strictEqual(r.body.kept.worktable.outcome, 'will_remove');
    assert.strictEqual(await tabExists(T2), false);
    assert.strictEqual((await q(`SELECT 1 FROM recruit_campaigns WHERE id='camp_ceramo2'`)).rows.length, 0);
  });
  await ok('같은 삭제를 다시 보냄: alreadyDeleted 그대로 + kept · 작업보드 = 이미 정리됨(removed)', async () => {
    const r = await del('wo_ceramo2');
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.alreadyDeleted, true);
    assert.strictEqual(r.body.kept.known, true);
    assert.deepStrictEqual(r.body.kept.campaigns, []);
    assert.strictEqual(r.body.kept.worktable.outcome, 'removed');
    assert.strictEqual(r.body.kept.worktable.name, T2.t);
    assert.deepStrictEqual(events, ['json', 'cleanup'], '재시도 정리도 응답 뒤(종전)');
  });

  console.log('[3] 공고 상태 4종 · 역방향 짝 함정');
  const T3 = await mkTab('wt_draft', '임시저장 작업');
  await mkCampaign({ id: 'camp_draft', title: '임시저장 공고', status: 'draft', tab: T3, sourceWo: 'wo_draft', published: false });
  await mkOrder({ id: 'wo_draft', tab: T3, linkedCampaign: 'camp_draft' });
  const T4 = await mkTab('wt_paused', '멈춤 작업');
  await mkCampaign({ id: 'camp_paused', title: '멈춤 공고', tab: T4, sourceWo: 'wo_paused', paused: true });
  await mkOrder({ id: 'wo_paused', tab: T4, linkedCampaign: 'camp_paused' });
  const T5 = await mkTab('wt_closed', '마감 작업');
  await mkCampaign({ id: 'camp_closed', title: '마감 공고', status: 'closed', tab: T5, sourceWo: 'wo_closed' });
  await mkOrder({ id: 'wo_closed', tab: T5, linkedCampaign: 'camp_closed' });
  await ok('임시저장 → draft · 멈춤 → paused · 마감 → closed (작업보드는 살아 있는 공고 때문에 남음)', async () => {
    for (const [wo, st] of [['wo_draft', 'draft'], ['wo_paused', 'paused'], ['wo_closed', 'closed']]) {
      const k = await preview(wo);
      assert.deepStrictEqual(k.campaigns.map(c => c.state), [st], wo);
      assert.strictEqual(k.worktable.outcome, 'remains', wo);
      assert.ok(k.worktable.reasons.includes('live_campaign'), wo);
    }
  });
  await ok('임시저장 공고 오더 삭제 → 예측대로 남음 · 공고 그대로', async () => {
    const r = await del('wo_draft');
    assert.deepStrictEqual(r.body.kept.campaigns.map(c => c.state), ['draft']);
    assert.strictEqual(await tabExists(T3), true);
  });

  // 역방향 짝만 있는 공고(공고 쪽 source_work_order_id 없음 · 오더의 linked_campaign_id 로만 이어짐 · 다른 탭)
  const T6 = await mkTab('wt_rev', '역방향 작업', { empty: 1 });
  await mkCampaign({ id: 'camp_rev', title: '역방향으로만 이어진 공고', tab: { s: 'wt_other', t: '다른 탭' } });
  await mkOrder({ id: 'wo_rev', tab: T6, linkedCampaign: 'camp_rev' });
  await ok('역방향 짝 함정: 삭제 뒤 liveCampaignForWorkOrders 는 공고를 못 보지만 kept 는 계속 보인다', async () => {
    const { liveCampaignForWorkOrders } = require('../src/services/linkedRecruitQuota.service');
    assert.ok(await liveCampaignForWorkOrders(pool, ['wo_rev']), '삭제 전에는 역방향 짝으로 보인다');
    const r = await del('wo_rev');
    assert.strictEqual(await liveCampaignForWorkOrders(pool, ['wo_rev']), null, '삭제 뒤 역방향 짝이 끊긴다(함정 재현)');
    assert.deepStrictEqual(r.body.kept.campaigns.map(c => c.id), ['camp_rev']);
  });

  console.log('[4] 작업보드 예측 = 실제 정리 (돈 기록 · 스위치 · 작업보드 없음)');
  const T7 = await mkTab('wt_money', '입금 기록 작업');
  await mkOrder({ id: 'wo_money', tab: T7 });
  // 돈 기록 한 줄(미확인 이체 검토 — 확장 탓에 최소 모양으로 만든 표 · _moneyRows 는 작업 좌표로만 센다)
  await q(`INSERT INTO unconfirmed_transfer_reviews (sheet_id, tab_name) VALUES ($1,$2)`, [T7.s, T7.t]);
  await ok('돈 기록만 있는 빈 작업 → 남음(money_rows) · 실제 정리도 거부', async () => {
    const k = await preview('wo_money');
    assert.strictEqual(k.worktable.outcome, 'remains');
    assert.deepStrictEqual(k.worktable.reasons, ['money_rows']);
    await del('wo_money');
    assert.strictEqual(await tabExists(T7), true);
  });
  const T8 = await mkTab('wt_off', '스위치 꺼짐 작업');
  await mkOrder({ id: 'wo_off', tab: T8 });
  await ok('정리 스위치 꺼짐(INTAKE_DELETE_TAB_CLEANUP=0) → 남음(cleanup_off) · 실제로도 남음', async () => {
    process.env.INTAKE_DELETE_TAB_CLEANUP = '0';
    try {
      const k = await preview('wo_off');
      assert.deepStrictEqual([k.worktable.outcome, k.worktable.reasons], ['remains', ['cleanup_off']]);
      await del('wo_off');
      assert.strictEqual(await tabExists(T8), true);
    } finally { delete process.env.INTAKE_DELETE_TAB_CLEANUP; }
  });
  await mkOrder({ id: 'wo_none' });
  await ok('접수 전 오더(작업보드·공고 없음) → 남는 것 없음(known:true · outcome none)', async () => {
    const k = await preview('wo_none');
    assert.strictEqual(k.known, true);
    assert.deepStrictEqual(k.campaigns, []);
    assert.strictEqual(k.worktable.outcome, 'none');
    assert.strictEqual(k.worktable.will_remove, false);
  });
  // Track B 링크로만 이어진 작업 — 자동 정리 대상이 아니다(autoCleanup 은 직접 연결만 본다)
  const T9 = await mkTab('wt_link', '링크 작업');
  await mkOrder({ id: 'wo_link' });
  await q(`INSERT INTO trackb_work_order_links (sheet_id, tab_name, work_order_id) VALUES ($1,$2,'wo_link')`, [T9.s, T9.t]);
  await ok('Track B 링크로만 이어진 작업 → 남음(no_direct_tab) · 실제로도 남음', async () => {
    const k = await preview('wo_link');
    assert.deepStrictEqual([k.worktable.outcome, k.worktable.reasons, k.worktable.name], ['remains', ['no_direct_tab'], T9.t]);
    await del('wo_link');
    assert.strictEqual(await tabExists(T9), true);
  });

  console.log('[5] 조회 실패 = 확인하지 못함(「없음」으로 접지 않는다)');
  await ok('DB 오류 → known:false(check_failed) · campaigns 칸 자체가 없다', async () => {
    const k = await svc.orderDeleteImpact(async () => { throw new Error('boom'); }, 'wo_ceramo1');
    assert.deepStrictEqual(k, { known: false, reason: 'check_failed' });
  });
  await ok('중간 조회 하나만 실패해도 known:false(부분 결과를 「없음」처럼 내보내지 않는다)', async () => {
    const flaky = (t, p) => (/campaign_applications/.test(t) ? Promise.reject(new Error('x')) : q(t, p));
    assert.deepStrictEqual(await svc.orderDeleteImpact(flaky, 'wo_ceramo1'), { known: false, reason: 'check_failed' });
  });
  await ok('시간 초과 → known:false(timeout) · 기다리지 않고 돌아온다', async () => {
    const t0 = Date.now();
    const k = await svc.orderDeleteImpact(() => new Promise(() => {}), 'wo_ceramo1', { deadlineMs: 50 });
    assert.deepStrictEqual(k, { known: false, reason: 'timeout' });
    assert.ok(Date.now() - t0 < 1000);
  });
  await ok('없는 오더 → known:false(not_found) · 미리보기 주소는 404', async () => {
    assert.deepStrictEqual(await svc.orderDeleteImpact(q, 'wo_nope'), { known: false, reason: 'not_found' });
    assert.strictEqual((await call('get', '/intake/:id/delete-impact', { id: 'wo_nope', headers: H })).code, 404);
  });
  const T10 = await mkTab('wt_fail', '실패 작업');
  await mkOrder({ id: 'wo_fail', tab: T10 });
  await ok('삭제 응답: 영향 계산이 던져도 삭제는 성공(ok:true) · kept = known:false · 정리는 종전대로 응답 뒤', async () => {
    const orig = svc.orderDeleteImpact;
    svc.orderDeleteImpact = async () => { throw new Error('impact down'); };
    try {
      const r = await del('wo_fail');
      assert.strictEqual(r.body.ok, true);
      assert.deepStrictEqual(r.body.kept, { known: false, reason: 'check_failed' });
      assert.ok((await q(`SELECT deleted_at FROM work_orders WHERE id='wo_fail'`)).rows[0].deleted_at, '오더는 지워졌다');
      assert.deepStrictEqual(events, ['json', 'cleanup']);
    } finally { svc.orderDeleteImpact = orig; }
  });

  console.log('[6] 미리보기 주소 열쇠 = 헤더만');
  await ok('열쇠 미설정 503 · 틀린 헤더 401 · 주소 열쇠만 401 · 본문 열쇠만 401 · 헤더 200(쓰기 0)', async () => {
    const before = (await q(`SELECT deleted_at FROM work_orders WHERE id='wo_paused'`)).rows[0].deleted_at;
    delete process.env.ORDER_INTAKE_KEY;
    assert.strictEqual((await call('get', '/intake/:id/delete-impact', { id: 'wo_paused', headers: H })).code, 503);
    process.env.ORDER_INTAKE_KEY = KEY;
    assert.strictEqual((await call('get', '/intake/:id/delete-impact', { id: 'wo_paused', headers: { 'x-intake-key': 'wrong' } })).code, 401);
    assert.strictEqual((await call('get', '/intake/:id/delete-impact', { id: 'wo_paused', query: { intakeKey: KEY } })).code, 401);
    assert.strictEqual((await call('get', '/intake/:id/delete-impact', { id: 'wo_paused', body: { intakeKey: KEY } })).code, 401);
    const r = await call('get', '/intake/:id/delete-impact', { id: 'wo_paused', headers: H });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.deleted, false);
    assert.strictEqual((await q(`SELECT deleted_at FROM work_orders WHERE id='wo_paused'`)).rows[0].deleted_at, before, '미리보기는 아무것도 바꾸지 않는다');
    assert.strictEqual(await tabExists(T4), true);
  });
  await ok('정적: 미리보기 핸들러는 주소·본문 열쇠를 읽지 않고 시간 일정 비교(_intakeKeyMatches)만 · 영향 함수는 역방향 짝 함수를 쓰지 않는다', () => {
    const r = read('src/routes/order.routes.js');
    const at = r.indexOf("router.get('/intake/:id/delete-impact'");
    const h = r.slice(at, r.indexOf('\n});', at));
    assert.ok(h.length > 100);
    assert.ok(/_intakeKeyMatches\(req\.headers\['x-intake-key'\], expected\)/.test(h));
    assert.ok(!/req\.query\.intakeKey|b\.intakeKey|body\.intakeKey|req\.body/.test(h));
    const s = read('src/services/workTabDelete.service.js');
    const noComments = x => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const f = noComments(s.slice(s.indexOf('async function _orderDeleteImpactInner'), s.indexOf('async function orderDeleteImpact(')));
    assert.ok(f.length > 100 && !/liveCampaignForWorkOrders|linkedRecruitQuota/.test(f), '남는 공고는 직접 조회(역방향 짝 함수 금지)');
    const p = s.slice(s.indexOf('async function predictCleanup'), s.indexOf('async function _orderDeleteImpactInner'));
    assert.ok(/_untouchedReasons\(q, /.test(p) && /_moneyRows\(q, /.test(p), '예측 = 실제 정리와 같은 판정 함수');
    assert.ok(/INTAKE_DELETE_TAB_CLEANUP === '0'/.test(p), '같은 스위치');
  });

  console.log(`\n  ${passed} passed\n`);
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
