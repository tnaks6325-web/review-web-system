'use strict';
/**
 * optionRenameV2SlotsPg.test.js — 결정 401: 공고 옵션 이름을 바꾸면 v2 작업보드(「상품 · 옵션」 표시 · 1차·2차옵션 칸)의
 *   손 안 댄 빈 줄도 새 이름을 따라간다(종전: v1 빈 줄만 따라가 새 이름 바로 구매가 「빈 줄 없음」 → 정원 밖 새 줄).
 *   PGlite + 저장소 migrations 전부 + 실제 앱(인트라넷 원본 수정 PUT · 양방향 공유 저장 이름 바꾸기) + 공고 창 저장과 같은 함수(applyOptionRenames)
 *   + 실제 주문 기록 함수(writeOrderToWorktable)로 「새 이름 주문이 그 줄을 잡는다 · 정원 밖 새 줄 0」을 확인한다.
 *   시험 데이터는 모두 가짜 값.
 */
const assert = require('assert');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const fs = require('fs');
const path = require('path');
const F = require('./helpers/r1QtyTiersFixture');

let passed = 0, failed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.log('  ✗ ' + name); console.log('    → ' + String(e.message).split('\n')[0].slice(0, 500)); } };

const OPTP = (name, opts) => ([{
  name, url: 'https://www.coupang.com/vp/products/701', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] },
  options: opts.map(([v, count]) => ({ option_1: { name: '', value: v }, label: v, url: '', pay: 10000, count, daily: 1, review_type_mix: [] })),
}]);
const OPTP2 = (name, opts) => ([{
  name, url: 'https://www.coupang.com/vp/products/702', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] },
  options: opts.map(([v1, v2, count]) => ({ option_1: { name: '색', value: v1 }, option_2: { name: '크기', value: v2 }, label: `${v1} + ${v2}`, url: '', pay: 10000, count, daily: 1, review_type_mix: [] })),
}]);
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const dayLabel = i => { const d = new Date(Date.UTC(2026, 11, 1 + i)); return `${d.getUTCMonth() + 1} / ${d.getUTCDate()} (${WD[d.getUTCDay()]})`; };
/** v2 빈 줄 모양(접수가 까는 그대로): 표시 「상품 · 1차[ · 2차]」 · 상품 칸 · 1차옵션 칸 · (2단이면) 2차옵션 칸 */
const v2c = (p, o1, o2 = '') => ({ ot: [p, o1, o2].filter(Boolean).join(' · '), rj: { 상품: p, '1차옵션': o1, ...(o2 ? { '2차옵션': o2 } : {}), 리뷰옵션: '포토' } });

(async () => {
  const { pool } = await F.installPglitePool();
  const H = await F.boot({ pool });
  const { setup, tierEdit } = H;
  const so = require('../src/services/sheetlessOrder.service');
  so.__setPoolForTest(pool);
  const ren = require('../src/services/campaignOptionRename.service');

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
  /** 인트라넷 구조 이름 바꾸기(실제 원본 수정 PUT) — 옵션 i 를 새 1·2차 값으로 */
  const renameShared = async (A, i, { v1, v2 = null }) => {
    const cur = await A.wo(); const p = JSON.parse(cur.product_options_json);
    const o = p[0].options[i];
    const nv1 = v1 == null ? o.option_1.value : v1;
    const nv2 = v2 == null ? (o.option_2 ? o.option_2.value : '') : v2;
    p[0].options[i] = { ...o, prev_label: o.label, label: nv2 ? `${nv1} + ${nv2}` : nv1, option_1: { ...o.option_1, value: nv1 }, ...(o.option_2 ? { option_2: { ...o.option_2, value: nv2 } } : {}) };
    const r = await A.putSource(tierEdit({ ...cur, product_options_json: JSON.stringify(p) }, () => {}), { structure: 1, rename: 1 });
    assert.equal(r.status, 200, '이름 바꾸기 저장은 성공 ' + JSON.stringify(r.body));
    return r;
  };
  /** 공고 창 저장과 같은 이름 바꾸기 함수(applyOptionRenames) — 잠금·트랜잭션은 공고 창 저장처럼 공고 행 FOR UPDATE 안 */
  const renameWindow = async (A, pairs) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT id FROM recruit_campaigns WHERE id=$1 FOR UPDATE', [A.camp]);
      const { rows } = await c.query('SELECT opt_key FROM campaign_options WHERE campaign_id=$1 ORDER BY sort_order, id', [A.camp]);
      const m = new Map(pairs);
      const done = await ren.applyOptionRenames(c, A.camp, rows.map(r => ({ optKey: m.get(r.opt_key) || r.opt_key, prevOptKey: r.opt_key })));
      await c.query('COMMIT');
      return done;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
  let osn = 0;
  const purchase = async (A, optKey) => {
    osn += 1;
    const { rows } = await pool.query(`INSERT INTO order_submissions (sheet_id, tab_name, recipient, orderer, phone, price, order_num, mirror_status, source, selected_opt_key, selected_product)
      VALUES ($1, $2, '가짜구매', '가짜구매', $3, '10000', $4, 'queued', 'order_submit', $5, '') RETURNING id`, [A.sheet, A.tab, `010-7400-${String(1000 + osn)}`, `RN${osn}${Date.now()}`, optKey]);
    const w = await so.writeOrderToWorktable({ sheetId: A.sheet, tabName: A.tab, orderSubmissionId: rows[0].id,
      orderData: { recipient: '가짜구매', orderer: '가짜구매', phone: `010-7400-${String(1000 + osn)}`, price: '10000', orderNum: `RN${osn}`, selectedOptKey: optKey, selectedProduct: '' } });
    const { rows: got } = await pool.query('SELECT seq, option_text, row_json FROM campaign_participants WHERE order_submission_id=$1 AND deleted_at IS NULL', [rows[0].id]);
    return { w, row: got[0] };
  };
  /** 새 이름으로 n 건 사서 — 모두 기존 빈 줄(pre 에 있던 줄)에 앉는가 · 그 줄의 바꾼 뒤 표시가 want 인가 · 줄 수 그대로인가 */
  const buyAll = async (A, key, n, wantLabel) => {
    const pre = await bySeq(A); const before = await A.rows();
    const seats = [];
    for (let i = 0; i < n; i++) {
      const pr = await purchase(A, key);
      assert.equal(pr.w.ok, true, `${key} 주문 기록 ${JSON.stringify(pr.w)}`);
      assert.ok(pr.row && pre.has(Number(pr.row.seq)), `${key} 주문이 기존 빈 줄에 앉는다(정원 밖 새 줄 0) seq=${pr.row && pr.row.seq}`);
      assert.equal(String(pre.get(Number(pr.row.seq)).option_text), wantLabel, `${key} 주문이 고른 줄의 표시`);
      seats.push(pr.row);
    }
    assert.equal(await A.rows(), before, '줄 수 그대로(정원 밖 새 줄 0)');
    return seats;
  };

  await ok('[0] 증상 — v2 1단 XL → 엑스라지 뒤 새 이름 바로 구매 1건이 기존 빈 줄에 앉는다(종전: 빈 줄 없음 → 정원 밖 새 줄)', async () => {
    const A = await setup('v2s', OPTP('티셔츠', [['블루', 2], ['XL', 2]]));
    await paintRaw(A, s => v2c('티셔츠', s % 2 ? '블루' : 'XL'));
    await renameShared(A, 1, { v1: '엑스라지' });
    const pre = await bySeq(A);
    const pr = await purchase(A, '엑스라지');
    assert.ok(pr.w.ok && pr.row && pre.has(Number(pr.row.seq)), `기존 빈 줄에 앉음 ${JSON.stringify({ w: pr.w, seq: pr.row && pr.row.seq, rows: await A.rows() })}`);
    assert.equal(await A.rows(), 4, '정원 밖 새 줄 0');
  });

  await ok('[1] v2 1단 · 양방향 공유 저장 — 티셔츠 · XL → 엑스라지: 빈 줄 표시 「티셔츠 · 엑스라지」 · 1차옵션 칸 「엑스라지」 · 상품 칸 그대로 · 새 이름 주문 2건이 그 줄을 잡음 · 정원 밖 0', async () => {
    const A = await setup('v2a', OPTP('티셔츠', [['블루', 2], ['XL', 2]]));
    await paintRaw(A, s => v2c('티셔츠', s % 2 ? '블루' : 'XL'));
    await renameShared(A, 1, { v1: '엑스라지' });
    assert.deepEqual((await A.opts()).map(o => o.opt_key), ['블루', '엑스라지']);
    for (const r of await rowsOf(A)) {
      const blue = Number(r.seq) % 2 === 1;
      assert.equal(r.option_text, blue ? '티셔츠 · 블루' : '티셔츠 · 엑스라지', `seq ${r.seq} 표시`);
      assert.equal(r.row_json['1차옵션'], blue ? '블루' : '엑스라지', `seq ${r.seq} 1차옵션 칸 = 부품 값`);
      assert.equal(r.row_json.상품, '티셔츠', '상품 칸 그대로');
      assert.equal(r.row_json.리뷰옵션, '포토', '리뷰옵션 칸 무접촉');
      if (!blue) assert.equal(r.updated_by, 'option-rename', 'v1 과 같은 기록 표시');
    }
    const seats = await buyAll(A, '엑스라지', 2, '티셔츠 · 엑스라지');
    for (const s of seats) assert.equal(s.row_json['1차옵션'], '엑스라지');
    await buyAll(A, '블루', 2, '티셔츠 · 블루');
  });

  await ok('[2] v2 2단 · 1차만 — 블루 + S → 네이비 + S: 표시 「티셔츠 · 네이비 · S」 · 1차옵션 「네이비」 · 2차옵션 「S」 그대로 · 다른 선택(블루 + M) 무접촉 · 주문 왕복', async () => {
    const A = await setup('v2b', OPTP2('티셔츠', [['블루', 'S', 2], ['블루', 'M', 2]]));
    await paintRaw(A, s => v2c('티셔츠', '블루', s % 2 ? 'S' : 'M'));
    await renameShared(A, 0, { v1: '네이비' });
    assert.deepEqual((await A.opts()).map(o => o.opt_key).sort(), ['네이비 + S', '블루 + M'].sort());
    for (const r of await rowsOf(A)) {
      const s = Number(r.seq) % 2 === 1;
      assert.equal(r.option_text, s ? '티셔츠 · 네이비 · S' : '티셔츠 · 블루 · M', `seq ${r.seq}`);
      assert.deepEqual([r.row_json['1차옵션'], r.row_json['2차옵션']], s ? ['네이비', 'S'] : ['블루', 'M'], `seq ${r.seq} 부품 칸`);
    }
    await buyAll(A, '네이비 + S', 2, '티셔츠 · 네이비 · S');
    await buyAll(A, '블루 + M', 2, '티셔츠 · 블루 · M');
  });

  await ok('[3] v2 2단 · 2차만 — 블루 + S → 블루 + L: 표시 「티셔츠 · 블루 · L」 · 1차 그대로 · 2차옵션 「L」 · 주문 왕복', async () => {
    const A = await setup('v2c', OPTP2('티셔츠', [['블루', 'S', 2], ['블루', 'M', 2]]));
    await paintRaw(A, s => v2c('티셔츠', '블루', s % 2 ? 'S' : 'M'));
    await renameShared(A, 0, { v2: 'L' });
    for (const r of await rowsOf(A)) {
      const s = Number(r.seq) % 2 === 1;
      assert.equal(r.option_text, s ? '티셔츠 · 블루 · L' : '티셔츠 · 블루 · M', `seq ${r.seq}`);
      assert.deepEqual([r.row_json['1차옵션'], r.row_json['2차옵션']], s ? ['블루', 'L'] : ['블루', 'M']);
    }
    await buyAll(A, '블루 + L', 2, '티셔츠 · 블루 · L');
  });

  await ok('[4] 공고 창 저장 길(applyOptionRenames) — v2 1단 XL → 엑스라지 · 맞바꾸기(블루↔엑스라지)도 서로 맞게', async () => {
    const A = await setup('v2w', OPTP('티셔츠', [['블루', 2], ['XL', 2]]));
    await paintRaw(A, s => v2c('티셔츠', s % 2 ? '블루' : 'XL'));
    const done = await renameWindow(A, [['XL', '엑스라지']]);
    assert.equal(done.length, 1);
    const m = await bySeq(A);
    assert.equal(m.get(2).option_text, '티셔츠 · 엑스라지'); assert.equal(m.get(2).row_json['1차옵션'], '엑스라지');
    await renameWindow(A, [['블루', '엑스라지'], ['엑스라지', '블루']]);
    const m2 = await bySeq(A);
    assert.equal(m2.get(1).option_text, '티셔츠 · 엑스라지'); assert.equal(m2.get(1).row_json['1차옵션'], '엑스라지');
    assert.equal(m2.get(2).option_text, '티셔츠 · 블루'); assert.equal(m2.get(2).row_json['1차옵션'], '블루');
    await buyAll(A, '엑스라지', 2, '티셔츠 · 엑스라지');
    await buyAll(A, '블루', 2, '티셔츠 · 블루');
  });

  await ok('[5] v1 불변 — 표시 = 옵션 이름 줄: 표시·옵션 칸·1차옵션 칸(통째 이름) 종전대로 · 주문 왕복', async () => {
    const A = await setup('v1', OPTP('티셔츠', [['블루', 2], ['XL', 2]]));
    await paintRaw(A, s => { const l = s % 2 ? '블루' : 'XL'; return { ot: l, rj: { 상품: '티셔츠', 옵션: l, '1차옵션': l, 리뷰옵션: '포토' } }; });
    await renameShared(A, 1, { v1: '엑스라지' });
    for (const r of await rowsOf(A)) {
      const l = Number(r.seq) % 2 ? '블루' : '엑스라지';
      assert.deepEqual([r.option_text, r.row_json.옵션, r.row_json['1차옵션'], r.row_json.상품], [l, l, l, '티셔츠'], `seq ${r.seq}`);
    }
    await buyAll(A, '엑스라지', 2, '엑스라지');
  });

  await ok('[6] 채운 줄 = 산 당시 이름 그대로(v1·v2) · 사람 기록(메모) 달린 빈 줄 = v1 과 같이 바꾼다', async () => {
    const A = await setup('fill', OPTP('티셔츠', [['블루', 3], ['XL', 3]]));
    await paintRaw(A, s => (s === 6 ? { ot: 'XL', rj: { 상품: '티셔츠', '1차옵션': 'XL', 리뷰옵션: '포토' } } : v2c('티셔츠', s % 2 ? '블루' : 'XL')));
    const m0 = await bySeq(A);
    // seq 2 = 산 사람이 있는 v2 줄 · seq 6 = 산 사람이 있는 v1 줄 · seq 4 = 메모 달린 v2 빈 줄
    await pool.query(`UPDATE campaign_participants SET reviewer_name='가짜리뷰어', recipient_name='가짜수취', phone8='74001234' WHERE id = ANY($1::uuid[])`, [[m0.get(2).id, m0.get(6).id]]);
    await pool.query(`INSERT INTO participant_edits (sheet_id, tab_name, anchor_type, anchor_value, field, kind, value_text, created_by) VALUES ($1,$2,'manual',$3,'memo','text','가짜 메모','시험')`, [A.sheet, A.tab, String(m0.get(4).id)]);
    await renameShared(A, 1, { v1: '엑스라지' });
    const m = await bySeq(A);
    assert.equal(m.get(2).option_text, '티셔츠 · XL', '채운 v2 줄 = 옛 이름'); assert.equal(m.get(2).row_json['1차옵션'], 'XL');
    assert.equal(m.get(6).option_text, 'XL', '채운 v1 줄 = 옛 이름');
    assert.equal(m.get(4).option_text, '티셔츠 · 엑스라지', '메모 달린 빈 줄도 바꾼다(v1 과 같음)');
    await buyAll(A, '엑스라지', 1, '티셔츠 · 엑스라지');
  });

  await ok('[7] 모호·모르는 칸 = 그 줄만 손대지 않음(fail-closed) · 이름 바꾸기는 성공 · 나머지 줄은 바뀜', async () => {
    // (a) 1차옵션 칸에 다른 값(작업지시) · (b) 2단 줄인데 새 이름에 ' + ' 가 없음(단 수가 바뀜 — 칸을 모름)
    const A = await setup('amb', OPTP('티셔츠', [['블루', 2], ['XL', 2]]));
    await paintRaw(A, s => (s === 4 ? { ot: '티셔츠 · XL', rj: { 상품: '티셔츠', '1차옵션': 'XL 포장 따로', 리뷰옵션: '포토' } } : v2c('티셔츠', s % 2 ? '블루' : 'XL')));
    await renameShared(A, 1, { v1: '엑스라지' });
    const m = await bySeq(A);
    assert.equal(m.get(2).option_text, '티셔츠 · 엑스라지', '보통 줄은 바뀜');
    assert.equal(m.get(4).option_text, '티셔츠 · XL', '작업지시 적힌 줄 = 그대로'); assert.equal(m.get(4).row_json['1차옵션'], 'XL 포장 따로');
    const B = await setup('amb2', OPTP2('티셔츠', [['블루', 'S', 2], ['블루', 'M', 2]]));
    await paintRaw(B, s => v2c('티셔츠', '블루', s % 2 ? 'S' : 'M'));
    const done = await renameWindow(B, [['블루 + S', '블루S']]);
    assert.equal(done.length, 1, '이름 바꾸기 자체는 됨');
    const mb = await bySeq(B);
    assert.equal(mb.get(1).option_text, '티셔츠 · 블루 · S', '2단 줄 → 1단 이름 = 칸을 모름 → 그대로');
    assert.deepEqual((await B.opts()).map(o => o.opt_key).sort(), ['블루 + M', '블루S'].sort());
  });

  await ok('[8] 모호 — 여러 상품이 섞인 작업보드에서 줄 상품이 공고 상품과 다르면 주문도 짝을 못 짓는다 → 그 줄 그대로', async () => {
    const A = await setup('mp', OPTP('티셔츠', [['블루', 2], ['XL', 2]]));
    await paintRaw(A, s => v2c(s <= 2 ? '셔츠' : '바지', s % 2 ? '블루' : 'XL'));
    await renameShared(A, 1, { v1: '엑스라지' });
    const m = await bySeq(A);
    assert.equal(m.get(2).option_text, '셔츠 · XL'); assert.equal(m.get(4).option_text, '바지 · XL');
  });

  // ── 순수·정적 ──
  await ok('[9] 순수 — planStagedRenames: 대소문자만 다른 살아 있는 옵션(xl)이 있으면 그 줄은 두 옵션에 걸림 → 손대지 않음 · 단일 출처(주문 줄 고르기·칸 규칙)', async () => {
    assert.equal(typeof ren.planStagedRenames, 'function', 'planStagedRenames 가 있다');
    const rows = [{ id: 1, option_text: '티셔츠 · XL', row_json: { 상품: '티셔츠', '1차옵션': 'XL' } }, { id: 2, option_text: '티셔츠 · 블루', row_json: { 상품: '티셔츠', '1차옵션': '블루' } }];
    const opts = [{ opt_key: '엑스라지', product_name: '티셔츠', unit_kind: 'option' }, { opt_key: 'xl', product_name: '티셔츠', unit_kind: 'option' }, { opt_key: '블루', product_name: '티셔츠', unit_kind: 'option' }];
    const p = ren.planStagedRenames(rows, new Map([['XL', '엑스라지']]), opts);
    assert.equal(p.changes.size, 0, '걸리는 옵션 2개 = 손대지 않음 ' + JSON.stringify([...p.changes]));
    assert.equal(p.skipped, 1);
    const p2 = ren.planStagedRenames(rows, new Map([['XL', '엑스라지']]), opts.filter(o => o.opt_key !== 'xl'));
    assert.deepEqual(p2.changes.get('1'), { option_text: '티셔츠 · 엑스라지', row_json: { 상품: '티셔츠', '1차옵션': '엑스라지' } });
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'campaignOptionRename.service.js'), 'utf8');
    const body = src.slice(src.indexOf('function planStagedRenames'), src.indexOf('async function relabelEmptySlotsInTx'));
    assert.ok(body.length > 200, 'planStagedRenames 본문');
    assert.match(body, /stagedSlotRows\(/, '짝 = 주문 줄 고르기 함수');
    assert.match(body, /_stagedLabelMatches|stagedLabelMatches\(/, '되읽기 = 주문 쪽 같은 선택 판정');
    assert.match(body, /selectionKey\(/, '새 표시 = 접수 표시 함수');
    assert.match(src, /relabelRowCells\(rj, \{ optFrom: \[ot\], optTo: (?:nextOt|ch\.option_text)/, '칸 = 같은 칸 규칙 함수');
    assert.ok(!/1차\|1st/.test(body), '부품 칸 열 이름 규칙 사본 0');
  });

  console.log(`optionRenameV2SlotsPg: ${passed} passed${failed ? `, ${failed} failed` : ''}`);
  await H.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
