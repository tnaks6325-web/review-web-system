'use strict';
/**
 * r1QtyTiersPg.test.js — 결정 392(R1): 접수된 오더의 구매수량 단계를 「신청 0」일 때만 인트라넷 공유 저장으로 고친다.
 *   PGlite + 저장소 migrations 전부 + 실제 앱 라우트(원본 수정 PUT · /shared) + 실제 보관 해제 서비스. 시험 데이터는 모두 가짜 값.
 *
 *   [1] 성공 — 세라모사이드 모양(옵션 없는 상품 400명 → 235명 · 단계 1개 265→100명): 오더 상품 구성·결제합계·총모집·일건수 ·
 *       공고 단계 표 · 공고 총모집·일일 정원 · 작업표 활성 줄 수 · 원본 번호 +1 · 조절 이력 · 같은 저장 재시도 = 멱등
 *       + 처음 넣기 · 모두 빼기 · 옵션별 단계(빈 줄 옵션 표시 없음 → 옵션 인원 변경 통과)
 *   [2] 거절 갈래 — 코드·한국어 문구 · 원본 번호·오더·공고·단계 표·작업표·이력·스냅숏 모두 그대로(통째 되돌림)
 *   [3] /shared 판정 칸(qty_tiers_edit) — 옛 창 null · 새 창 판정 · 신청 생기면 막힘(저장과 같은 함수)
 *   [4] 보관 해제 게이트(Q8 ㉠)
 */
const assert = require('assert');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const F = require('./helpers/r1QtyTiersFixture');

let passed = 0, failed = 0;
// R1_TEST_CONTINUE=1 = 실패해도 다음 갈래를 계속(RED 증거를 갈래마다 남길 때만 · 기본은 첫 실패에서 멈춤)
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); if (process.env.R1_TEST_CONTINUE !== '1') throw e; failed++; console.log('    → ' + String(e.message).split('\n')[0].slice(0, 300)); } };

const OPT = (b = 5, w = 5, tiers = true) => ([{
  name: '탈취제', url: 'https://www.coupang.com/vp/products/77', option_schema_version: 2, product_mode: 'opt',
  base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
    { option_1: { name: '', value: '블랙' }, label: '블랙', url: '', pay: 15000, count: b, daily: 1, review_type_mix: [] },
    { option_1: { name: '', value: '화이트' }, label: '화이트', url: '', pay: 20000, count: w, daily: 1, review_type_mix: [] }],
  ...(tiers ? { qty_tiers: { mode: 'by_option', buy_method: 'qty', rows: [
    { option: '블랙', qty: 2, people: 2, amount: 30000 }, { option: '블랙', qty: 1, people: b - 2, amount: 15000 },
    { option: '화이트', qty: 2, people: 1, amount: 40000 }, { option: '화이트', qty: 1, people: w - 1, amount: 20000 }] } } : {}),
}]);

(async () => {
  const { pool } = await F.installPglitePool();
  const H = await F.boot({ pool });
  const { setup, tierEdit, call } = H;
  const r1Patch = async (A, fn) => tierEdit(await A.wo(), fn);
  /** 거절 공통 — 코드·문구 · 아무것도 안 바뀜(원본 번호 미증가 포함) */
  const rejects = async (A, patch, bid, code, re) => {
    const before = await A.snapshot();
    const r = await A.putSource(patch, bid);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code === 'campaign_rejected' ? r.body.reason : r.body.code, code, JSON.stringify(r.body));
    if (re) assert.match(r.body.error, re);
    assert.equal(await A.snapshot(), before, `${code}: 거절 뒤 오더·공고·단계 표·작업표·이력·원본 번호 그대로`);
    return r;
  };
  const SERA_EDIT = p => { p[0].base.count = 235; p[0].base.daily = 24; p[0].qty_tiers.rows[2].people = 100; };

  await ok('[1] 성공 — 400→235(세라모사이드 모양): 오더·공고 단계 표·작업표·결제합계·인원·일일 정원·원본 번호 +1·이력 · 재시도 멱등', async () => {
    const A = await setup('ok', F.SERAMO(400, F.T400));
    assert.equal(await A.rows(), 400);
    assert.deepEqual((await A.tiers()).map(t => t.slice(2, 5)), [[3, 30, 36000], [2, 105, 24000], [1, 265, 12000]]);
    const before = await A.wo();
    const patch = await r1Patch(A, SERA_EDIT);
    const r = await A.putSource(patch, { tiers: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok((r.body.campaign_applied || []).includes('qty_tiers'), JSON.stringify(r.body.campaign_applied));
    const w = await A.wo(); const c = await A.cRow();
    assert.equal(Number(w.source_revision), Number(before.source_revision) + 1, '원본 번호 정확히 +1');
    assert.equal(Number(w.recruit_count), 235); assert.equal(Number(w.daily_count), 24);
    assert.equal(Number(w.pay_amount), F.payOf(F.T235), '결제합계 = 인트라넷이 계산해 보낸 단계 합계');
    const p = JSON.parse(w.product_options_json)[0];
    assert.equal(p.base.count, 235);
    assert.deepEqual(p.qty_tiers.rows.map(x => [x.qty, x.people, x.amount]), F.T235);
    assert.deepEqual(await A.tiers(), F.T235.map(([q, pe, a]) => ['세라모사이드', null, q, pe, a, 'qty']), '공고 단계 표 다시 씀(상품 공통)');
    assert.equal(Number(c.recruit_total), 235, '공고 총모집'); assert.equal(Number(c.daily_limit), 24, '공고 일일 정원');
    assert.equal(await A.rows(), 235, '작업표 활성 줄 235');
    const ev = (await A.events()).filter(e => e.action === 'qty_tiers_changed');
    assert.equal(ev.length, 1, '조절 이력 1줄');
    assert.equal(ev[0].detail.total_before, 400); assert.equal(ev[0].detail.total_after, 235);
    assert.equal(ev[0].detail.after.length, 3); assert.equal(ev[0].detail.before[2].people, 265);
    // 같은 저장 재시도(같은 원본 번호·열쇠) = 멱등 — 아무것도 다시 쓰지 않는다
    const snap = await A.snapshot();
    const again = await call('PUT', `/api/order/intake/source/${A.sid}`, { ...A.payload, source_revision: Number(w.source_revision), idempotency_key: w.intake_idempotency_key,
      ...patch, bidir: { base_sync_version: Number(before.sync_version), op_id: 'x', money: 1, counts: 1, tiers: 1 } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(await A.snapshot(), snap, '재시도 = 변화 0');
  });

  await ok('[1b] 처음 넣기(단계 없음 → 3단계) · [1c] 모두 빼기(→ 단계 없음) — 공고 단계 표·결제합계 따라감', async () => {
    const A = await setup('add', F.SERAMO(400, null));
    assert.deepEqual(await A.tiers(), []);
    let r = await A.putSource(await r1Patch(A, p => { p[0].qty_tiers = { mode: 'common', buy_method: 'qty', rows: F.T400.map(([qty, people, amount]) => ({ option: null, qty, people, amount })) }; }), { tiers: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await A.tiers()).map(t => t.slice(2, 5)), F.T400);
    assert.equal(Number((await A.wo()).pay_amount), F.payOf(F.T400));
    r = await A.putSource(await r1Patch(A, p => { delete p[0].qty_tiers; }), { tiers: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await A.tiers(), [], '공고 단계 표 비움');
    assert.equal(JSON.parse((await A.wo()).product_options_json)[0].qty_tiers, undefined, '오더 단계 키 지움(표준형)');
    assert.equal(Number((await A.wo()).pay_amount), 12000 * 400, '결제합계 = 1개 금액 × 인원');
    assert.equal((await A.events()).filter(e => e.action === 'qty_tiers_changed').length, 2);
  });

  await ok('[1d] 옵션별 단계 — 금액만 · 옵션 인원 변경(작업보드 빈 줄에 옵션 표시 없음 = 통과): 공고 옵션 인원·단계 표', async () => {
    const A = await setup('opt', OPT());
    assert.equal((await A.tiers()).length, 4);
    let r = await A.putSource(await r1Patch(A, p => { p[0].qty_tiers.rows[0].amount = 31000; }), { tiers: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await A.tiers())[0], ['탈취제', '블랙', 2, 2, 31000, 'qty']);
    r = await A.putSource(await r1Patch(A, p => { p[0].options[0].count = 6; p[0].options[1].count = 4; p[0].qty_tiers.rows[1].people = 4; p[0].qty_tiers.rows[3].people = 3; }), { tiers: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const o = await A.opts();
    assert.deepEqual(o.map(x => [x.opt_key, Number(x.recruit_total)]), [['블랙', 6], ['화이트', 4]]);
    assert.deepEqual((await A.tiers()).map(t => [t[1], t[2], t[3]]), [['블랙', 2, 2], ['블랙', 1, 4], ['화이트', 2, 1], ['화이트', 1, 3]]);
    assert.equal(await A.rows(), 10);
  });

  await ok('[2a] 옛 창(bidir.tiers 없음) — 종전 409 quantity_tiers_locked + 새 리뷰오더 문구 그대로', async () => {
    const A = await setup('old', F.SERAMO(400, F.T400));
    await rejects(A, await r1Patch(A, SERA_EDIT), {}, 'quantity_tiers_locked', /접수된 리뷰오더라 구매수량 단계\(개수·인원·금액\)를 바꿀 수 없습니다[\s\S]*새 리뷰오더로 접수해 주세요/);
  });

  await ok('[2b] 신청 1(취소) — quantity_tiers_in_use · 「1명」 · [2c] 같은 작업보드의 보관된 옛 공고 만료 신청(254 범위 · Q3)', async () => {
    const A = await setup('used', F.SERAMO(400, F.T400));
    await pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status) VALUES ($1, '가짜신청', '70000001', 'cancelled')`, [A.camp]);
    await rejects(A, await r1Patch(A, SERA_EDIT), { tiers: 1 }, 'quantity_tiers_in_use', /이미 신청한 분이 1명 있어\(취소·만료 포함\)/);
    const B = await setup('oldcamp', F.SERAMO(400, F.T400));
    await pool.query(`INSERT INTO recruit_campaigns (id, title, status, participation_mode, linked_sheet_id, linked_tab_name, archived_at) VALUES ($1, '옛 공고', 'closed', TRUE, $2, $3, NOW())`, [B.camp + '_old', B.sheet, B.tab]);
    await pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status) VALUES ($1, '가짜신청', '70000002', 'expired')`, [B.camp + '_old']);
    await rejects(B, await r1Patch(B, SERA_EDIT), { tiers: 1 }, 'quantity_tiers_in_use', /1명/);
  });

  await ok('[2d] 작업보드 채운 줄 1 — worktable_filled', async () => {
    const A = await setup('filled', F.SERAMO(400, F.T400));
    await pool.query(`UPDATE campaign_participants SET reviewer_name = '가짜이름' WHERE sheet_id = $1 AND tab_name = $2 AND seq = 7`, [A.sheet, A.tab]);
    await rejects(A, await r1Patch(A, SERA_EDIT), { tiers: 1 }, 'worktable_filled', /채운|주문·이름이 들어간 줄이 1개/);
  });

  await ok('[2e] 블로그 체험단 — kind_no_tiers', async () => {
    const A = await setup('blog', F.SERAMO(400, F.T400), { workKind: 'blog' });
    await rejects(A, await r1Patch(A, SERA_EDIT), { tiers: 1 }, 'kind_no_tiers', /블로그·Q&A 체험단은 구매수량 단계를 쓰지 않습니다/);
  });

  await ok('[2f] J1 — 창을 연 뒤 리뷰웹 상품 구성이 바뀜 → quantity_tiers_stale_base', async () => {
    const A = await setup('stale', F.SERAMO(400, F.T400));
    const cur = await A.wo();
    const pj = JSON.parse(cur.product_options_json); pj[0].url = 'https://smartstore.naver.com/x/products/999';
    await pool.query('UPDATE work_orders SET product_options_json = $2 WHERE id = $1', [cur.id, JSON.stringify(pj)]);   // 리뷰웹 쪽 변경(기준 스냅숏은 그대로)
    await rejects(A, await r1Patch(A, SERA_EDIT), { tiers: 1 }, 'quantity_tiers_stale_base', /수정 창을 연 뒤 리뷰웹에서 상품 구성이 바뀌어/);
  });

  await ok('[2g] P9 — 단계 + 상품 더하기 한 저장 → quantity_tiers_with_structure', async () => {
    const A = await setup('p9', F.SERAMO(400, F.T400));
    const patch = await r1Patch(A, p => { SERA_EDIT(p); p.push({ name: '덤', url: '', option_schema_version: 2, product_mode: 'none', base: { pay: 1000, count: 5, daily: 1, review_type_mix: [] }, options: [] }); });
    await rejects(A, patch, { tiers: 1, structure: 1 }, 'quantity_tiers_with_structure', /따로 저장해 주세요/);
  });

  await ok('[2h] 결제합계 없이 단계만 → quantity_tiers_pay_missing', async () => {
    const A = await setup('nopay', F.SERAMO(400, F.T400));
    await rejects(A, { ...(await r1Patch(A, SERA_EDIT)), pay_amount: '' }, { tiers: 1 }, 'quantity_tiers_pay_missing', /결제합계가 함께 오지 않아/);
  });

  await ok('[2i] 보관 공고만 → quantity_tiers_archived · 공고 없음 → no_campaign', async () => {
    const A = await setup('arch', F.SERAMO(400, F.T400));
    await pool.query('UPDATE recruit_campaigns SET archived_at = NOW() WHERE id = $1', [A.camp]);
    await rejects(A, await r1Patch(A, SERA_EDIT), { tiers: 1 }, 'quantity_tiers_archived', /보관돼 있어/);
    const B = await setup('nocamp', F.SERAMO(400, F.T400));
    await pool.query('DELETE FROM campaign_qty_tiers WHERE campaign_id = $1', [B.camp]);
    await pool.query('DELETE FROM recruit_campaigns WHERE id = $1', [B.camp]);
    await rejects(B, await r1Patch(B, SERA_EDIT), { tiers: 1 }, 'no_campaign', /아직 모집공고가 없는 오더/);
  });

  await ok('[2j] 같은 작업보드에 살아 있는 공고 2 → shared_worktable · [2k] 차수 → rounds_exist', async () => {
    const A = await setup('shared', F.SERAMO(400, F.T400));
    await pool.query(`INSERT INTO recruit_campaigns (id, title, status, participation_mode, linked_sheet_id, linked_tab_name) VALUES ($1, '둘째 공고', 'active', TRUE, $2, $3)`, [A.camp + '_2', A.sheet, A.tab]);
    await rejects(A, await r1Patch(A, SERA_EDIT), { tiers: 1 }, 'shared_worktable', /여럿이라/);
    const B = await setup('rounds', F.SERAMO(400, F.T400));
    await pool.query(`INSERT INTO campaign_rounds (campaign_id, round_no, slot_count) VALUES ($1, 1, 400)`, [B.camp]);
    await rejects(B, await r1Patch(B, SERA_EDIT), { tiers: 1 }, 'rounds_exist', /차수로 운영하는/);
  });

  await ok('[2l] 임시 — 빈 줄에 옵션 표시 2종인 작업보드 + 옵션 인원 변경 → quantity_tiers_option_counts(금액만은 통과)', async () => {
    const A = await setup('optlab', OPT());
    await pool.query(`UPDATE campaign_participants SET option_text = CASE WHEN seq <= 5 THEN '블랙' ELSE '화이트' END WHERE sheet_id = $1 AND tab_name = $2`, [A.sheet, A.tab]);
    await rejects(A, await r1Patch(A, p => { p[0].options[0].count = 6; p[0].options[1].count = 4; p[0].qty_tiers.rows[1].people = 4; p[0].qty_tiers.rows[3].people = 3; }),
      { tiers: 1 }, 'quantity_tiers_option_counts', /옵션별 인원을 함께 바꿀 수 없습니다/);
    const r = await A.putSource(await r1Patch(A, p => { p[0].qty_tiers.rows[2].amount = 41000; }), { tiers: 1 });
    assert.equal(r.status, 200, '옵션 인원 그대로면 통과 ' + JSON.stringify(r.body));
  });

  await ok('[2m] 리뷰타입 섞어 쓰기 작업 + 옵션 인원 변경 → option_rows_review_mix', async () => {
    const A = await setup('mix', OPT(), { reviewType: '혼합', extra: { review_type_mix: [{ type: 'photo', quantity: 6 }, { type: 'text', quantity: 4 }] } });
    await rejects(A, await r1Patch(A, p => { p[0].options[0].count = 6; p[0].options[1].count = 4; p[0].qty_tiers.rows[1].people = 4; p[0].qty_tiers.rows[3].people = 3; }),
      { tiers: 1 }, 'option_rows_review_mix', /리뷰타입\(포토·텍스트\) 수량을 섞어 쓰는 작업/);
  });

  await ok('[2n] 짝 못 지은 창(skip_products) — 상품 칸 고침 표시 409 · 단계 다름 409 · 안 고침 = 종전 200(상품 구성 무시)', async () => {
    const A = await setup('skip', F.SERAMO(400, F.T400));
    await rejects(A, { title: '가짜 제목 바꿈' }, { tiers: 1, skip_products: 1, products_edited: 1 }, 'products_unmatched_edit', /짝을 못 지어 상품 칸 수정을 보낼 수 없습니다/);
    await rejects(A, await r1Patch(A, SERA_EDIT), { skip_products: 1 }, 'quantity_tiers_unmatched_window', /짝을 못 지은 창이라 구매수량 단계를 바꿀 수 없습니다/);
    const pj = (await A.wo()).product_options_json;
    const r = await A.putSource({ title: '가짜 제목 바꿈 2', pay_amount: 1 }, { skip_products: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await A.wo()).product_options_json, pj, '상품 구성은 그대로(종전)');
    assert.equal(Number((await A.wo()).pay_amount), F.payOf(F.T400), '보낸 합계도 무시(종전 · 2026-10-20)');
  });

  await ok('[2o] 단계 기능 스위치 꺼짐(CAMPAIGN_QTY_TIERS=0) → quantity_tiers_off', async () => {
    const A = await setup('off', F.SERAMO(400, F.T400));
    process.env.CAMPAIGN_QTY_TIERS = '0';
    try { await rejects(A, await r1Patch(A, SERA_EDIT), { tiers: 1 }, 'quantity_tiers_off', /기능이 꺼져/); }
    finally { delete process.env.CAMPAIGN_QTY_TIERS; }
  });

  await ok('[3] /shared — 옛 창 qty_tiers_edit=null · 새 창 판정(허용 · 구조 잠김 안내) · 신청 생기면 막힘 + 숫자', async () => {
    const A = await setup('shared_view', F.SERAMO(400, null));
    let s = await call('GET', `/api/order/intake/source/${A.sid}/shared?caps=delivery,manager`);
    assert.equal(s.status, 200); assert.equal(s.body.qty_tiers_edit, null, '옛 창 = 칸 없음'); assert.equal(s.body.capabilities.tiers, true);
    s = await call('GET', `/api/order/intake/source/${A.sid}/shared?caps=delivery,manager,tiers`);
    assert.equal(s.body.qty_tiers_edit.allowed, true, JSON.stringify(s.body.qty_tiers_edit));
    assert.equal(s.body.qty_tiers_edit.locks_structure, true, '단계를 처음 넣으면 구조가 잠긴다 → 확인창');
    assert.equal(s.body.qty_tiers_edit.applicants, 0); assert.ok(s.body.kind_change, '종류 변경 판정 칸 그대로');
    await pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status) VALUES ($1, '가짜신청', '70000009', 'applied')`, [A.camp]);
    s = await call('GET', `/api/order/intake/source/${A.sid}/shared?caps=tiers`);
    assert.equal(s.body.qty_tiers_edit.allowed, false); assert.deepEqual(s.body.qty_tiers_edit.reasons, ['quantity_tiers_in_use']); assert.equal(s.body.qty_tiers_edit.applicants, 1);
  });

  await ok('[4] 보관 해제(Q8 ㉠) — 같음 = 해제 · 오더 단계 바뀜 = unarchive_tiers_changed · 단계 꺼진 동안 만든 공고 = 막힘 · 블로그 = 비교 안 함 · 살아 있는 공고 거절이 먼저', async () => {
    const arch = require('../src/services/campaignArchive.service');
    const A = await setup('ua_same', F.SERAMO(400, F.T400));
    await pool.query('UPDATE recruit_campaigns SET archived_at = NOW() WHERE id = $1', [A.camp]);
    let r = await arch.unarchiveCampaign(pool, A.camp);
    assert.equal(r.ok, true, JSON.stringify(r));
    const B = await setup('ua_changed', F.SERAMO(400, F.T400));
    await pool.query('UPDATE recruit_campaigns SET archived_at = NOW() WHERE id = $1', [B.camp]);
    const pj = JSON.parse((await B.wo()).product_options_json); pj[0].qty_tiers.rows[0].amount = 35000;
    await pool.query('UPDATE work_orders SET product_options_json = $2 WHERE id = $1', [B.w.id, JSON.stringify(pj)]);
    r = await arch.unarchiveCampaign(pool, B.camp);
    assert.equal(r.code, 'unarchive_tiers_changed', JSON.stringify(r)); assert.match(r.error, /새 공고를 발행해 주세요/);
    assert.ok((await B.cRow()).archived_at, '보관 그대로');
    const C = await setup('ua_notable', F.SERAMO(400, F.T400));
    await pool.query('DELETE FROM campaign_qty_tiers WHERE campaign_id = $1', [C.camp]);   // 단계 기능을 끈 동안 만든 공고 모양
    await pool.query('UPDATE recruit_campaigns SET archived_at = NOW() WHERE id = $1', [C.camp]);
    r = await arch.unarchiveCampaign(pool, C.camp);
    assert.equal(r.code, 'unarchive_tiers_changed', JSON.stringify(r));
    const D = await setup('ua_blog', F.SERAMO(400, F.T400), { workKind: 'blog' });
    await pool.query('UPDATE recruit_campaigns SET archived_at = NOW() WHERE id = $1', [D.camp]);
    r = await arch.unarchiveCampaign(pool, D.camp);
    assert.equal(r.ok, true, '블로그 공고는 비교하지 않는다 ' + JSON.stringify(r));
    const E = await setup('ua_live', F.SERAMO(400, F.T400));
    await pool.query('DELETE FROM campaign_qty_tiers WHERE campaign_id = $1', [E.camp]);
    await pool.query('UPDATE recruit_campaigns SET archived_at = NOW() WHERE id = $1', [E.camp]);
    await pool.query(`INSERT INTO recruit_campaigns (id, title, source_work_order_id, status, participation_mode) VALUES ($1, '새 공고', $2, 'active', TRUE)`, [E.camp + '_new', E.w.id]);
    r = await arch.unarchiveCampaign(pool, E.camp);
    assert.equal(r.code, 'work_order_campaign_exists', '종전 거절이 먼저 ' + JSON.stringify(r));
  });

  console.log(`r1QtyTiersPg: ${passed} passed${failed ? `, ${failed} failed` : ''}`);
  await H.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
