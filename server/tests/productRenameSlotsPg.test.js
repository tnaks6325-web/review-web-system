'use strict';
/**
 * productRenameSlotsPg.test.js — 결정 404: 공고에서 **상품 이름**을 바꾸면 상품이 여러 개인 작업보드의 손 안 댄 빈 줄 표시도 따라간다.
 *   v2(「상품 · 옵션」 표시 · 옵션 단위) = 표시 앞부분·상품 칸 / 상품 단위(표시 = 상품 이름) = 포함 관계로 짝지어진 표시·상품 칸.
 *   종전: 표시가 옛 상품 이름에 묶여 새 이름 바로 구매가 「빈 줄 없음」이 되거나(v2) 다른 상품 줄을 잡았다(상품 단위 포함 관계).
 *   PGlite + 저장소 migrations 전부 + 실제 앱(인트라넷 원본 수정 PUT = 양방향 공유 저장 · 공고 창 PUT) + 실제 주문 기록 함수(writeOrderToWorktable)
 *   + 정원 셈(loadExternalOptionOrders)으로 「새 이름 주문이 자기 상품 줄을 잡는다 · 다른 상품 줄 0 · 정원 밖 새 줄 0」을 확인한다.
 *   시험 데이터는 모두 가짜 값.
 */
const assert = require('assert');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const fs = require('fs');
const path = require('path');
const F = require('./helpers/r1QtyTiersFixture');

let passed = 0, failed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.log('  ✗ ' + name); console.log('    → ' + String(e.message).split('\n')[0].slice(0, 600)); } };

/** 옵션 단위 상품 여러 개 — [[상품 이름, [[옵션, 인원], …]], …] */
const PRODS = list => list.map(([name, opts], i) => ({
  name, url: `https://www.coupang.com/vp/products/80${i}`, option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] },
  options: opts.map(([v, count]) => ({ option_1: { name: '', value: v }, label: v, url: '', pay: 10000, count, daily: 1, review_type_mix: [] })),
}));
const MACK = () => PRODS([['고등어', [['1kg', 2], ['2kg', 2]]], ['고등어 2팩 세트', [['기본', 2], ['선물', 2]]]]);
/** seq → [상품, 옵션] (1·2 = 고등어 1kg · 3·4 = 고등어 2kg · 5·6 = 2팩 세트 기본 · 7·8 = 2팩 세트 선물) */
const MACK_PLAN = s => (s <= 2 ? ['고등어', '1kg'] : s <= 4 ? ['고등어', '2kg'] : s <= 6 ? ['고등어 2팩 세트', '기본'] : ['고등어 2팩 세트', '선물']);
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const dayLabel = i => { const d = new Date(Date.UTC(2026, 11, 1 + i)); return `${d.getUTCMonth() + 1} / ${d.getUTCDate()} (${WD[d.getUTCDay()]})`; };
const v2c = (p, o1) => ({ ot: `${p} · ${o1}`, rj: { 상품: p, '1차옵션': o1, 리뷰옵션: '포토' } });

(async () => {
  const { pool } = await F.installPglitePool();
  const H = await F.boot({ pool });
  const { setup, tierEdit } = H;
  const so = require('../src/services/sheetlessOrder.service');
  so.__setPoolForTest(pool);
  const ren = require('../src/services/campaignOptionRename.service');
  const st = require('../src/services/campaignState.service');
  const jwt = require('jsonwebtoken');
  const admin = { authorization: 'Bearer ' + jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET) };

  const paintRaw = async (A, spec) => {
    const { rows } = await pool.query('SELECT id, seq FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active ORDER BY seq', [A.sheet, A.tab]);
    for (const r of rows) {
      const s = spec(Number(r.seq));
      const rj = { 번호: String(r.seq), 구매일자: dayLabel(Math.floor((Number(r.seq) - 1) / 2)), ...s.rj, 수취인: '', 연락처: '', 주문번호: '', 결제금액: '' };
      await pool.query('UPDATE campaign_participants SET option_text=$2, row_json=$3::jsonb WHERE id=$1', [r.id, s.ot || null, JSON.stringify(rj)]);
    }
  };
  const rowsOf = async A => (await pool.query('SELECT id, seq, option_text, row_json, reviewer_name, order_submission_id, updated_by FROM campaign_participants WHERE sheet_id=$1 AND tab_name=$2 AND deleted_at IS NULL AND active ORDER BY seq', [A.sheet, A.tab])).rows;
  const bySeq = async A => new Map((await rowsOf(A)).map(r => [Number(r.seq), r]));
  /** 인트라넷 원본 수정 PUT(양방향 공유 저장) — 상품 i 이름을 바꾼다(+ 옵션 이름도 바꿀 수 있다: optRen = [옛, 새]) */
  const renameShared = async (A, i, to, optRen = null) => {
    const cur = await A.wo(); const p = JSON.parse(cur.product_options_json);
    p[i] = { ...p[i], prev_name: p[i].name, name: to };
    if (optRen) {
      const k = p[i].options.findIndex(o => o.label === optRen[0]);
      const o = p[i].options[k];
      p[i].options[k] = { ...o, prev_label: o.label, label: optRen[1], option_1: { ...o.option_1, value: optRen[1] } };
    }
    const r = await A.putSource(tierEdit({ ...cur, product_options_json: JSON.stringify(p) }, () => {}), { structure: 1, rename: 1 });
    assert.equal(r.status, 200, '이름 바꾸기 저장은 성공 ' + JSON.stringify(r.body));
    return r;
  };
  /** 공고 창 저장(PUT /api/campaign/admin/:id) — 상품 이름 from 인 줄의 상품 이름을 to 로.
   *  linked=false = 연결 안 된 공고(오더 연결 끔 → 공고 창이 직접 저장) · linked=true = 연결 공고(공고 창 → 양방향 공유 저장) */
  const renameWindow = async (A, from, to, { optRen = null, linked = false } = {}) => {
    if (!linked) await pool.query(`UPDATE work_orders SET bidir_state = 'off' WHERE id = $1`, [A.w.id]);
    {
      const dd = await H.call('GET', `/api/campaign/admin/${A.camp}`, null, admin);
      assert.equal(dd.status, 200, 'GET ' + JSON.stringify(dd.body).slice(0, 300));
      const c0 = dd.body.data;
      const body = {
        title: c0.title, review_fee: c0.review_fee, max_slots: c0.max_slots, sort_order: c0.sort_order, deadline: c0.deadline,
        work_detail: { ...c0.work_detail }, thumbnail_url: c0.thumbnail_url, time_range: c0.time_range, landing_url: c0.landing_url,
        channel: c0.channel, channel_custom: c0.channel_custom || '', window_start: String(c0.window_start || '').slice(0, 5), window_end: String(c0.window_end || '').slice(0, 5),
        recruit_total: c0.recruit_total, daily_limit: c0.daily_limit, delivery_type: c0.delivery_type, review_type: c0.review_type, work_kind: c0.work_kind || 'review',
        options: (dd.body.options || []).map(x => ({ optKey: optRen && x.optKey === optRen[0] ? optRen[1] : x.optKey, prevOptKey: x.optKey,
          productName: String(x.productName || '') === from ? to : x.productName, unitKind: x.unitKind, optionUrl: x.optionUrl, payAmount: x.payAmount,
          recruitTotal: x.recruitTotal, dailyLimit: x.dailyLimit, status: x.status, inflowGuideHtml: x.inflowGuideHtml || '', inflowGuideImages: x.inflowGuideImages || [] })),
        fee_schedules: (dd.body.feeSchedules || []).map(x => ({ effectiveFrom: x.effectiveFrom, reviewFee: x.reviewFee, memo: x.memo })),
        bidir_base_sync_version: dd.body.bidir ? dd.body.bidir.sync_version : undefined,
      };
      const r = await H.call('PUT', `/api/campaign/admin/${A.camp}`, body, admin);
      assert.equal(r.status, 200, '공고 창 저장 ' + JSON.stringify(r.body).slice(0, 400));
      assert.ok(!r.body.optionsWarning, '옵션 저장 경고 없음 ' + JSON.stringify(r.body.optionsWarning));
      return r;
    }
  };
  let osn = 0;
  /** 실제 주문 기록 함수 — 옵션 키 주문(optKey) 또는 상품만 고른 바로 구매(product) */
  /*   옵션 키 주문 = 공고 참여(신청 기록)로 산 주문 — 주문 쪽 줄 고르기는 그 신청의 공고 옵션 상품 이름으로 「상품 · 옵션」 줄을 고른다.
   *   (신청 없는 바로 구매는 상품 이름을 몰라 상품이 여러 개인 v2 작업보드에서 원래도 짝을 못 짓는다 — 이 시험의 범위 밖) */
  const purchase = async (A, optKey, product = '') => {
    osn += 1;
    let appId = null;
    if (optKey) {
      appId = (await pool.query(`INSERT INTO campaign_applications (campaign_id, applicant_name, phone8, status, option_key, expires_at)
        VALUES ($1, '가짜참여', $2, 'applied', $3, NOW() + INTERVAL '1 hour') RETURNING id`, [A.camp, String(75001000 + osn), optKey])).rows[0].id;
    }
    const { rows } = await pool.query(`INSERT INTO order_submissions (sheet_id, tab_name, recipient, orderer, phone, price, order_num, mirror_status, source, selected_opt_key, selected_product, campaign_application_id)
      VALUES ($1, $2, '가짜구매', '가짜구매', $3, '10000', $4, 'queued', 'order_submit', $5, $6, $7) RETURNING id`, [A.sheet, A.tab, `010-7500-${String(1000 + osn)}`, `PR${osn}${Date.now()}`, optKey, product, appId]);
    const w = await so.writeOrderToWorktable({ sheetId: A.sheet, tabName: A.tab, orderSubmissionId: rows[0].id,
      orderData: { recipient: '가짜구매', orderer: '가짜구매', phone: `010-7500-${String(1000 + osn)}`, price: '10000', orderNum: `PR${osn}`, selectedOptKey: optKey, selectedProduct: product } });
    const { rows: got } = await pool.query('SELECT seq, option_text, row_json FROM campaign_participants WHERE order_submission_id=$1 AND deleted_at IS NULL', [rows[0].id]);
    return { w, row: got[0], id: rows[0].id };
  };
  /** n 건 사서 — 모두 기존 빈 줄 중 want(바꾼 뒤 표시) 줄에 앉는가 · 줄 수 그대로인가 */
  const buyAll = async (A, key, n, wantLabel, product = '') => {
    const pre = await bySeq(A); const before = await A.rows();
    const seats = [];
    for (let i = 0; i < n; i++) {
      const pr = await purchase(A, key, product);
      assert.equal(pr.w.ok, true, `${key || product} 주문 기록 ${JSON.stringify(pr.w)}`);
      assert.ok(pr.row && pre.has(Number(pr.row.seq)), `${key || product} 주문이 기존 빈 줄에 앉는다(정원 밖 새 줄 0) seq=${pr.row && pr.row.seq}`);
      assert.equal(String(pre.get(Number(pr.row.seq)).option_text), wantLabel, `${key || product} 주문이 고른 줄의 표시(다른 상품 줄 0) seq=${pr.row.seq}`);
      seats.push(pr.row);
    }
    assert.equal(await A.rows(), before, '줄 수 그대로(정원 밖 새 줄 0)');
    return seats;
  };
  const extCounts = async A => {
    const m = await st.loadExternalOptionOrders(pool, [A.camp], new Date());
    return m && m.get(A.camp) ? Object.fromEntries([...m.get(A.camp)].map(([k, v]) => [k, v.n])) : {};
  };

  await ok('[0] 증상 — 상품 2개 v2 작업보드 · 고등어 → 국산 고등어 뒤 새 이름(1kg) 바로 구매가 고등어 빈 줄에 앉는다(종전: 빈 줄 없음)', async () => {
    const A = await setup('rp0', MACK());
    await paintRaw(A, s => v2c(...MACK_PLAN(s)));
    await renameShared(A, 0, '국산 고등어');
    const pre = await bySeq(A);
    const pr = await purchase(A, '1kg');
    assert.ok(pr.w.ok && pr.row && pre.has(Number(pr.row.seq)), `기존 빈 줄에 앉음 ${JSON.stringify({ w: pr.w, seq: pr.row && pr.row.seq })}`);
    assert.ok(Number(pr.row.seq) <= 2, '고등어 1kg 줄 seq=' + pr.row.seq);
  });

  await ok('[1] v2 상품 2개(고등어 ⊂ 고등어 2팩 세트) · 양방향 공유 저장 — 고등어 줄 표시 「국산 고등어 · 1kg」·상품 칸 「국산 고등어」·1차옵션 그대로 · 2팩 세트 줄 무접촉 · 주문 왕복 · 정원 밖 0', async () => {
    const A = await setup('rp1', MACK());
    await paintRaw(A, s => v2c(...MACK_PLAN(s)));
    await renameShared(A, 0, '국산 고등어');
    for (const r of await rowsOf(A)) {
      const [p, o] = MACK_PLAN(Number(r.seq));
      const np = p === '고등어' ? '국산 고등어' : p;
      assert.equal(r.option_text, `${np} · ${o}`, `seq ${r.seq} 표시`);
      assert.equal(r.row_json.상품, np, `seq ${r.seq} 상품 칸`);
      assert.equal(r.row_json['1차옵션'], o, `seq ${r.seq} 1차옵션 칸 그대로`);
      assert.equal(r.row_json.리뷰옵션, '포토');
    }
    await buyAll(A, '1kg', 2, '국산 고등어 · 1kg');
    await buyAll(A, '2kg', 2, '국산 고등어 · 2kg');
    await buyAll(A, '기본', 2, '고등어 2팩 세트 · 기본');
  });

  await ok('[2] v2 — 포함하는 쪽 이름 바꾸기(고등어 2팩 세트 → 고등어 3팩 세트) · 주문은 상품 이름 정확 일치로 줄을 고른다 → 바꾸고 왕복 · 고등어 줄 무접촉', async () => {
    const A = await setup('rp2', MACK());
    await paintRaw(A, s => v2c(...MACK_PLAN(s)));
    await renameShared(A, 1, '고등어 3팩 세트');
    const m = await bySeq(A);
    assert.equal(m.get(1).option_text, '고등어 · 1kg');
    assert.equal(m.get(5).option_text, '고등어 3팩 세트 · 기본'); assert.equal(m.get(5).row_json.상품, '고등어 3팩 세트');
    await buyAll(A, '선물', 2, '고등어 3팩 세트 · 선물');
    await buyAll(A, '1kg', 2, '고등어 · 1kg');
  });

  await ok('[3] 상품 1개 v2 작업보드 = 종전 그대로(주문이 옵션만으로 짝짓는다) — 표시 「티셔츠 · XL」 그대로 · 주문 왕복', async () => {
    const A = await setup('rp3', PRODS([['티셔츠', [['블루', 2], ['XL', 2]]]]));
    await paintRaw(A, s => v2c('티셔츠', s % 2 ? '블루' : 'XL'));
    await renameShared(A, 0, '반팔 티셔츠');
    for (const r of await rowsOf(A)) assert.equal(r.option_text, `티셔츠 · ${Number(r.seq) % 2 ? '블루' : 'XL'}`, `seq ${r.seq} 표시 그대로`);
    await buyAll(A, 'XL', 2, '티셔츠 · XL');
  });

  await ok('[4] 한 저장에서 상품 이름 + 옵션 이름 — 고등어 → 국산 고등어 · 1kg → 1키로: 표시 「국산 고등어 · 1키로」 · 1차옵션 「1키로」 · 주문 왕복', async () => {
    const A = await setup('rp4', MACK());
    await paintRaw(A, s => v2c(...MACK_PLAN(s)));
    await renameShared(A, 0, '국산 고등어', ['1kg', '1키로']);
    const m = await bySeq(A);
    assert.equal(m.get(1).option_text, '국산 고등어 · 1키로'); assert.equal(m.get(1).row_json['1차옵션'], '1키로'); assert.equal(m.get(1).row_json.상품, '국산 고등어');
    assert.equal(m.get(3).option_text, '국산 고등어 · 2kg');
    await buyAll(A, '1키로', 2, '국산 고등어 · 1키로');
    await buyAll(A, '2kg', 1, '국산 고등어 · 2kg');
  });

  await ok('[5] 채운 줄 = 산 당시 이름 그대로 · 메모 달린 빈 줄 = 바꾼다(옵션 이름 바꾸기와 같은 줄 범위) · 정원 셈 불변', async () => {
    const A = await setup('rp5', MACK());
    await paintRaw(A, s => v2c(...MACK_PLAN(s)));
    const first = await purchase(A, '1kg');   // 바로 구매 1건이 seq 1(또는 2)을 채움
    assert.equal(first.w.ok, true);
    const filledSeq = Number(first.row.seq);
    const before = await extCounts(A);
    const m0 = await bySeq(A);
    const memoSeq = 3;
    await pool.query(`INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_text, created_by) VALUES ($1,$2,'manual',$3,'memo','text','가짜 메모','시험')`, [A.sheet, A.tab, String(m0.get(memoSeq).id)]);
    await renameShared(A, 0, '국산 고등어');
    const m = await bySeq(A);
    assert.equal(m.get(filledSeq).option_text, m0.get(filledSeq).option_text, '채운 줄 표시 그대로');
    assert.deepEqual(m.get(filledSeq).row_json, m0.get(filledSeq).row_json, '채운 줄 칸 그대로');
    assert.equal(m.get(memoSeq).option_text, '국산 고등어 · 2kg', '메모 달린 빈 줄도 바꾼다');
    assert.deepEqual(await extCounts(A), before, '정원 셈(이미 산 주문의 옵션 귀속) 그대로');
    await buyAll(A, '1kg', 1, '국산 고등어 · 1kg');
  });

  await ok('[6] 애매 = 그 줄만 손대지 않음(이름 바꾸기는 성공) — 상품 칸에 다른 글 · 옵션 둘에 걸리는 줄', async () => {
    const A = await setup('rp6', MACK());
    await paintRaw(A, s => (s === 2 ? { ot: '고등어 · 1kg', rj: { 상품: '고등어 (냉동 따로)', '1차옵션': '1kg', 리뷰옵션: '포토' } } : v2c(...MACK_PLAN(s))));
    await renameShared(A, 0, '국산 고등어');
    const m = await bySeq(A);
    assert.equal(m.get(1).option_text, '국산 고등어 · 1kg', '보통 줄은 바뀜');
    assert.equal(m.get(2).option_text, '고등어 · 1kg', '상품 칸에 다른 글 = 그 줄 그대로');
    assert.equal(m.get(2).row_json.상품, '고등어 (냉동 따로)');
    // 순수 — 옵션 둘에 걸리는 줄(대소문자만 다른 옵션)
    const rows = [{ id: 1, option_text: '고등어 · 1kg', row_json: { 상품: '고등어', '1차옵션': '1kg' } }, { id: 2, option_text: '고등어 2팩 세트 · 기본', row_json: { 상품: '고등어 2팩 세트', '1차옵션': '기본' } }];
    const opts = [{ opt_key: '1kg', product_name: '국산 고등어', unit_kind: 'option' }, { opt_key: '1KG', product_name: '국산 고등어', unit_kind: 'option' }, { opt_key: '기본', product_name: '고등어 2팩 세트', unit_kind: 'option' }];
    const p = ren.planStagedProductRenames(rows, new Map([['고등어', '국산 고등어']]), opts);
    assert.equal(p.changes.size, 0, '걸리는 옵션 2개 = 손대지 않음'); assert.equal(p.skipped, 1);
    const p2 = ren.planStagedProductRenames(rows, new Map([['고등어', '국산 고등어']]), opts.filter(o => o.opt_key !== '1KG'));
    assert.deepEqual(p2.changes.get('1'), { option_text: '국산 고등어 · 1kg', row_json: { 상품: '국산 고등어', '1차옵션': '1kg' } });
  });

  await ok('[7] 공고 창 저장 길 — 상품 이름만 바꿔도(고등어 → 국산 고등어) v2 빈 줄 표시·상품 칸이 따라간다 · 주문 왕복', async () => {
    const A = await setup('rp7', MACK());
    await paintRaw(A, s => v2c(...MACK_PLAN(s)));
    await renameWindow(A, '고등어', '국산 고등어');
    const m = await bySeq(A);
    assert.equal(m.get(1).option_text, '국산 고등어 · 1kg'); assert.equal(m.get(1).row_json.상품, '국산 고등어');
    assert.equal(m.get(5).option_text, '고등어 2팩 세트 · 기본');
    await buyAll(A, '2kg', 2, '국산 고등어 · 2kg');
    await buyAll(A, '선물', 1, '고등어 2팩 세트 · 선물');
    // 연결 공고의 공고 창 = 양방향 공유 저장으로 간다 — 같은 결과
    const B = await setup('rp7l', MACK());
    await paintRaw(B, s => v2c(...MACK_PLAN(s)));
    await renameWindow(B, '고등어 2팩 세트', '고등어 선물 세트', { linked: true });
    const mb = await bySeq(B);
    assert.equal(mb.get(7).option_text, '고등어 선물 세트 · 선물'); assert.equal(mb.get(1).option_text, '고등어 · 1kg');
    await buyAll(B, '기본', 2, '고등어 선물 세트 · 기본');
  });

  await ok('[8] v1 작업보드(표시 = 옵션 이름) 상품 2개 — 표시 그대로 · 상품 칸은 새 이름(공유 저장 = 종전 · 공고 창 = 이제 같게) · 주문 왕복', async () => {
    const v1 = s => { const [p, o] = MACK_PLAN(s); return { ot: o, rj: { 상품: p, 옵션: o, 리뷰옵션: '포토' } }; };
    const A = await setup('rp8', MACK());
    await paintRaw(A, v1);
    await renameShared(A, 0, '국산 고등어');
    const m = await bySeq(A);
    assert.deepEqual([m.get(1).option_text, m.get(1).row_json.상품], ['1kg', '국산 고등어']);
    assert.deepEqual([m.get(5).option_text, m.get(5).row_json.상품], ['기본', '고등어 2팩 세트']);
    await buyAll(A, '1kg', 2, '1kg');
    const B = await setup('rp8w', MACK());
    await paintRaw(B, v1);
    await renameWindow(B, '고등어', '국산 고등어');
    const mb = await bySeq(B);
    assert.deepEqual([mb.get(3).option_text, mb.get(3).row_json.상품], ['2kg', '국산 고등어']);
    await buyAll(B, '2kg', 2, '2kg');
  });

  /** 상품 단위 공고(옵션 없는 상품 2개)로 바꾼 고정구 — 공고 이름은 「1.고등어 특가」「2.고등어 2팩 세트」, 작업보드 표시는 짧은 이름(포함 관계로 짝)
   *  seq 1·2 = 2팩 세트(앞날짜) · 3·4 = 고등어 */
  const productUnit = async (tag) => {
    const A = await setup(tag, MACK());
    await pool.query('DELETE FROM campaign_options WHERE campaign_id=$1', [A.camp]);
    let i = 0;
    for (const n of ['1.고등어 특가', '2.고등어 2팩 세트']) {
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, pay_amount, recruit_total, daily_limit, status, sort_order) VALUES ($1,$2,$2,'product',10000,4,2,'active',$3)`, [A.camp, n, i++]);
    }
    await paintRaw(A, s => { const p = s <= 2 ? '고등어 2팩 세트' : s <= 4 ? '고등어' : ''; return { ot: p, rj: { 상품: p, 리뷰옵션: '포토' } }; });
    return A;
  };
  /** 공고 창 상품 단위 이름 바꾸기와 같은 저장(선택지 이름 = 상품 이름 · applyOptionRenames + 상품 이름 칸) 뒤 빈 줄 따라가기 */
  const renameProductUnit = async (A, from, to) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT id FROM recruit_campaigns WHERE id=$1 FOR UPDATE', [A.camp]);
      const before = (await c.query('SELECT opt_key, product_name, unit_kind, status FROM campaign_options WHERE campaign_id=$1', [A.camp])).rows;
      const { rows } = await c.query('SELECT opt_key FROM campaign_options WHERE campaign_id=$1 ORDER BY sort_order, id', [A.camp]);
      await ren.applyOptionRenames(c, A.camp, rows.map(r => ({ optKey: r.opt_key === from ? to : r.opt_key, prevOptKey: r.opt_key })));
      await c.query('UPDATE campaign_options SET product_name=$3 WHERE campaign_id=$1 AND opt_key=$2', [A.camp, to, to]);
      const after = (await c.query('SELECT opt_key, product_name, unit_kind, status FROM campaign_options WHERE campaign_id=$1', [A.camp])).rows;
      // (고치기 전 코드에는 짝 함수가 없다 — 그때는 같은 짝을 그대로 넘겨 종전 빈 줄 함수의 결과를 본다 = RED 증거)
      const pairs = typeof ren.productRenamePairs === 'function' ? ren.productRenamePairs(before, after, [{ from, to }]) : [{ from, to }];
      await ren.relabelEmptySlotsInTx(c, A.camp, [], pairs);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };

  await ok('[9] 상품 단위 · 포함 관계로 짝지어진 짧은 표시(고등어 ← 「1.고등어 특가」) — 「1.참치 특가」로 바꾸면 고등어 줄이 새 이름을 따라가 상품만 고른 바로 구매가 자기 줄에 앉는다(종전: 다른 상품 줄을 잡음)', async () => {
    const A = await productUnit('rp9');
    await renameProductUnit(A, '1.고등어 특가', '1.참치 특가');
    const m = await bySeq(A);
    assert.deepEqual([m.get(3).option_text, m.get(3).row_json.상품], ['1.참치 특가', '1.참치 특가'], '고등어 줄 = 새 이름');
    assert.deepEqual([m.get(1).option_text, m.get(1).row_json.상품], ['고등어 2팩 세트', '고등어 2팩 세트'], '2팩 세트 줄 무접촉');
    await buyAll(A, '', 2, '1.참치 특가', '1.참치 특가');
    await buyAll(A, '', 1, '고등어 2팩 세트', '2.고등어 2팩 세트');
  });

  await ok('[9r] 증상(상품 단위) — 이름 바꾼 뒤 상품만 고른 바로 구매가 자기 상품(고등어) 줄에 앉는다(종전: 상품 미정 줄 · 미정 줄이 없으면 날짜가 앞선 다른 상품 줄을 잡음)', async () => {
    for (const allPlanned of [true, false]) {
      const A = await productUnit('rp9r' + (allPlanned ? 'p' : ''));
      if (allPlanned) await pool.query(`UPDATE campaign_participants SET option_text='고등어 2팩 세트', row_json = row_json || '{"상품":"고등어 2팩 세트"}'::jsonb WHERE sheet_id=$1 AND tab_name=$2 AND seq >= 5`, [A.sheet, A.tab]);
      await renameProductUnit(A, '1.고등어 특가', '1.참치 특가');
      const pr = await purchase(A, '', '1.참치 특가');
      assert.equal(pr.w.ok, true, JSON.stringify(pr.w));
      assert.ok([3, 4].includes(Number(pr.row.seq)), `${allPlanned ? '모든 줄 상품 계획' : '미정 줄 있음'}: 고등어 줄(3·4)에 앉아야 한다 — 실제 seq ${pr.row.seq}(1·2·${allPlanned ? '5~8 = 고등어 2팩 세트' : '5~8 = 상품 미정'})`);
    }
  });

  await ok('[10] 상품 단위 애매 — 새 이름이 다른 상품 표시를 품음(「1.고등어 2팩 세트 미니」) = 줄 그대로(이름 바꾸기는 성공) · 1개 작업보드 불변', async () => {
    const A = await productUnit('rp10');
    await renameProductUnit(A, '1.고등어 특가', '1.고등어 2팩 세트 미니');
    const m = await bySeq(A);
    assert.equal(m.get(3).option_text, '고등어', '그대로');
    assert.deepEqual((await A.opts()).map(o => o.opt_key).sort(), ['1.고등어 2팩 세트 미니', '2.고등어 2팩 세트'].sort(), '이름 바꾸기 자체는 됨');
    const B = await productUnit('rp10b');
    await pool.query(`UPDATE campaign_participants SET option_text='고등어', row_json = row_json || '{"상품":"고등어"}'::jsonb WHERE sheet_id=$1 AND tab_name=$2`, [B.sheet, B.tab]);
    await pool.query(`DELETE FROM campaign_options WHERE campaign_id=$1 AND opt_key='2.고등어 2팩 세트'`, [B.camp]);
    await renameProductUnit(B, '1.고등어 특가', '1.참치 특가');
    for (const r of await rowsOf(B)) assert.equal(r.option_text, '고등어', `상품 1개 작업보드 seq ${r.seq} 그대로`);
  });

  await ok('[12] 끄는 스위치 CAMPAIGN_PRODUCT_RENAME_SLOTS=0 = 종전(표시 옛 이름 그대로) · 상품 단위 바로 구매 정원 셈(loadExternalOptionOrders)은 스위치와 무관하게 같다', async () => {
    process.env.CAMPAIGN_PRODUCT_RENAME_SLOTS = '0';
    let A, B;
    try {
      A = await setup('rp12', MACK());
      await paintRaw(A, s => v2c(...MACK_PLAN(s)));
      await renameShared(A, 0, '국산 고등어');
      assert.equal((await bySeq(A)).get(1).option_text, '고등어 · 1kg', '스위치 끔 = 종전');
      B = await productUnit('rp12b');
      await buyAll(B, '', 1, '고등어', '1.고등어 특가');   // 이름 바꾸기 전 바로 구매(상품만 고름) 1건 — 채운 줄
      await renameProductUnit(B, '1.고등어 특가', '1.참치 특가');
    } finally { delete process.env.CAMPAIGN_PRODUCT_RENAME_SLOTS; }
    const C = await productUnit('rp12c');
    await buyAll(C, '', 1, '고등어', '1.고등어 특가');
    await renameProductUnit(C, '1.고등어 특가', '1.참치 특가');
    assert.equal((await bySeq(B)).get(4).option_text, '고등어', '끔 = 빈 줄 옛 표시');
    assert.equal((await bySeq(C)).get(4).option_text, '1.참치 특가', '켬 = 빈 줄 새 표시');
    assert.deepEqual(await extCounts(C), await extCounts(B), '이미 산 바로 구매의 상품 귀속 = 켜고 끔 같음(채운 줄 무접촉)');
    await buyAll(C, '', 1, '1.참치 특가', '1.참치 특가');
    const ec = await extCounts(C);
    assert.equal(ec['1.참치 특가'], 1, '새 이름 바로 구매 = 새 이름 상품으로 센다 ' + JSON.stringify(ec));
  });

  await ok('[13] 순수 — 상품 단위 갈래는 상품 단위 선택지만 · 옵션 이름 표기 줄(「1kg」)은 상품 이름이 그것을 품어도 손대지 않는다', async () => {
    const rows = [{ id: 'a', option_text: '1kg', row_json: { 상품: '고등어', 옵션: '1kg' } }, { id: 'b', option_text: '기본', row_json: { 상품: '고등어 2팩 세트', 옵션: '기본' } }];
    const opts = [{ opt_key: '1kg', product_name: '1kg 고등어 특가', unit_kind: 'option' }, { opt_key: '기본', product_name: '고등어 2팩 세트', unit_kind: 'option' }];
    const p = ren.planProductUnitRenames(rows, new Map([['1kg 고등어', '1kg 고등어 특가']]), opts);
    assert.equal(p.changes.size, 0, '옵션 단위 상품 이름 바꾸기 = 이 갈래 무접촉 ' + JSON.stringify([...p.changes]));
    const opts2 = [{ opt_key: '1kg', product_name: '1kg', unit_kind: 'option' }, { opt_key: '1kg 고등어 특가', product_name: '1kg 고등어 특가', unit_kind: 'product' }];
    const p2 = ren.planProductUnitRenames(rows, new Map([['1kg 고등어', '1kg 고등어 특가']]), opts2);
    assert.equal(p2.changes.size, 0, '옵션 이름 표기 줄은 상품 단위 짝 대상이 아니다 ' + JSON.stringify([...p2.changes]));
    // 상품 칸이 공고 옛 이름 그대로인 짧은 표시 줄 = 상품 칸도 새 이름
    const rows3 = [{ id: 'c', option_text: '고등어', row_json: { 상품: '1.고등어 특가' } }, { id: 'd', option_text: '고등어 2팩 세트', row_json: { 상품: '고등어 2팩 세트' } }];
    const opts3 = [{ opt_key: '1.참치 특가', product_name: '1.참치 특가', unit_kind: 'product' }, { opt_key: '2.고등어 2팩 세트', product_name: '2.고등어 2팩 세트', unit_kind: 'product' }];
    const p3 = ren.planProductUnitRenames(rows3, new Map([['1.고등어 특가', '1.참치 특가']]), opts3);
    assert.deepEqual(p3.changes.get('c'), { option_text: '1.참치 특가', row_json: { 상품: '1.참치 특가' } });
    assert.ok(!p3.changes.has('d'));
  });

  // ── 순수·정적 ──
  await ok('[11] 정적 — 단일 출처(주문 줄 고르기 stagedSlotRows·resolveProductLabel · 칸 규칙 relabelRowCells) · 호출처 3곳 · 끄는 스위치', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'campaignOptionRename.service.js'), 'utf8');
    for (const fn of ['planStagedProductRenames', 'planProductUnitRenames', 'productRenamePairs']) assert.equal(typeof ren[fn], 'function', fn);
    const a = src.slice(src.indexOf('function planStagedProductRenames'), src.indexOf('function planProductUnitRenames'));
    assert.match(a, /_stagedOwners\(|stagedSlotRows\(/, 'v2 짝 = 주문 줄 고르기 함수');
    assert.match(a, /stagedLabelMatches\(/, '되읽기');
    assert.match(a, /relabelRowCells\(/, '칸 = 같은 칸 규칙 함수');
    const c = src.slice(src.indexOf('function planProductUnitRenames'), src.indexOf('function productRenamePairs'));
    assert.match(c, /resolveProductLabel\(/, '상품 단위 짝 = 주문 쪽 상품 짝짓기 함수');
    assert.match(c, /relabelRowCells\(/);
    assert.ok(!/1차\|1st/.test(a + c), '부품 칸 열 이름 규칙 사본 0');
    assert.match(src, /CAMPAIGN_PRODUCT_RENAME_SLOTS/, '끄는 스위치');
    const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'campaign.routes.js'), 'utf8');
    const save = routes.slice(routes.indexOf('async function _saveCampaignOptions'), routes.indexOf("await client.query('COMMIT')", routes.indexOf('async function _saveCampaignOptions')));
    assert.match(save, /productRenamePairs\(/, '공고 창 저장 = 같은 짝 함수');
    assert.match(save, /relabelEmptySlotsInTx\(/, '공고 창 저장 = 같은 빈 줄 함수');
    assert.match(save.slice(save.indexOf('productRenamePairs(')), /isQnaTab\([\s\S]*?!_qna\) await _ren\.relabelEmptySlotsInTx/, 'Q&A 자리표는 건드리지 않는다(결정 321)');
  });

  console.log(`productRenameSlotsPg: ${passed} passed${failed ? `, ${failed} failed` : ''}`);
  await H.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
