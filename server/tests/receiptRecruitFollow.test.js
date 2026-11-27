/**
 * receiptRecruitFollow.test.js — 영수증리뷰 2단계 사용자 확정(2026-11-25 · 결정 420 Q1~Q3) 회귀가드.
 * 실행: node tests/receiptRecruitFollow.test.js
 *
 * 사용자 확정:
 *  Q1 리뷰 마감 기본 = 참여한 날 + 3일 · 오더마다 1~30일로 바꿀 수 있다.
 *  Q2 AE 가 모집 인원과 다른 장수의 영수증을 붙이면 **모집 인원이 영수증 장수를 따른다**(거절하지 않는다).
 *     → 저장 입구 4곳(새 오더 · 원본 수정 · 옛 수정 경로 · 관리자 수정)에서 **저장 전에** 총모집(`recruit_count`)과
 *       상품 인원(`base.count`)을 장수로 맞춘다 = 이 값을 읽는 모든 곳이 같은 수를 본다.
 *     → 방어선 두 겹: 계약 판정(`receiptReviewSpecFromWorkOrder`)의 `receipt_total_mismatch` 는 **그대로 남긴다** —
 *       맞춤을 건너뛴 값(DB 직접 · 새 저장 경로)으로는 작업표 계획이 여전히 멈춘다.
 *     → 영수증이 없거나·형식이 틀리면 맞추지 않는다(fail-closed — 계약 판정이 막는다 · 0명으로 접지 않는다).
 *  Q3 접수 뒤 영수증 **덧붙이기** 허용(모집 인원 = 늘어난 장수) · 이미 있는 영수증을 빼거나·바꾸거나·순서를 바꾸는 것은 막는다.
 *     → 2단계 = 판정 함수(`receiptAppendDecision`)만. 실제 줄·묶음 덧붙이기 연결은 안전핀을 푸는 단계(6단계 접수 뒤 잠금)가 한다 —
 *       그때까지 접수된 영수증 오더의 원본 수정은 종전 잠금(총모집·상품 구성)이 막는다.
 * ★ 실제 처리기(order.routes)를 PGlite(저장소 migrations 그대로) 위에서 돈다. 안전핀(NOT_READY_WORK_KINDS)은
 *   **이 시험 안에서만** 잠깐 비우고(맞춤이 어디서 도는지 보려고) 끝나면 배포 그대로 되돌린 뒤 되돌림을 확인한다.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const t = (name, cond, extra) => { assert(cond, name + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 600) : '')); pass++; console.log('  ✓ ' + name); };

const SERVER = path.join(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-receipt-follow-secret';
process.env.ORDER_INTAKE_KEY = 'test-intake-key-receipt-follow';
process.env.WORKBOARD_V2_ENABLED = '1';

const R = require('../src/utils/receiptPool');
const W = require('../src/utils/worktablePlan');
const FID = n => `fake_receipt_${String(n).padStart(4, '0')}_abcdefghijk`;
const RECEIPTS = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ file_id: FID(from + i) }));
const place = (receipts, extra = {}) => ({ name: '가짜카페 역삼점', url: 'https://map.naver.com/p/entry/place/0000000', option_schema_version: 2, product_mode: 'none',
  base: { pay: 0, count: 9, daily: 0, review_type_mix: [] }, options: [],
  receipt: { review_deadline_days: 3, place_address: '서울 가짜구 가짜로 1', receipts }, ...extra });
const woOf = (products, extra = {}) => ({ id: 'wo_rc', work_kind: 'receipt', workboard_schema_version: 2, recruit_count: 9, review_fee: 5000,
  pay_amount: 0, product_options_json: JSON.stringify(products), ...extra });
const codes = r => (r.blockers || []).map(b => b.code);
const TEMPLATE = { core: ['번호', '구매일자', '주문번호', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰', '입금', '비고'], channels: {}, workTypes: [] };

async function openDb() {
  const mod = process.env.PGLITE_MODULE || '@electric-sql/pglite';
  const { PGlite } = require(mod);
  const db = new PGlite();
  const dir = path.join(SERVER, 'migrations');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { /* PGlite 에서 안 도는 몇 파일 — 이 시험의 표와 무관 */ }
  }
  return db;
}
function poolOf(db) {
  let chain = Promise.resolve();
  const raw = async (sql, params) => { const r = await db.query(sql, params || []); return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length }; };
  const connect = async () => { let release; const wait = chain; chain = new Promise(r => { release = r; }); await wait; return { query: raw, release() { release(); } }; };
  return { query: raw, connect, on() {}, end: async () => {} };
}
function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.setHeader = res.set;
  return res;
}
function handlerOf(router, method, p) {
  const layer = router.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
  assert(layer, '실제 처리기 경로: ' + method + ' ' + p);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

(async () => {
  console.log('\n▶ 영수증리뷰 — 모집 인원 = 영수증 장수 · 접수 뒤 덧붙이기 판정(결정 420 사용자 확정 Q1~Q3)\n');

  /* ── 1) Q1 리뷰 마감 ─────────────────────────────────────────── */
  console.log('1) Q1 리뷰 마감 — 기본 3일 · 오더마다 1~30');
  const sp = d => R.receiptReviewSpecFromWorkOrder(woOf([place(RECEIPTS(4), { base: { pay: 0, count: 4 }, receipt: { review_deadline_days: d, receipts: RECEIPTS(4) } })], { recruit_count: 4 }));
  t('★ 안 보내면 3일(참여한 날 + 3일) · 기본값 상수 3', sp(undefined).spec.reviewDeadlineDays === 3 && R.RECEIPT_REVIEW_DEFAULT_DEADLINE_DAYS === 3);
  t('★ 오더마다 바꿀 수 있다(1·7·30) · 범위 밖은 잠금', sp(1).spec.reviewDeadlineDays === 1 && sp(7).spec.reviewDeadlineDays === 7 && sp(30).spec.reviewDeadlineDays === 30
    && codes(sp(0)).includes('receipt_deadline_days') && codes(sp(31)).includes('receipt_deadline_days'));

  /* ── 2) Q2 모집 인원 = 영수증 장수(순수 함수) ─────────────────────── */
  console.log('\n2) Q2 모집 인원이 영수증 장수를 따른다(맞춤 함수)');
  const f4 = R.receiptRecruitFollow('receipt', JSON.stringify([place(RECEIPTS(4))]));
  t('★★ 9명으로 와도 영수증 4장이면 4명 · 상품 인원도 4', f4.applied === true && f4.count === 4 && JSON.parse(f4.json)[0].base.count === 4
    && f4.requested && f4.requested.baseCount === 9);
  t('★ 맞춘 원본은 그 밖의 글자를 그대로 둔다(매장·영수증·기한·주소)', (() => {
    const a = JSON.parse(f4.json)[0]; const z = place(RECEIPTS(4));
    return a.name === z.name && a.url === z.url && JSON.stringify(a.receipt) === JSON.stringify(z.receipt) && a.base.pay === 0;
  })());
  t('★ 상품 인원 칸이 없으면 만들어 맞춘다', JSON.parse(R.receiptRecruitFollow('receipt', [place(RECEIPTS(2), { base: undefined })]).json)[0].base.count === 2);
  t('★ 종류 표기는 라벨·코드 모두(영수증리뷰)', R.receiptRecruitFollow('영수증리뷰', JSON.stringify([place(RECEIPTS(3))])).count === 3);
  t('★★ 영수증 오더가 아니면 손대지 않는다(리뷰·블로그·Q&A·예약·빈 값)', ['review', 'blog', 'qna', 'booking', '', undefined]
    .every(k => R.receiptRecruitFollow(k, JSON.stringify([place(RECEIPTS(4))])).applied === false));
  t('★★ fail-closed — 영수증 없음·목록 아님·상한 초과·매장 둘·옵션 상품·형식 깨짐은 맞추지 않는다(계약 판정이 막는다 · 0명으로 접지 않는다)',
    [JSON.stringify([place([])]), JSON.stringify([place(undefined)]), JSON.stringify([place('x')]), JSON.stringify([place(RECEIPTS(R.MAX_RECEIPTS + 1))]),
      JSON.stringify([place(RECEIPTS(2)), { ...place(RECEIPTS(2)), name: '가짜카페 선릉점' }]),
      JSON.stringify([{ ...place(RECEIPTS(2)), product_mode: 'opt', options: [{ option_1: { name: '메뉴', value: 'A' } }] }]),
      '{not json', '', null].every(j => R.receiptRecruitFollow('receipt', j).applied === false));
  t('★ 장수 = 받은 줄 수(틀린 번호·중복이 섞여도 장수는 줄 수 — 그 오더는 계약 판정이 file_invalid·duplicate 로 막는다)', (() => {
    const r = R.receiptRecruitFollow('receipt', JSON.stringify([place([...RECEIPTS(2), { file_id: 'bad' }, { file_id: FID(1) }])]));
    const spec = R.receiptReviewSpecFromWorkOrder(woOf([JSON.parse(r.json)[0]], { recruit_count: r.count }));
    return r.count === 4 && !codes(spec).includes('receipt_total_mismatch') && codes(spec).includes('receipt_file_invalid') && codes(spec).includes('receipt_file_duplicate');
  })());
  t('★★ 맞춘 값으로는 계약 잠금 없음 · 계획이 만들어진다(줄 수 = 장수)', (() => {
    const wo = woOf(JSON.parse(f4.json), { recruit_count: f4.count });
    const p = W.buildWorktablePlan({ workOrder: wo, template: TEMPLATE });
    return R.receiptReviewSpecFromWorkOrder(wo).blockers.length === 0 && p.canCreate === true && p.rows.length === 4;
  })());
  t('★★ 방어선 두 겹 — 맞춤을 건너뛴 값(총모집 9 · 상품 인원 9 · 영수증 4)이면 계획은 여전히 멈춘다', (() => {
    const p = W.buildWorktablePlan({ workOrder: woOf([place(RECEIPTS(4))]), template: TEMPLATE });
    return p.canCreate === false && codes(p).includes('receipt_total_mismatch');
  })());

  /* ── 3) Q3 접수 뒤 덧붙이기 판정(순수 함수) ─────────────────────── */
  console.log('\n3) Q3 접수 뒤 영수증 덧붙이기 판정');
  const cur = woOf([place(RECEIPTS(4), { base: { pay: 0, count: 4 } })], { recruit_count: 4 });
  const nextOf = (receipts, extra = {}, woExtra = {}) => {
    const fr = R.receiptRecruitFollow('receipt', JSON.stringify([place(receipts, extra)]));
    if (!fr.applied) return woOf([place(receipts, extra)], woExtra);   // 맞추지 못하는 원본(상한 초과 등) = 받은 그대로
    return woOf(JSON.parse(fr.json), { recruit_count: fr.count, ...woExtra });
  };
  const same = R.receiptAppendDecision(cur, nextOf(RECEIPTS(4)));
  t('같은 영수증이면 덧붙일 것 없음 · 잠금 없음', same.append.length === 0 && same.locked.length === 0 && same.invalid.length === 0 && same.fromTotal === 4 && same.toTotal === 4);
  const add2 = R.receiptAppendDecision(cur, nextOf(RECEIPTS(6)));
  t('★★ 뒤에 2장 덧붙이면 = 5·6번 두 장 · 모집 4 → 6', add2.locked.length === 0 && add2.invalid.length === 0 && add2.fromTotal === 4 && add2.toTotal === 6
    && add2.append.map(a => `${a.poolSeq}:${a.fileId}`).join(',') === `5:${FID(5)},6:${FID(6)}`);
  t('★★ 이미 있는 영수증을 빼면 잠금(줄이기 없음)', R.receiptAppendDecision(cur, nextOf(RECEIPTS(3))).locked.includes('receipts_removed'));
  t('★★ 이미 있는 영수증을 다른 사진으로 바꾸면 잠금', R.receiptAppendDecision(cur, nextOf([...RECEIPTS(3), { file_id: FID(99) }])).locked.includes('receipts_removed'));
  t('★★ 순서를 바꾸면 잠금(영수증 번호 = 줄 · 이미 깔린 자리)', R.receiptAppendDecision(cur, nextOf([RECEIPTS(4)[1], RECEIPTS(4)[0], ...RECEIPTS(2, 3)])).locked.includes('receipts_removed'));
  t('★★ 덧붙인 사진이 이미 있는 사진과 같으면 새 잠금(한 장 = 한 사람)', R.receiptAppendDecision(cur, nextOf([...RECEIPTS(4), { file_id: FID(2) }])).invalid.length > 0);
  t('★ 덧붙여 상한을 넘으면 새 잠금', R.receiptAppendDecision(cur, nextOf(RECEIPTS(R.MAX_RECEIPTS + 1))).invalid.length > 0
    || R.receiptAppendDecision(cur, nextOf(RECEIPTS(R.MAX_RECEIPTS + 1))).locked.length > 0);
  t('★ 매장 이름·리뷰 마감 일수는 접수 뒤 잠금(묶음·안내와 갈린다)', R.receiptAppendDecision(cur, nextOf(RECEIPTS(4), { name: '가짜카페 선릉점' })).locked.includes('place_name')
    && R.receiptAppendDecision(cur, nextOf(RECEIPTS(4), { receipt: { review_deadline_days: 5, receipts: RECEIPTS(4) } })).locked.includes('review_deadline_days'));
  t('★★ 총모집이 「이전 장수 + 덧붙인 장수」가 아니면 잠금(맞춤을 건너뛴 값)', R.receiptAppendDecision(cur, nextOf(RECEIPTS(6), {}, { recruit_count: 9 })).locked.includes('total'));
  t('★★ fail-closed — 어느 한쪽 계약을 못 읽으면 덧붙이지 않고 잠금', (() => {
    const r1 = R.receiptAppendDecision({ ...cur, product_options_json: '{bad' }, nextOf(RECEIPTS(6)));
    const r2 = R.receiptAppendDecision(cur, { ...cur, product_options_json: '[]' });
    return r1.append.length === 0 && r1.locked.includes('receipt_shape') && r2.append.length === 0 && r2.locked.includes('receipt_shape');
  })());
  t('이미 있던 사유(예: 리뷰비 0원 아님 · 없음)로 글 칸 수정을 막지 않는다 — 새로 깨진 사유만', R.receiptAppendDecision(
    { ...cur, pay_amount: 1000 }, { ...nextOf(RECEIPTS(4)), pay_amount: 1000 }).invalid.length === 0);

  /* ── 4) 실제 저장 입구 4곳 — 저장 전에 맞춘다 ─────────────────────── */
  console.log('\n4) 실제 저장 입구(새 오더 · 원본 수정 · 옛 수정 경로 · 관리자 수정)');
  const db = await openDb();
  const pool = poolOf(db);
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  const wk = require('../src/utils/workKind');
  const shipped = wk.NOT_READY_WORK_KINDS.slice();
  t('★★★ 배포 그대로의 안전핀 — receipt 는 준비 중(저장 입구 거절)', shipped.includes('receipt') && wk.isWorkKindReady('receipt') === false);
  const orders = require('../src/routes/order.routes');
  const intakeH = handlerOf(orders, 'post', '/intake');
  const revisionH = handlerOf(orders, 'put', '/intake/source/:sourceReviewOrderId');
  const legacyH = handlerOf(orders, 'post', '/intake/:id/update');
  const adminEditH = orders.handlers.orderAdminEdit;
  t('관리자 수정 처리기를 이름으로 찾는다', typeof adminEditH === 'function');
  const call = async (h, { body = {}, params = {}, admin } = {}) => {
    const res = fakeRes(); let err = null;
    const req = { body, params, query: {}, headers: { 'x-intake-key': process.env.ORDER_INTAKE_KEY }, ip: '127.0.0.1', get: () => '', path: '/x', method: 'POST',
      ...(admin ? { admin, user: admin } : {}) };
    await h(req, res, e => { err = e; });
    if (err) throw err;
    return res;
  };
  const body = (sid, rev, receipts, over = {}) => ({
    requester_name: '가짜등록자', source_review_order_id: sid, source_revision: rev, workboard_schema_version: 2, idempotency_key: `${sid}:${rev}`,
    work_series_id: sid, work_round: 1, title: '[가짜] 가짜카페 영수증리뷰', work_kind: 'receipt', recruit_count: 9, review_fee: 5000, pay_amount: 0,
    product_options_json: JSON.stringify([place(receipts)]), product_url: 'https://map.naver.com/p/entry/place/0000000', ...over,
  });
  const row = async id => (await pool.query('SELECT * FROM work_orders WHERE id = $1', [id])).rows[0];
  const baseCountOf = r => JSON.parse(r.product_options_json)[0].base.count;

  const pinned = await call(intakeH, { body: body('ro-rc-pin', 1, RECEIPTS(4)) });
  t('★★★ 안전핀 그대로면 새 오더 409(아무것도 저장 안 함)', pinned.statusCode === 409
    && (await pool.query(`SELECT count(*)::int n FROM work_orders WHERE source_review_order_id = 'ro-rc-pin'`)).rows[0].n === 0, pinned.body);

  wk.NOT_READY_WORK_KINDS.splice(0, wk.NOT_READY_WORK_KINDS.length);   // ★ 이 시험 안에서만 — 아래 finally 가 되돌린다
  try {
    const r1 = await call(intakeH, { body: body('ro-rc-1', 1, RECEIPTS(4)) });
    t('★★ 새 오더: 9명 + 영수증 4장 → 저장된 총모집 4 · 상품 인원 4(응답도 4)', r1.statusCode === 200 && r1.body.ok && r1.body.data.recruit_count === 4
      && baseCountOf(await row(r1.body.data.id)) === 4 && (await row(r1.body.data.id)).recruit_count === 4, r1.body);
    const wo1 = await row(r1.body.data.id);
    t('★★ 저장된 오더 그대로 계약 잠금 없음 · 계획 = 4줄', R.receiptReviewSpecFromWorkOrder(wo1).blockers.length === 0
      && W.buildWorktablePlan({ workOrder: wo1, template: TEMPLATE }).rows.length === 4);

    const r0 = await call(intakeH, { body: body('ro-rc-0', 1, []) });
    const wo0 = r0.body && r0.body.data && await row(r0.body.data.id);
    t('★★ fail-closed — 영수증 0장 오더는 맞추지 않는다(총모집 9 그대로 · 계획 잠금)', r0.statusCode === 200 && wo0.recruit_count === 9
      && codes(W.buildWorktablePlan({ workOrder: wo0, template: TEMPLATE })).includes('receipt_no_files'), r0.body);

    const r2 = await call(revisionH, { body: body('ro-rc-1', 2, RECEIPTS(6), { recruit_count: 4 }), params: { sourceReviewOrderId: 'ro-rc-1' } });
    const wo2 = await row(r1.body.data.id);
    t('★★ 원본 수정(접수 전): 영수증 6장으로 고치면 총모집 4 → 6 · 상품 인원 6', r2.statusCode === 200 && wo2.recruit_count === 6 && baseCountOf(wo2) === 6
      && Number(wo2.source_revision) === 2, r2.body);

    const r3 = await call(legacyH, { body: { product_options_json: JSON.stringify([place(RECEIPTS(5))]), recruit_count: 2 }, params: { id: wo2.id } });
    const wo3 = await row(wo2.id);
    t('★★ 옛 수정 경로: 영수증 5장 + 총모집 2 → 5', r3.statusCode === 200 && wo3.recruit_count === 5 && baseCountOf(wo3) === 5, r3.body);
    const r3b = await call(legacyH, { body: { recruit_count: 12 }, params: { id: wo2.id } });
    t('★★ 옛 수정 경로: 총모집만 보내도 저장된 영수증 장수(5)를 따른다', r3b.statusCode === 200 && (await row(wo2.id)).recruit_count === 5, r3b.body);

    const ADMIN = { name: '가짜관리자', role: 'master', id: 1, username: 'fake-admin' };
    const r4 = await call(adminEditH, { body: { id: wo2.id, recruit_count: 30 }, admin: ADMIN });
    t('★★ 관리자 수정: 총모집 30 → 저장된 영수증 장수 5 그대로(바뀐 것 없음이면 그대로 답)', (await row(wo2.id)).recruit_count === 5, { s: r4.statusCode, b: r4.body });
    const r4b = await call(adminEditH, { body: { id: wo2.id, product_options_json: JSON.stringify([place(RECEIPTS(7))]), recruit_count: 1 }, admin: ADMIN });
    const wo4 = await row(wo2.id);
    t('★★ 관리자 수정: 영수증 7장 + 총모집 1 → 7 · 상품 인원 7', wo4.recruit_count === 7 && baseCountOf(wo4) === 7, { s: r4b.statusCode, b: r4b.body });

    const rv = await call(intakeH, { body: { ...body('ro-rv-1', 1, RECEIPTS(4)), work_kind: 'review', recruit_count: 9 } });
    t('★★ 리뷰 오더(같은 상품 원본 모양이어도)는 손대지 않는다 — 총모집 9 · 상품 인원 9', rv.statusCode === 200 && rv.body.data.recruit_count === 9
      && baseCountOf(await row(rv.body.data.id)) === 9, rv.body);
  } finally {
    wk.NOT_READY_WORK_KINDS.splice(0, wk.NOT_READY_WORK_KINDS.length, ...shipped);
  }
  t('★★★ 시험 뒤 안전핀이 배포 그대로 돌아왔다', JSON.stringify(wk.NOT_READY_WORK_KINDS) === JSON.stringify(shipped) && wk.isWorkKindReady('receipt') === false);

  /* ── 5) 저장 입구 연결 고정(정적) ─────────────────────────────── */
  console.log('\n5) 맞춤 호출 자리 고정');
  const src = fs.readFileSync(path.join(SERVER, 'src/routes/order.routes.js'), 'utf8');
  const sliceOf = (start, end) => { const a = src.indexOf(start); const z = src.indexOf(end, a + 1); assert(a >= 0 && z > a, start); return src.slice(a, z); };
  const intakeSrc = sliceOf("router.post('/intake', async", "\n});\n");
  t('★ 새 오더: 맞춤이 저장(_insertWorkOrder) 앞', intakeSrc.indexOf('_followReceiptRecruit(b') > 0 && intakeSrc.indexOf('_followReceiptRecruit(b') < intakeSrc.indexOf('_insertWorkOrder('));
  const revSrc = sliceOf('async function _intakeSourceRevisionHandler', "router.put('/intake/source/");
  t('★ 원본 수정: 맞춤이 옵션 읽기(_requestOptionsJson)·잠금 비교 앞', revSrc.indexOf('_followReceiptRecruit(b') > 0
    && revSrc.indexOf('_followReceiptRecruit(b') < revSrc.indexOf('let optionsJson = _requestOptionsJson(b)'));
  const legSrc = sliceOf('async function _intakeUpdateHandler', "router.post('/intake/:id/update'");
  t('★ 옛 수정 경로: 맞춤이 잠금 비교(_legacyOptions) 앞', legSrc.indexOf('_followReceiptRecruit(b, cur[0])') > 0
    && legSrc.indexOf('_followReceiptRecruit(b, cur[0])') < legSrc.indexOf('const _legacyOptions'));
  const admSrc = sliceOf('_handlers.orderAdminEdit = async', '\n};\n');
  t('★ 관리자 수정: 맞춤이 Q&A 잠금 비교 앞', admSrc.indexOf('_followReceiptRecruit(b, o)') > 0 && admSrc.indexOf('_followReceiptRecruit(b, o)') < admSrc.indexOf('_qnaCalendarLocked(o)'));
  t('★ 계약 판정의 장수 불일치 잠금은 남아 있다(방어선 두 겹)', fs.readFileSync(path.join(SERVER, 'src/utils/receiptPool.js'), 'utf8').includes("block('receipt_total_mismatch'"));

  console.log(`\n✅ ${pass}개 통과`);
  process.exit(0);
})().catch(e => { console.error('❌', e && e.stack || e); process.exit(1); });
