'use strict';
/**
 * optionSlotsRebalancePg.test.js — 결정 394(RW-A2 · RW-D): 양방향 공유 저장에서 선택지별 인원이 바뀌면
 *   작업보드 「손 안 댄 빈 줄」의 옵션 표시를 새 인원에 맞춰 다시 나눈다 · 맞출 수 없으면 통째 건너뛰고 저장은 성공 + 응답 결과 칸.
 *   PGlite + 저장소 migrations 전부 + 실제 앱(인트라넷 원본 수정 PUT) + 실제 주문 기록 함수(writeOrderToWorktable — 주문 왕복).
 *   시험 데이터는 모두 가짜 값.
 */
const assert = require('assert');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const F = require('./helpers/r1QtyTiersFixture');

let passed = 0, failed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); if (process.env.RB_TEST_CONTINUE !== '1') throw e; failed++; console.log('    → ' + String(e.message).split('\n')[0].slice(0, 400)); } };

const OPTP = (name, opts, { tiers = null, url = 'https://www.coupang.com/vp/products/501' } = {}) => ([{
  name, url, option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] },
  options: opts.map(([v, count, pay = 10000, daily = 1, mix = []]) => ({ option_1: { name: '', value: v }, label: v, url: '', pay, count, daily, review_type_mix: mix })),
  ...(tiers ? { qty_tiers: tiers } : {}),
}]);
const PRODS = list => list.map(([name, count, pay = 10000], i) => ({ name, url: `https://www.coupang.com/vp/products/6${i}`, option_schema_version: 2, product_mode: 'none',
  base: { pay, count, daily: 1, review_type_mix: [] }, options: [] }));
const js = v => String(JSON.stringify(v));
const BANNED = /없습니다|실패|초과|불가|오류/;
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const dayLabel = i => { const d = new Date(Date.UTC(2026, 11, 1 + i)); return `${d.getUTCMonth() + 1} / ${d.getUTCDate()} (${WD[d.getUTCDay()]})`; };

(async () => {
  const { pool } = await F.installPglitePool();
  const H = await F.boot({ pool });
  const { setup, tierEdit } = H;
  const so = require('../src/services/sheetlessOrder.service');
  so.__setPoolForTest(pool);

  /** 작업표 줄을 계획처럼 칠한다 — spec(seq) → { label, product, option } (option = 「옵션」 칸 · product = 「상품」 칸) · 하루 2줄 날짜 */
  const paint = async (A, spec) => {
    const { rows } = await pool.query('SELECT id, seq FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active ORDER BY seq', [A.sheet, A.tab]);
    for (const r of rows) {
      const s = spec(Number(r.seq)) || {};
      const rj = { 번호: String(r.seq), 구매일자: dayLabel(Math.floor((Number(r.seq) - 1) / 2)), 상품: s.product || '', 옵션: s.option == null ? (s.label || '') : s.option, 수취인: '', 연락처: '', 주문번호: '', 리뷰옵션: s.rv || '' };
      await pool.query('UPDATE campaign_participants SET option_text=$2, row_json=$3::jsonb WHERE id=$1', [r.id, s.label || null, JSON.stringify(rj)]);
    }
  };
  const rowsOf = async A => (await pool.query('SELECT id, seq, option_text, row_json, reviewer_name, order_submission_id FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active ORDER BY seq', [A.sheet, A.tab])).rows;
  const emptyCounts = async A => { const m = {}; for (const r of await rowsOf(A)) if (!r.reviewer_name && !r.order_submission_id) { const k = String(r.option_text || '').trim(); m[k] = (m[k] || 0) + 1; } return m; };
  const labelsBySeq = async A => Object.fromEntries((await rowsOf(A)).map(r => [Number(r.seq), String(r.option_text || '')]));
  /** 일반 인원 저장(단계 안 바꿈) — 인트라넷 화면처럼 총모집·일건수·결제합계·요약을 같이 */
  const save = async (A, fn, bid = {}) => A.putSource(tierEdit(await A.wo(), fn), bid);
  const okSave = async (A, fn, bid) => { const r = await save(A, fn, bid); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const notice = b => { assert.ok(b.option_slots && b.option_slots.notice, '안내 문구 ' + js(b.option_slots)); assert.doesNotMatch(b.option_slots.notice, BANNED, '알림 색을 바꾸는 낱말 금지'); };
  const optByKey = (b, k) => (b.option_slots.options || []).find(o => o.option === k);
  /** 실제 주문 기록(바로 구매 · 옵션/상품 지정) — 기록된 줄을 돌려준다 */
  let osn = 0;
  const purchase = async (A, { optKey = '', product = '' } = {}) => {
    osn += 1;
    const { rows } = await pool.query(`INSERT INTO order_submissions (sheet_id, tab_name, recipient, orderer, phone, price, order_num, mirror_status, source, selected_opt_key, selected_product)
      VALUES ($1, $2, '가짜구매', '가짜구매', $3, '10000', $4, 'queued', 'order_submit', $5, $6) RETURNING id`, [A.sheet, A.tab, `010-7300-${String(1000 + osn)}`, `RB${osn}${Date.now()}`, optKey || null, product || '']);
    const w = await so.writeOrderToWorktable({ sheetId: A.sheet, tabName: A.tab, orderSubmissionId: rows[0].id,
      orderData: { recipient: '가짜구매', orderer: '가짜구매', phone: `010-7300-${String(1000 + osn)}`, price: '10000', orderNum: `RB${osn}`, selectedOptKey: optKey, selectedProduct: product } });
    const { rows: got } = await pool.query('SELECT seq, option_text, row_json FROM campaign_participants WHERE order_submission_id=$1 AND deleted_at IS NULL', [rows[0].id]);
    return { w, row: got[0] };
  };

  await ok('[1] 옵션 단위 — 티셔츠(블루/라지 · 상품명≠옵션명) 5/5 → 7/3: 빈 줄 표시 7/3 · 옵션 칸 같이 · 상품 칸 그대로 · 날짜 고루 · 주문 왕복', async () => {
    const A = await setup('tee', OPTP('티셔츠', [['블루', 5], ['라지', 5]]));
    await paint(A, s => { const l = s % 2 ? '블루' : '라지'; return { label: l, product: '티셔츠' }; });
    const b = await okSave(A, p => { p[0].options[0].count = 7; p[0].options[1].count = 3; });
    assert.equal(b.option_slots && b.option_slots.status, 'applied', js(b.option_slots));
    assert.equal(b.option_slots.moved, 2);
    assert.deepEqual(await emptyCounts(A), { 블루: 7, 라지: 3 });
    const rs = await rowsOf(A);
    for (const r of rs) { assert.equal(r.row_json.옵션, r.option_text, `옵션 칸 = 표시 (seq ${r.seq})`); assert.equal(r.row_json.상품, '티셔츠', '상품 칸 그대로'); }
    const was = s => (s % 2 ? '블루' : '라지');
    const moved = rs.filter(r => r.option_text !== was(Number(r.seq))).map(r => Number(r.seq));
    assert.equal(moved.length, 2);
    assert.ok(Math.min(...moved) <= 5, '옮긴 줄이 뒤 날짜에 몰리지 않는다 ' + moved.join(','));
    assert.equal(optByKey(b, '블루').target, 7);
    const ev = (await A.events()).filter(e => e.action === 'option_slots_rebalance');
    assert.equal(ev.length, 1, '공고 계획 기록 1줄'); assert.equal(ev[0].detail.status, 'applied');
    const pr = await purchase(A, { optKey: '라지' });
    assert.equal(pr.w.ok, true, JSON.stringify(pr.w)); assert.equal(pr.row.option_text, '라지');
    assert.equal(await A.rows(), 10, '정원 밖 새 줄 0');
  });

  await ok('[2] 상품 단위 포함 관계 — 표시 「고등어 2팩 세트」↔ 상품 「고등어」: 5/5 → 7/3 · 상품 칸도 새 표시 · 주문 왕복', async () => {
    const A = await setup('fish', PRODS([['고등어', 5], ['옥돔', 5, 20000]]));
    await paint(A, s => { const l = s % 2 ? '고등어 2팩 세트' : '옥돔 1kg'; return { label: l, product: l, option: '' }; });
    const b = await okSave(A, p => { p[0].base.count = 7; p[1].base.count = 3; });
    assert.equal(b.option_slots && b.option_slots.status, 'applied', js(b.option_slots));
    assert.deepEqual(await emptyCounts(A), { '고등어 2팩 세트': 7, '옥돔 1kg': 3 });
    for (const r of await rowsOf(A)) assert.equal(r.row_json.상품, r.option_text, `상품 칸 = 표시(계획 상품 칸만 남는 모양 금지) seq ${r.seq}`);
    const pr = await purchase(A, { product: '고등어' });
    assert.equal(pr.w.ok, true, JSON.stringify(pr.w)); assert.equal(pr.row.option_text, '고등어 2팩 세트');
    assert.equal(await A.rows(), 10);
  });

  await ok('[3] 세라모사이드(피치/레몬/스트로베리) 30줄 10/10/10 → 4/16/10 — 총원 같음: 다시 나눔 + 장부 다시 만들기·날짜 재배치(H5)', async () => {
    const A = await setup('cera', OPTP('세라모사이드', [['피치', 10], ['레몬', 10], ['스트로베리', 10]]));
    const L = ['피치', '레몬', '스트로베리'];
    await paint(A, s => ({ label: L[(s - 1) % 3], product: '세라모사이드' }));
    const b = await okSave(A, p => { p[0].options[0].count = 4; p[0].options[1].count = 16; });
    assert.equal(b.option_slots && b.option_slots.status, 'applied', js(b.option_slots));
    assert.equal(b.option_slots.moved, 6);
    assert.deepEqual(await emptyCounts(A), { 피치: 4, 레몬: 16, 스트로베리: 10 });
    assert.ok((b.campaign_applied || []).includes('option_slots'), JSON.stringify(b.campaign_applied));
    const { rows: led } = await pool.query(`SELECT COUNT(*)::int n FROM raw_sheet_rows WHERE sheet_id=$1 AND tab_name=$2`, [A.sheet, A.tab]);
    assert.ok(led[0].n > 0, '총원이 같아도 장부를 다시 만든다(force)');
  });

  await ok('[4] 리뷰타입 섞어 쓰기 — 모든 빈 줄이 표시를 가질 수 있으면 다시 나누고 리뷰옵션 재분배 · 표시 못 붙이는 줄(메모 달린 표시 없는 빈 줄)이 있으면 건너뜀(저장은 됨)', async () => {
    const A = await setup('mix', OPTP('티셔츠', [['블루', 5], ['라지', 5]]), { reviewType: '혼합', extra: { review_type_mix: [{ type: 'photo', quantity: 6 }, { type: 'text', quantity: 4 }] } });
    await paint(A, s => ({ label: s % 2 ? '블루' : '라지', product: '티셔츠' }));
    let b = await okSave(A, p => { p[0].options[0].count = 6; p[0].options[1].count = 4; });
    assert.equal(b.option_slots && b.option_slots.status, 'applied', js(b.option_slots));
    assert.deepEqual(await emptyCounts(A), { 블루: 6, 라지: 4 });
    const rv = {}; for (const r of await rowsOf(A)) { const v = String(r.row_json.리뷰옵션 || ''); rv[v] = (rv[v] || 0) + 1; }
    assert.deepEqual(Object.values(rv).sort(), [4, 6], '바로 뒤 리뷰옵션 재분배가 6/4 로 맞춤 ' + JSON.stringify(rv));
    const B = await setup('mix2', OPTP('티셔츠', [['블루', 5], ['라지', 5]]), { reviewType: '혼합', extra: { review_type_mix: [{ type: 'photo', quantity: 6 }, { type: 'text', quantity: 4 }] } });
    await paint(B, s => (s === 10 ? { product: '티셔츠' } : { label: s % 2 ? '블루' : '라지', product: '티셔츠' }));
    const id10 = (await rowsOf(B)).find(r => Number(r.seq) === 10).id;
    await pool.query(`INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_text, created_by) VALUES ($1,$2,'manual',$3,'memo','text','가짜 메모','시험')`, [B.sheet, B.tab, String(id10)]);
    const before = await labelsBySeq(B);
    b = await okSave(B, p => { p[0].options[0].count = 6; p[0].options[1].count = 4; });
    assert.equal(b.option_slots && b.option_slots.status, 'skipped', js(b.option_slots));
    assert.equal(b.option_slots.reason, 'label_unmatched');
    notice(b);
    assert.deepEqual(await labelsBySeq(B), before, '건너뛰면 줄 표시 그대로');
    assert.deepEqual((await B.opts()).map(x => [x.opt_key, Number(x.recruit_total)]), [['블루', 6], ['라지', 4]], '저장은 됨');
    assert.equal((await B.events()).filter(e => e.action === 'option_slots_rebalance' && e.detail.status === 'skipped').length, 1);
  });

  await ok('[5] 채운 줄 > 새 인원 — 블루 채운 줄 4 → 블루 3 으로: 건너뜀 over_target(숫자) · 저장은 됨 · 표시 그대로', async () => {
    const A = await setup('over', OPTP('티셔츠', [['블루', 5], ['라지', 5]]));
    await paint(A, s => ({ label: s % 2 ? '블루' : '라지', product: '티셔츠' }));
    await pool.query(`UPDATE campaign_participants SET reviewer_name='가짜채움' WHERE sheet_id=$1 AND tab_name=$2 AND seq IN (1,3,5,7)`, [A.sheet, A.tab]);
    const before = await labelsBySeq(A);
    const b = await okSave(A, p => { p[0].options[0].count = 3; p[0].options[1].count = 7; });
    assert.equal(b.option_slots && b.option_slots.status, 'skipped', js(b.option_slots));
    assert.equal(b.option_slots.reason, 'over_target');
    assert.equal(optByKey(b, '블루').filled, 4); assert.equal(optByKey(b, '블루').target, 3);
    notice(b); assert.match(b.option_slots.notice, /블루/);
    assert.deepEqual(await labelsBySeq(A), before);
  });

  await ok('[6] 표시 없는 줄 섞임 — 블루 3 · 라지 3 · 표시 없음 4 → 6/4: 모든 빈 줄에 표시', async () => {
    const A = await setup('blank', OPTP('티셔츠', [['블루', 5], ['라지', 5]]));
    await paint(A, s => (s <= 6 ? { label: s % 2 ? '블루' : '라지', product: '티셔츠' } : {}));
    const b = await okSave(A, p => { p[0].options[0].count = 6; p[0].options[1].count = 4; });
    assert.equal(b.option_slots && b.option_slots.status, 'applied', js(b.option_slots));
    assert.deepEqual(await emptyCounts(A), { 블루: 6, 라지: 4 });
    for (const r of await rowsOf(A)) if (Number(r.seq) > 6) assert.equal(r.row_json.상품, '', '표시 없던 줄의 빈 상품 칸은 빈 칸 그대로(blank-only)');
  });

  await ok('[7] 표시 1종류만 — 10줄 모두 블랙 → 6/4: 화이트 표시는 주문이 적는 값(opt_key) · 옵션 칸 같이 · 주문 왕복', async () => {
    const A = await setup('one', OPTP('탈취제', [['블랙', 5], ['화이트', 5]]));
    await paint(A, () => ({ label: '블랙', product: '탈취제' }));
    const b = await okSave(A, p => { p[0].options[0].count = 6; p[0].options[1].count = 4; });
    assert.equal(b.option_slots && b.option_slots.status, 'applied', js(b.option_slots));
    assert.deepEqual(await emptyCounts(A), { 블랙: 6, 화이트: 4 });
    for (const r of await rowsOf(A)) assert.equal(r.row_json.옵션, r.option_text);
    const pr = await purchase(A, { optKey: '화이트' });
    assert.equal(pr.row.option_text, '화이트'); assert.equal(await A.rows(), 10);
  });

  await ok('[8] 사람 기록 달린 빈 줄은 안 옮긴다 — 메모·셀 색·추가 열·입금 표시·row_json 사람 칸(비고) 달린 라지 줄 그대로, 다른 라지 줄이 옮겨짐', async () => {
    const A = await setup('human', OPTP('티셔츠', [['블루', 5], ['라지', 5]]));
    await paint(A, s => ({ label: s % 2 ? '블루' : '라지', product: '티셔츠' }));
    const id = async s => String((await rowsOf(A)).find(r => Number(r.seq) === s).id);
    await pool.query(`INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_text, created_by) VALUES ($1,$2,'manual',$3,'memo','text','가짜 메모','시험')`, [A.sheet, A.tab, await id(2)]);
    await pool.query(`INSERT INTO trackb_cell_colors (sheet_id, tab_name, anchor_type, anchor_value, field, color, created_by) VALUES ($1,$2,'manual',$3,'col:옵션','#ffff00','시험')`, [A.sheet, A.tab, await id(4)]);
    const b = await okSave(A, p => { p[0].options[0].count = 8; p[0].options[1].count = 2; });
    assert.equal(b.option_slots && b.option_slots.status, 'applied', js(b.option_slots));
    const L = await labelsBySeq(A);
    assert.equal(L[2], '라지', '메모 달린 줄 그대로'); assert.equal(L[4], '라지', '셀 색 달린 줄 그대로');
    assert.deepEqual(await emptyCounts(A), { 블루: 8, 라지: 2 });
    // 같은 작업에서 한 번 더: 비고 칸(사람이 직접 쓴 칸)이 달린 줄 + 입금 표시 줄도 고정
    await pool.query(`UPDATE campaign_participants SET row_json = row_json || '{"비고":"가짜 직접 메모"}'::jsonb WHERE sheet_id=$1 AND tab_name=$2 AND seq=1`, [A.sheet, A.tab]);
    const { rows: pb } = await pool.query(`INSERT INTO payment_batches (bank, created_by) VALUES ('kbank', '시험') RETURNING id`);
    await pool.query(`INSERT INTO manual_payment_marks (source_key, batch_id, sheet_id, tab_name, anchor_type, anchor_value, deposit_col_key, stamp, paid_at, created_by)
      VALUES ('rb-test', $4, $1, $2, 'manual', $3, '입금일', 'x', NOW(), '시험')`, [A.sheet, A.tab, await id(3), pb[0].id]);
    const b2 = await okSave(A, p => { p[0].options[0].count = 4; p[0].options[1].count = 6; });
    assert.equal(b2.option_slots.status, 'applied', js(b2.option_slots));
    const L2 = await labelsBySeq(A);
    assert.equal(L2[1], '블루', '비고 칸 직접 쓴 줄 그대로'); assert.equal(L2[3], '블루', '입금 표시 줄 그대로');
    assert.equal(L2[2], '라지'); assert.equal(L2[4], '라지');
    assert.deepEqual(await emptyCounts(A), { 블루: 4, 라지: 6 });
  });

  await ok('[9] 일건수만 바꾼 저장 — 다시 나누기 안 돔(결과 칸 없음 · 표시 그대로)', async () => {
    const A = await setup('daily', OPTP('티셔츠', [['블루', 5], ['라지', 5]]));
    await paint(A, () => ({ label: '블루', product: '티셔츠' }));   // 일부러 어긋난 상태 — 일건수 저장이 건드리면 안 된다
    const before = await labelsBySeq(A);
    const b = await okSave(A, p => { p[0].options[0].daily = 2; });
    assert.equal(b.option_slots, undefined, js(b.option_slots));
    assert.deepEqual(await labelsBySeq(A), before);
  });

  await ok('[10] 같은 저장 재전송 — 같은 op_id = 멱등(변화 0) · 같은 값 다시 저장 = 인원 변화 없음 → 안 돎', async () => {
    const A = await setup('again', OPTP('티셔츠', [['블루', 5], ['라지', 5]]));
    await paint(A, s => ({ label: s % 2 ? '블루' : '라지', product: '티셔츠' }));
    const cur = await A.wo();
    const patch = tierEdit(cur, p => { p[0].options[0].count = 7; p[0].options[1].count = 3; });
    const r = await A.putSource(patch, {}, {});
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.option_slots.status, 'applied');
    const snap = JSON.stringify(await labelsBySeq(A));
    const w = await A.wo();
    const again = await H.call('PUT', `/api/order/intake/source/${A.sid}`, { ...A.payload, ...patch, source_revision: Number(w.source_revision), idempotency_key: w.intake_idempotency_key,
      bidir: { base_sync_version: Number(cur.sync_version), op_id: 'x', money: 1, counts: 1 } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(JSON.stringify(await labelsBySeq(A)), snap, '재전송 = 변화 0');
    const b = await okSave(A, () => {});
    assert.equal(b.option_slots, undefined);
    assert.equal(JSON.stringify(await labelsBySeq(A)), snap);
  });

  await ok('[11] H10 칸 규칙 — 상품 칸에만 계획이 있는 줄(표식 빈 칸): 옮기면 표식·상품 칸 둘 다 새 상품 · 옵션 단위에서 상품 칸에 모르는 상품이 적힌 표시 없는 줄 = 건너뜀(row_cells_unknown)', async () => {
    const A = await setup('h10', PRODS([['고등어', 5], ['옥돔', 5, 20000]]));
    await paint(A, s => ({ product: s % 2 ? '고등어' : '옥돔', option: '' }));
    const b = await okSave(A, p => { p[0].base.count = 7; p[1].base.count = 3; });
    assert.equal(b.option_slots && b.option_slots.status, 'applied', js(b.option_slots));
    const rs = await rowsOf(A);
    const plan = r => String(r.option_text || '').trim() || r.row_json.상품;
    assert.equal(rs.filter(r => plan(r) === '고등어').length, 7);
    for (const r of rs) if (String(r.option_text || '').trim()) assert.equal(r.row_json.상품, r.option_text, `표시 ${r.option_text} 인데 상품 칸 ${r.row_json.상품} (seq ${r.seq})`);
    const B = await setup('h10b', OPTP('티셔츠', [['블루', 5], ['라지', 5]]));
    await paint(B, s => (s === 9 ? { product: '바지' } : { label: s % 2 ? '블루' : '라지', product: '티셔츠' }));
    const before = await labelsBySeq(B);
    const b2 = await okSave(B, p => { p[0].options[0].count = 6; p[0].options[1].count = 4; });
    assert.equal(b2.option_slots.status, 'skipped', js(b2.option_slots)); assert.equal(b2.option_slots.reason, 'row_cells_unknown');
    assert.deepEqual(await labelsBySeq(B), before);
  });

  await ok('[12] R1 단계 저장 + 옵션 인원 변경(빈 줄 표시 2종) — 임시 거절 대신 200 + 다시 나눔', async () => {
    const tiers = (b, w) => ({ mode: 'by_option', buy_method: 'qty', rows: [
      { option: '블랙', qty: 2, people: 2, amount: 30000 }, { option: '블랙', qty: 1, people: b - 2, amount: 15000 },
      { option: '화이트', qty: 2, people: 1, amount: 40000 }, { option: '화이트', qty: 1, people: w - 1, amount: 20000 }] });
    const A = await setup('r1', OPTP('탈취제', [['블랙', 5, 15000], ['화이트', 5, 20000]], { tiers: tiers(5, 5) }));
    await paint(A, s => ({ label: s <= 5 ? '블랙' : '화이트', product: '탈취제' }));
    const r = await A.putSource(tierEdit(await A.wo(), p => { p[0].options[0].count = 6; p[0].options[1].count = 4; p[0].qty_tiers.rows[1].people = 4; p[0].qty_tiers.rows[3].people = 3; }), { tiers: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.option_slots && r.body.option_slots.status, 'applied', js(r.body.option_slots));
    assert.deepEqual(await emptyCounts(A), { 블랙: 6, 화이트: 4 });
    assert.deepEqual((await A.tiers()).map(t => [t[1], t[3]]), [['블랙', 2], ['블랙', 4], ['화이트', 1], ['화이트', 3]]);
  });

  await ok('[13] 성능 — 2000줄 1000/1000 → 1200/800 (묶음 쓰기 한 번)', async () => {
    const A = await setup('big', OPTP('티셔츠', [['블루', 1000], ['라지', 1000]]));
    await pool.query(`UPDATE campaign_participants SET option_text = CASE WHEN seq % 2 = 1 THEN '블루' ELSE '라지' END,
      row_json = jsonb_build_object('번호', seq::text, '상품', '티셔츠', '옵션', CASE WHEN seq % 2 = 1 THEN '블루' ELSE '라지' END) WHERE sheet_id=$1 AND tab_name=$2`, [A.sheet, A.tab]);
    const t0 = Date.now();
    const b = await okSave(A, p => { p[0].options[0].count = 1200; p[0].options[1].count = 800; });
    const ms = Date.now() - t0;
    assert.equal(b.option_slots && b.option_slots.status, 'applied', js(b.option_slots));
    assert.equal(b.option_slots.moved, 200);
    assert.deepEqual(await emptyCounts(A), { 블루: 1200, 라지: 800 });
    console.log(`    · 2000줄 저장(다시 나누기 포함) ${ms}ms`);
  });

  /* ── [14] 같은 부류 전수 대조(리뷰 P1·P2) — 작업보드 줄 모양별로: 다시 나눈 뒤 **실제 주문 기록 함수**로 옵션마다 새 인원만큼 사서
         ① 모든 주문이 기존 빈 줄에 앉고(정원 밖 새 줄 0) ② 주문이 고른 줄의 다시 나누기 뒤 계획 = 산 옵션 ③ 채운 뒤 칸(상품·옵션·1·2차옵션) = 산 옵션 값(리뷰옵션 칸은 저장 뒤 리뷰옵션 재분배가 정한다 — 이 대조 밖).
         「옮긴 줄 → 주문이 고르는 옵션 ≠ 새 옵션」 갈래 0 이 목표. */
  const OPTP2 = (name, opts) => ([{ name, url: 'https://www.coupang.com/vp/products/502', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] },
    options: opts.map(([v1, v2, count]) => ({ option_1: { name: '색', value: v1 }, option_2: { name: '크기', value: v2 }, label: `${v1} + ${v2}`, url: '', pay: 10000, count, daily: 1, review_type_mix: [] })) }]);
  const paintRaw = async (A, spec) => {
    const { rows } = await pool.query('SELECT id, seq FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active ORDER BY seq', [A.sheet, A.tab]);
    for (const r of rows) {
      const s = spec(Number(r.seq));
      const rj = { 번호: String(r.seq), 구매일자: dayLabel(Math.floor((Number(r.seq) - 1) / 2)), ...s.rj, 수취인: '', 연락처: '', 주문번호: '', 결제금액: '' };
      await pool.query('UPDATE campaign_participants SET option_text=$2, row_json=$3::jsonb WHERE id=$1', [r.id, s.ot || null, JSON.stringify(rj)]);
    }
  };
  const v2c = (p, o1, o2 = '') => ({ ot: [p, o1, o2].filter(Boolean).join(' · '), rj: { 상품: p, '1차옵션': o1, ...(o2 ? { '2차옵션': o2 } : {}), 리뷰옵션: '포토' } });
  const planOfRow = r => String(r.option_text || '').trim() || String((r.row_json || {}).상품 || '').trim();
  const SHAPES = [
    { tag: 'tv1', name: 'v1 옵션 칸', prod: OPTP('티셔츠', [['블루', 2], ['라지', 2]]), paint: s => ({ ot: s % 2 ? '블루' : '라지', rj: { 상품: '티셔츠', 옵션: s % 2 ? '블루' : '라지', 리뷰옵션: '포토' } }),
      edit: p => { p[0].options[0].count = 3; p[0].options[1].count = 1; }, buys: [['블루', 3], ['라지', 1]], buy: k => ({ optKey: k }),
      owner: r => r.option_text, cells: k => ({ 상품: '티셔츠', 옵션: k }) },
    { tag: 'tv2', name: 'v2 1단(상품·1차옵션)', prod: OPTP('티셔츠', [['블루', 2], ['라지', 2]]), paint: s => v2c('티셔츠', s % 2 ? '블루' : '라지'),
      edit: p => { p[0].options[0].count = 3; p[0].options[1].count = 1; }, buys: [['블루', 3], ['라지', 1]], buy: k => ({ optKey: k }),
      owner: r => String(r.option_text).split(' · ')[1], cells: k => ({ 상품: '티셔츠', '1차옵션': k }) },
    { tag: 'tv22', name: 'v2 2단(1차·2차옵션)', prod: OPTP2('티셔츠', [['블루', 'S', 2], ['블루', 'M', 2]]), paint: s => v2c('티셔츠', '블루', s % 2 ? 'S' : 'M'),
      edit: p => { p[0].options[0].count = 3; p[0].options[1].count = 1; }, buys: [['블루 + S', 3], ['블루 + M', 1]], buy: k => ({ optKey: k }),
      owner: r => '블루 + ' + String(r.option_text).split(' · ')[2], cells: k => ({ 상품: '티셔츠', '1차옵션': '블루', '2차옵션': k.split(' + ')[1] }) },
    { tag: 'tpl', name: '상품 단위 · 표시 = 상품 칸', prod: PRODS([['고등어', 2], ['옥돔', 2, 20000]]), paint: s => { const l = s % 2 ? '고등어 2팩 세트' : '옥돔 1kg'; return { ot: l, rj: { 상품: l, 리뷰옵션: '포토' } }; },
      edit: p => { p[0].base.count = 3; p[1].base.count = 1; }, buys: [['고등어', 3], ['옥돔', 1]], buy: k => ({ product: k }),
      owner: r => (planOfRow(r).startsWith('고등어') ? '고등어' : '옥돔'), cells: k => ({ 상품: k === '고등어' ? '고등어 2팩 세트' : '옥돔 1kg' }) },
    { tag: 'tpc', name: '상품 단위 · 계획이 상품 칸에만(표시 없음)', prod: PRODS([['고등어', 2], ['옥돔', 2, 20000]]), paint: s => ({ ot: null, rj: { 상품: s % 2 ? '고등어 2팩 세트' : '옥돔 1kg', 리뷰옵션: '포토' } }),
      edit: p => { p[0].base.count = 3; p[1].base.count = 1; }, buys: [['고등어', 3], ['옥돔', 1]], buy: k => ({ product: k }),
      owner: r => (planOfRow(r).startsWith('고등어') ? '고등어' : '옥돔'), cells: k => ({ 상품: k === '고등어' ? '고등어 2팩 세트' : '옥돔 1kg' }) },
    { tag: 'tbl', name: 'v1 표시 없는 줄 섞임', prod: OPTP('티셔츠', [['블루', 2], ['라지', 2]]), paint: s => (s <= 2 ? { ot: s % 2 ? '블루' : '라지', rj: { 상품: '티셔츠', 옵션: s % 2 ? '블루' : '라지', 리뷰옵션: '포토' } } : { ot: null, rj: { 상품: '', 옵션: '', 리뷰옵션: '포토' } }),
      edit: p => { p[0].options[0].count = 3; p[0].options[1].count = 1; }, buys: [['블루', 3], ['라지', 1]], buy: k => ({ optKey: k }),
      owner: r => r.option_text, cells: k => ({ 옵션: k }) },
  ];
  await ok('[14] 같은 부류 전수 대조 — 줄 모양 6종(v1 · v2 1단 · v2 2단 · 상품 단위 표시 · 상품 칸만 · 표시 없음 섞임): 다시 나눈 뒤 실제 주문이 고르는 옵션 = 새 옵션 · 칸 = 산 옵션 값 · 정원 밖 0', async () => {
    const table = [];
    for (const sh of SHAPES) {
      const A = await setup(sh.tag, sh.prod);
      await paintRaw(A, sh.paint);
      const b = await okSave(A, sh.edit);
      const st = b.option_slots && b.option_slots.status;
      const pre = new Map((await rowsOf(A)).map(r => [Number(r.seq), r]));
      let wrong = 0, overflow = 0, badCells = 0;
      for (const [k, n] of sh.buys) for (let i = 0; i < n; i++) {
        const pr = await purchase(A, sh.buy(k));
        if (!pr.w.ok || !pr.row || !pre.has(Number(pr.row.seq))) { overflow++; continue; }
        if (sh.owner(pre.get(Number(pr.row.seq))) !== k) wrong++;
        const want = sh.cells(k);
        if (Object.keys(want).some(h => String(pr.row.row_json[h] == null ? '' : pr.row.row_json[h]) !== want[h])) badCells++;
      }
      const rowsNow = await A.rows();
      table.push({ shape: sh.name, status: st, moved: b.option_slots && b.option_slots.moved, wrong, overflow, badCells, rows: rowsNow });
    }
    console.log('    · 대조표 ' + JSON.stringify(table));
    for (const t of table) {
      assert.equal(t.status, 'applied', `${t.shape}: 다시 나눔 ${JSON.stringify(t)}`);
      assert.deepEqual([t.wrong, t.overflow, t.badCells, t.rows], [0, 0, 0, 4], `${t.shape}: 주문이 고르는 옵션 ≠ 새 옵션 0 · 정원 밖 0 · 칸 어긋남 0 ${JSON.stringify(t)}`);
    }
  });

  await ok('[15] 이름 바꾸기(기존 기능) · v2 빈 줄 — 부품 칸(1차옵션)에 통째 표시(「티셔츠 · …」)가 쓰이지 않는다', async () => {
    const A = await setup('renv2', OPTP('티셔츠', [['블루', 2], ['라지', 2]]));
    await paintRaw(A, s => v2c('티셔츠', s % 2 ? '블루' : '라지'));
    const cur = await A.wo(); const p = JSON.parse(cur.product_options_json);
    p[0].options[1] = { ...p[0].options[1], prev_label: '라지', label: '엑스라지', option_1: { name: '', value: '엑스라지' } };
    const r = await A.putSource(tierEdit({ ...cur, product_options_json: JSON.stringify(p) }, () => {}), { structure: 1, rename: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await A.opts()).map(o => o.opt_key), ['블루', '엑스라지']);
    for (const x of await rowsOf(A)) {
      assert.doesNotMatch(String(x.row_json['1차옵션'] || ''), / · /, `seq ${x.seq} 1차옵션 = 부품 값`);
      assert.ok(['블루', '라지', '엑스라지'].includes(String(x.row_json['1차옵션'])), `seq ${x.seq} 1차옵션 ${x.row_json['1차옵션']}`);
    }
  });

  console.log(`optionSlotsRebalancePg: ${passed} passed${failed ? `, ${failed} failed` : ''}`);
  await H.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
