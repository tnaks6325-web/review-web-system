'use strict';
/**
 * optionSlotsRebalance.test.js — 결정 394 회귀가드(순수 함수 · 정적). PGlite 실행 시험은 optionSlotsRebalancePg.test.js.
 *   ① 사람 기록 표 분류 = 결정 254 표 분류(workTabDelete DELETE/MONEY/KEEP) 전수(새 표가 생기면 여기도 분류해야 초록)
 *   ② 안내 문구 — 「없습니다·실패·초과·불가·오류」 낱말 0(인트라넷 알림 색이 낱말로 정해진다)
 *   ③ 짝 규칙 단일 출처 — 주문 줄 고르기(stagedSlotRows · resolveProductLabel)와 정원 셈(matchOrderOption)을 꺼내 쓴다 · 이름 바꾸기와 같은 칸 규칙(relabelRowCells)
 *   ④ planOptionSlots 순수 갈래 — 포함 관계 짝 · 맞출 수 없음 = 통째 건너뜀 · 사람 기록 고정 · 칸 규칙 · 날짜 고루(변이 자가검사 포함)
 *   ⑤ 트리거·잠금 순서 — 선택지 인원(recruitTotal)만 · reconcile 제외 · 탭 잠금이 공고 행보다 먼저
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let passed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { console.log('  ✗ ' + name); throw e; } };

(async () => {
  const S = require('../src/services/worktableOptionSlots.service');
  const W = require('../src/services/workTabDelete.service');

  await ok('① 사람 기록 표 분류 = 결정 254 표 분류 전수(겹침 0 · 빠짐 0)', async () => {
    const all = new Set([...W.DELETE_TABLES, ...W.MONEY_TABLES.map(x => x.table), ...W.KEEP_TABLES.map(x => x.table)]);
    const row = Object.keys(S.ROW_RECORD_TABLES), tab = Object.keys(S.TAB_LEVEL_TABLES);
    assert.deepEqual(row.filter(t => tab.includes(t)), [], '두 분류에 동시에 든 표 없음');
    const mine = new Set([...row, ...tab]);
    assert.deepEqual([...all].filter(t => !mine.has(t)), [], '254 표 가운데 분류 안 된 표');
    assert.deepEqual([...mine].filter(t => !all.has(t)), [], '254 목록에 없는 표를 분류(오타)');
    for (const t of tab) assert.ok(String(S.TAB_LEVEL_TABLES[t]).trim(), `${t}: 빼는 이유 한 줄`);
    for (const t of ['participant_edits', 'trackb_cell_colors', 'trackb_custom_columns', 'manual_payment_marks', 'payment_batch_items', 'review_submissions', 'reviewer_participations']) assert.ok(row.includes(t), t);
    assert.match(S.ROW_RECORD_TABLES.participant_edits, /reverted_at IS NULL/);
    assert.match(S.ROW_RECORD_TABLES.trackb_custom_columns, /btrim\(COALESCE\(v\.value_text, ''\)\) <> ''/);
    assert.match(S.ROW_RECORD_TABLES.reviewer_participations, /owner_reviewer_id IS NOT NULL OR order_submission_id IS NOT NULL/, '빈 줄마다 있는 archived 자리 행은 기록이 아니다');
  });

  await ok('② 안내 문구 — 모든 사유 · 리뷰타입 섞어 쓰기 · 확인 못 함: 알림 색 낱말 0 · 같은 모양', async () => {
    const BANNED = /없습니다|실패|초과|불가|오류/;
    const reasons = [...Object.keys(S.REASON_TEXT), 'check_failed'];
    for (const r of reasons) for (const mix of [false, true]) {
      const t = S.noticeFor(r, { option: '피치', fixed: 70, target: 60, rows: 10, sum: 12 }, { reviewMix: mix });
      assert.ok(t && t.length > 20, r); assert.doesNotMatch(t, BANNED, `${r}: ${t}`);
      if (r !== 'check_failed') { assert.match(t, /^작업보드 빈 줄의 옵션 표시는 그대로입니다 — /); assert.match(t, /필요하면 리뷰웹 작업보드에서 직접 고쳐주세요\.$/); }
    }
    assert.match(S.noticeFor('over_target', { option: '피치', fixed: 70, target: 60 }), /「피치」은 이미 채우거나 손댄 줄\(70줄\)이 새 인원\(60명\)보다 많아요/);
    assert.doesNotMatch(S.noticeFor('unknown_code'), BANNED, '모르는 사유 = 확인 못 함 문구');
  });

  await ok('③ 짝 규칙 단일 출처 — 주문 줄 고르기·정원 셈·이름 바꾸기 함수를 꺼내 쓴다(새 규칙 0)', async () => {
    const src = read('src/services/worktableOptionSlots.service.js');
    assert.match(src, /so\.resolveProductLabel\(/, '상품 단위 = 주문 쪽 포함 관계 짝짓기');
    assert.match(src, /so\.stagedSlotRows\(/, 'v2 「상품 · 옵션」 = 주문 쪽 거르기');
    assert.match(src, /String\(s\.ot\) === o\.opt_key/, '옵션 단위 = 주문 SQL 과 같은 원문 일치(cp.option_text = $4)');
    assert.match(src, /matchOrderOption\(opts, \{ selectedOptKey: r\.selected_opt_key, optionText: r\.option_text, selectedProduct: r\.selected_product,\s*rowProduct: r\.row_product, editedProduct: r\.edited_product, submittedAt: r\.submitted_at \}\)/, '채운 줄 = 정원 셈과 같은 함수·같은 입력');
    assert.match(src, /relabelRowCells\(s\.rj,/, '칸 규칙 = 이름 바꾸기와 같은 함수');
    const so = read('src/services/sheetlessOrder.service.js');
    assert.match(so, /await client\.query\('RELEASE SAVEPOINT slot_pick_staged'\);\n\s+return stagedSlotRows\(rows, key, productName\);/, '주문 줄 고르기가 같은 함수를 쓴다');
    assert.match(read('src/services/campaignOptionRename.service.js'), /rj = relabelRowCells\(rj, \{ optFrom: \[ot\], optTo: nextOt \}\);/, '이름 바꾸기가 같은 함수를 쓴다');
    // 꺼낸 함수의 동작 = 종전(상품까지 맞음 → 없으면 상품 1종일 때만 옵션만)
    const { stagedSlotRows } = require('../src/services/sheetlessOrder.service');
    const rows = [{ id: 1, option_text: '가습기 · 화이트' }, { id: 2, option_text: '가습기 · 블랙' }, { id: 3, option_text: '화이트' }];
    assert.deepEqual(stagedSlotRows(rows, '화이트', '가습기').map(r => r.id), [1]);
    assert.deepEqual(stagedSlotRows(rows, '화이트', '다른 이름').map(r => r.id), [1], '상품 1종이면 옵션만으로');
    assert.deepEqual(stagedSlotRows([...rows, { id: 4, option_text: '선풍기 · 화이트' }], '화이트', '다른 이름').map(r => r.id), [], '상품 2종이면 짝 없음');
    const { relabelRowCells } = require('../src/services/campaignOptionRename.service');
    const rj = { 옵션: '블루', 상품: '', 비고: '블루' };
    assert.deepEqual(relabelRowCells(rj, { optFrom: ['블루'], optTo: '라지', productFrom: ['티셔츠'], productTo: '티셔츠' }), { 옵션: '라지', 상품: '', 비고: '블루' }, '빈 칸은 빈 칸 · 옵션 칸만 · 다른 칸 무접촉');
    assert.deepEqual(rj, { 옵션: '블루', 상품: '', 비고: '블루' }, '입력 불변');
    assert.deepEqual(relabelRowCells({ 옵션: '' }, { optFrom: [''], optTo: 'X' }), { 옵션: '' }, '빈 글자는 어떤 From 과도 짝짓지 않는다');
  });

  // ── ④ 순수 계획 ──
  const opt = (opt_key, recruit_total, product_name = '티셔츠', unit_kind = 'option') => ({ opt_key, recruit_total, product_name, unit_kind, status: 'active' });
  let id = 0;
  const row = (label, extra = {}) => ({ id: `r${++id}`, seq: id, option_text: label, row_json: { 옵션: label || '', 상품: extra.product == null ? '티셔츠' : extra.product, ...(extra.rj || {}) }, filled: !!extra.filled, protected: !!extra.prot, overlay: null });
  const reset = () => { id = 0; };
  const counts = (rows, moves) => { const mv = new Map(moves.map(m => [m.id, m.to])); const c = {}; for (const r of rows) if (!r.filled) { const l = mv.get(r.id) || r.option_text || ''; c[l] = (c[l] || 0) + 1; } return c; };

  await ok('④-1 옵션 단위(상품명≠옵션명) 5/5 → 7/3 · 띄엄띄엄 내놓기 · 상품 단위 포함 관계(고등어 2팩 세트 ↔ 고등어)', async () => {
    reset();
    const rows = Array.from({ length: 10 }, (_, i) => row(i % 2 ? '라지' : '블루'));
    const p = S.planOptionSlots({ opts: [opt('블루', 7), opt('라지', 3)], rows, filledKey: new Map() });
    assert.equal(p.status, 'applied'); assert.deepEqual(counts(rows, p.moves), { 블루: 7, 라지: 3 });
    assert.deepEqual(p.moves.map(m => m.seq), [4, 8], '라지 줄(2,4,6,8,10) 가운데 띄엄띄엄 — 뒤 날짜 몰림 금지');
    for (const m of p.moves) assert.deepEqual(m.row_json, { 옵션: '블루', 상품: '티셔츠' });
    reset();
    const fish = Array.from({ length: 10 }, (_, i) => { const l = i % 2 ? '옥돔 1kg' : '고등어 2팩 세트'; return { ...row(l, { product: l }), row_json: { 상품: l } }; });
    const q = S.planOptionSlots({ opts: [opt('고등어', 7, '고등어', 'product'), opt('옥돔', 3, '옥돔', 'product')], rows: fish, filledKey: new Map() });
    assert.equal(q.status, 'applied', JSON.stringify(q)); assert.deepEqual(counts(fish, q.moves), { '고등어 2팩 세트': 7, '옥돔 1kg': 3 });
    for (const m of q.moves) assert.equal(m.row_json.상품, '고등어 2팩 세트', '상품 칸도 새 표시(계획 상품 칸만 남는 모양 금지)');
  });

  await ok('④-2 맞출 수 없음 = 통째 건너뜀(일부만 옮기기 0) — 채운 줄 > 새 인원 · 짝 없는 표시 · 여러 옵션에 걸림 · 채운 줄 귀속 모름 · 줄 수 ≠ 합', async () => {
    reset();
    let rows = [row('블루', { filled: true }), row('블루', { filled: true }), row('블루', { filled: true }), row('라지'), row('라지')];
    let p = S.planOptionSlots({ opts: [opt('블루', 2), opt('라지', 3)], rows, filledKey: new Map(rows.filter(r => r.filled).map(r => [r.id, '블루'])) });
    assert.equal(p.reason, 'over_target'); assert.equal(p.moves, undefined, '쓰기 0');
    reset(); rows = [row('블루'), row('모르는 표시'), row('라지')];
    assert.equal(S.planOptionSlots({ opts: [opt('블루', 2), opt('라지', 1)], rows, filledKey: new Map() }).reason, 'label_unmatched');
    reset(); rows = [row('블루', { filled: true }), row('라지')];
    assert.equal(S.planOptionSlots({ opts: [opt('블루', 1), opt('라지', 1)], rows, filledKey: new Map([[rows[0].id, null]]) }).reason, 'filled_unattributed');
    reset(); rows = [row('블루'), row('라지'), row('라지')];
    assert.equal(S.planOptionSlots({ opts: [opt('블루', 1), opt('라지', 1)], rows, filledKey: new Map() }).reason, 'total_mismatch');
    reset(); rows = [row('블루'), row('블루')];
    assert.equal(S.planOptionSlots({ opts: [opt('블루', 1), opt('블루 ', 1)].map((o, i) => (i ? { ...o, opt_key: '블루', unit_kind: 'option' } : o)), rows, filledKey: new Map() }).reason, 'label_ambiguous', '같은 표시가 두 옵션에 걸림');
    reset(); rows = [row(''), row('')];
    assert.equal(S.planOptionSlots({ opts: [opt('블루', 1), opt('라지', 1)], rows: rows.map(r => ({ ...r, row_json: {} })), filledKey: new Map() }).reason, 'no_labels', '표시가 하나도 없는 작업 = 해당 없음(종전)');
  });

  await ok('④-3 사람 기록 달린 빈 줄 = 그 자리 고정(그 옵션 몫으로 셈) · 표시 없는 손댄 빈 줄 = 건너뜀 · 칸 모양(H10)', async () => {
    reset();
    const rows = [row('블루'), row('라지', { prot: true }), row('블루'), row('라지'), row('블루'), row('라지')];
    const p = S.planOptionSlots({ opts: [opt('블루', 4), opt('라지', 2)], rows, filledKey: new Map() });
    assert.equal(p.status, 'applied'); assert.ok(!p.moves.some(m => m.id === rows[1].id), '손댄 줄은 안 옮김');
    assert.deepEqual(counts(rows, p.moves), { 블루: 4, 라지: 2 });
    reset();
    const r2 = [row('블루'), { ...row('', { prot: true }), row_json: {} }, row('라지')];
    assert.equal(S.planOptionSlots({ opts: [opt('블루', 2), opt('라지', 1)], rows: r2, filledKey: new Map() }).reason, 'label_unmatched');
    reset();
    const r3 = [row('블루'), row('블루'), { ...row(''), row_json: { 옵션: '', 상품: '바지' } }, row('라지')];
    assert.equal(S.planOptionSlots({ opts: [opt('블루', 2), opt('라지', 2)], rows: r3, filledKey: new Map() }).reason, 'row_cells_unknown', '표시 없는 줄에 모르는 상품');
    reset();
    const r4 = [row('블루'), row('블루'), { ...row('블루'), row_json: { 옵션: '포토 필수 작업지시', 상품: '티셔츠' } }, row('라지')];
    const p4 = S.planOptionSlots({ opts: [opt('블루', 1), opt('라지', 3)], rows: r4, filledKey: new Map() });
    assert.equal(p4.status, 'applied', '작업지시가 적힌 줄은 그 자리 고정(옮길 수 있는 다른 줄로) ' + JSON.stringify(p4));
    assert.ok(!p4.moves.some(m => m.id === r4[2].id));
    assert.equal(S._humanCells({ 번호: '3', 구매일자: '12 / 1 (화)', 상품: '티셔츠', 옵션: '블루', 리뷰옵션: '포토' }), false, '계획 칸·번호·날짜만 = 사람 칸 없음');
    assert.equal(S._humanCells({ 번호: '3', 옵션: '블루', 비고: '가짜 메모' }), true, '비고 칸 = 사람이 쓴 칸');
    assert.equal(S._humanCells({ 옵션: '블루', 수취인: '가짜' }), true);
  });

  await ok('④-4 변이 자가검사 — 포함 관계 짝을 「정확히 같음」으로 바꾸면 상품 단위가 건너뜀으로 바뀐다(검사가 그 차이를 잡는다)', async () => {
    const so = require('../src/services/sheetlessOrder.service');
    const orig = so.resolveProductLabel;
    so.resolveProductLabel = (p, labels) => ((labels || []).includes(p) ? p : '');
    try {
      reset();
      const fish = Array.from({ length: 4 }, (_, i) => { const l = i % 2 ? '옥돔 1kg' : '고등어 2팩 세트'; return { ...row(l), row_json: { 상품: l } }; });
      const q = S.planOptionSlots({ opts: [opt('고등어', 3, '고등어', 'product'), opt('옥돔', 1, '옥돔', 'product')], rows: fish, filledKey: new Map() });
      assert.equal(q.status, 'skipped', '정확 일치 규칙이면 짝을 못 짓는다(레드 H1)');
    } finally { so.resolveProductLabel = orig; }
  });

  await ok('⑤ 트리거·잠금 순서 정적 — 선택지 인원만 · reconcile 제외 · 탭 잠금이 공고 행보다 먼저 · 장부 force · 응답 칸', async () => {
    const sp = read('src/services/sharedPatch.service.js');
    assert.match(sp, /const countChanged = \(pn\.options \|\| \[\]\)\.filter\(o => \{ const b = before\.get\(keyOf\(o\)\); return !b \|\| _num\(b\.recruitTotal\) !== _num\(o\.recruitTotal\); \}\);/, '인원만(일건수·리뷰 비율 제외 · 레드 H9)');
    assert.match(sp, /const rebalanceWanted = countChanged\.length > 0 && origin !== 'reconcile';/);
    assert.ok(!/quantity_tiers_option_counts'\)/.test(sp), '결정 392 임시 거절 제거');
    const fn = sp.slice(sp.indexOf('async function applySharedPatch('), sp.indexOf('async function linkSharedOrderInTx('));
    const optAt = fn.indexOf("const optIntent = !tierIntent && !inTxClient && p.origin !== 'reconcile' && _optionCountIntent(wo, p.mine);");
    const lockAt = fn.indexOf("await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);");
    const campAt = fn.indexOf("'SELECT * FROM recruit_campaigns WHERE id = $1 AND archived_at IS NULL FOR UPDATE'");
    assert.ok(optAt > 0 && lockAt > optAt && campAt > lockAt, '옵션 인원 변경 저장도 탭 잠금 → 공고 행(레드 H4)');
    assert.match(sp, /rebuildWorktableProjection\(campaign\.after\.worktable, 'bidir-quota', campaign\.after\.worktable\.rebalanced === true\)/, 'H5 장부 force');
    assert.match(sp, /\.\.\.\(campaign\.optionSlots \? \{ option_slots: campaign\.optionSlots \} : \{\}\)/, '응답 결과 칸');
    const src = read('src/services/worktableOptionSlots.service.js');
    assert.match(src, /pg_try_advisory_xact_lock\(hashtext\(\$1\)\)/, '탭 잠금이 없으면 기다리지 않는 시도만(역순 교착 0)');
    assert.match(src, /SAVEPOINT wos_rebalance/); assert.match(src, /res = out\('skipped', 'check_failed'\);/, '예외 = 저장은 계속 · 맞췄다고 꾸미지 않음');
    assert.match(read('src/services/linkedRecruitQuota.service.js'), /protectIds && protectIds\.has\(String\(id\)\) \? 2 : 1/, '사람 기록 빈 줄 = 지우기 맨 뒤 순위(막지 않음)');
  });

  console.log(`optionSlotsRebalance: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
