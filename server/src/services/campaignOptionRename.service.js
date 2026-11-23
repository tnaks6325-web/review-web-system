/**
 * campaignOptionRename — 선택지 이름 바꾸기 단일 출처(결정 197 · 결정 275 7단계-④ ③).
 *
 * 공고 창 저장(`_saveCampaignOptions`)과 양방향 공유 저장(`sharedPatch._projectStructureInTx`)이 같은 규칙을 쓴다.
 *   바뀌는 곳: 공고 선택지(campaign_options.opt_key) · 참여 기록(campaign_applications.option_key) · 품절 신고·알림(결정 229) · 구매수량 단계(결정 289) ·
 *             **아직 아무도 채우지 않은 작업표 빈 줄**의 배정 표식(option_text)과 그 이름이 적힌 옵션·상품 칸(사용자 확정 2026-10-21 「2.가」 —
 *             안 바꾸면 빈 줄이 옛 이름에 묶여 새 이름 주문이 "빈자리 없음" 이 된다).
 *   🚫 안 바뀌는 곳(완화 금지 · 결정 197): 주문 기록(order_submissions.selected_opt_key)과 **채운 줄**(산 사람이 있는 줄)은 산 당시 이름 그대로.
 * ★ 애매하면 바꾸지 않는다(계획 `planOptionRenames`) · 맞바꾸기(A↔B)는 임시 이름을 거쳐 두 단계.
 * 호출자가 같은 트랜잭션·캠페인 행 잠금 안에서 부른다.
 */
'use strict';

const { logger } = require('../utils/logger');

/**
 * @param {string[]} currentKeys 지금 원장(campaign_options)의 opt_key
 * @param {Array<{optKey:string, prevOptKey?:string}>} options 저장할 목록(원래 이름 prevOptKey)
 * @returns {Array<{from:string,to:string}>}
 */
function planOptionRenames(currentKeys, options) {
  const cur = new Set(currentKeys);
  const prevCount = new Map(), targetCount = new Map();
  for (const o of options) {
    const p = o && o.prevOptKey;
    if (!p || p === o.optKey) continue;
    prevCount.set(p, (prevCount.get(p) || 0) + 1);
    targetCount.set(o.optKey, (targetCount.get(o.optKey) || 0) + 1);
  }
  // 이름을 안 바꾼(또는 새로 추가한) 줄의 이름 — 옛 이름이 여기 있으면 그 선택지는 그대로 남는다(이름 바꾸기 아님)
  const stay = new Set(options.filter(o => o && (!o.prevOptKey || o.prevOptKey === o.optKey)).map(o => o.optKey));
  let plan = options
    .filter(o => o && o.prevOptKey && o.prevOptKey !== o.optKey)
    .filter(o => cur.has(o.prevOptKey) && !stay.has(o.prevOptKey))
    .filter(o => prevCount.get(o.prevOptKey) === 1 && targetCount.get(o.optKey) === 1)
    .map(o => ({ from: o.prevOptKey, to: o.optKey }));
  // 새 이름이 이미 원장에 있으면 그 이름도 이번에 다른 이름으로 비켜나야만 허용(맞바꾸기). 사슬은 안정될 때까지.
  for (let changed = true; changed;) {
    changed = false;
    const leaving = new Set(plan.map(r => r.from));
    const next = plan.filter(r => !cur.has(r.to) || leaving.has(r.to));
    if (next.length !== plan.length) { plan = next; changed = true; }
  }
  return plan;
}

/** 계획대로 바꾼다(임시 이름 경유 두 단계 · 빈 작업표 줄 포함). @returns 실행한 계획 */
async function applyRenamePlanInTx(client, campaignId, plan) {
  if (!plan.length) return plan;
  /* ★★ Q&A체험단(결정 321 · 사용자 확정 2026-11-03 「접수 뒤 상품 변경 금지」) — 자리표는 접수 때 상품·옵션 이름으로 깔렸다.
     공고 선택지 키와 자리표 키(상품 · 옵션 · 옵션)는 표기가 달라 따라 바꾸면 어긋나기 쉽다 → 이름 바꾸기 자체를 막는다(판정 실패 = 막음). */
  const { rows: cr } = await client.query('SELECT linked_sheet_id, linked_tab_name FROM recruit_campaigns WHERE id = $1', [campaignId]);
  if (cr[0] && cr[0].linked_sheet_id && cr[0].linked_tab_name
      && await require('./qnaSlots.service').isQnaTab(client, cr[0].linked_sheet_id, cr[0].linked_tab_name)) {
    const err = new Error('Q&A 작업은 접수 뒤 상품·옵션 이름을 바꿀 수 없습니다 — 바꿔야 하면 새 리뷰오더로 접수해 주세요.');
    err.code = 'qna_rename_locked';
    throw err;
  }
  // ★ 임시 이름은 한 번만 만들어 두 표·두 단계에서 같은 값을 쓴다(호출마다 만들면 시각이 달라져
  //   선택지와 참여 기록이 서로 다른 임시 이름으로 흩어진다 — 코드리뷰 P1).
  const stamp = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const tmp = plan.map((_, i) => '__rename_tmp_' + i + '_' + stamp);
  const step = async (from, to) => {
    await client.query('UPDATE campaign_options SET opt_key=$3, updated_at=NOW() WHERE campaign_id=$1 AND opt_key=$2', [campaignId, from, to]);
    await client.query('UPDATE campaign_applications SET option_key=$3 WHERE campaign_id=$1 AND option_key=$2', [campaignId, from, to]);
    // ★ 결정 229: 품절 신고·알림도 상품 이름을 따라간다(안 바꾸면 이름을 바꾼 뒤 신고가 처음부터 다시 세진다)
    await client.query('UPDATE campaign_option_soldout_reports SET opt_key=$3 WHERE campaign_id=$1 AND opt_key=$2', [campaignId, from, to]);
    await client.query('UPDATE campaign_option_alerts SET opt_key=$3 WHERE campaign_id=$1 AND opt_key=$2', [campaignId, from, to]);
    // ★ 결정 266: 가격 신고·알림(이력 포함)도 상품 이름을 따라간다(안 바꾸면 신고 2명이 이름 앞뒤로 갈려 알림이 안 뜬다)
    await client.query('UPDATE campaign_price_reports SET opt_key=$3 WHERE campaign_id=$1 AND opt_key=$2', [campaignId, from, to]);
    await client.query('UPDATE campaign_price_alerts SET opt_key=$3 WHERE campaign_id=$1 AND opt_key=$2', [campaignId, from, to]);
    // ★ 결정 289: 옵션 전용 구매수량 단계도 이름을 따라간다(안 바꾸면 단계가 어느 옵션 것인지 잃어 그 옵션이 1개 구매로 돌아간다)
    await client.query('UPDATE campaign_qty_tiers SET opt_key=$3, updated_at=NOW() WHERE campaign_id=$1 AND opt_key=$2', [campaignId, from, to]);
  };
  for (let i = 0; i < plan.length; i++) await step(plan[i].from, tmp[i]);
  for (let i = 0; i < plan.length; i++) await step(tmp[i], plan[i].to);
  await relabelEmptySlotsInTx(client, campaignId, plan);
  logger.info('[campaign/options] 선택지 이름 변경 ' + campaignId + ' ' + plan.map(r => r.from + ' → ' + r.to).join(', '));
  return plan;
}

/** 공고 창 저장용 — 화면 목록(prevOptKey)으로 계획을 세워 바꾼다. 바꿀 것이 없으면 조회조차 안 한다. */
async function applyOptionRenames(client, campaignId, options) {
  if (!options.some(o => o && o.prevOptKey && o.prevOptKey !== o.optKey)) return [];
  const { rows } = await client.query('SELECT opt_key FROM campaign_options WHERE campaign_id=$1', [campaignId]);
  return applyRenamePlanInTx(client, campaignId, planOptionRenames(rows.map(r => r.opt_key), options));
}

/**
 * ★ 결정 394 — 빈 줄 row_json 의 계획 칸을 「옛 글자와 **정확히 같은 칸만**」 새 글자로 바꾼다(순수 함수 · 결정 018 blank-only 규율).
 *   이름 바꾸기 빈 줄 표식(relabelEmptySlotsInTx)과 작업보드 옵션 줄 다시 나누기(worktableOptionSlots)가 **이 함수 하나**를 쓴다.
 *   - 옵션 칸(optionWriteColumns — 매퍼가 옵션을 쓰는 칸): 값이 optFrom 중 하나면 optTo
 *   - 상품 칸(productWriteColumns): 값이 productFrom 중 하나면 productTo (productTo 가 null 이면 상품 칸 무접촉)
 *   - 1·2차옵션 칸(v2 · 열 이름 「1차옵션」「2차옵션」): 값이 o1From/o2From 이면 o1To/o2To (To 가 null 이면 무접촉)
 *   ★ 빈 칸은 빈 칸 그대로(빈 글자는 어떤 From 과도 짝짓지 않는다) · 다른 값(작업지시)은 그대로.
 *   ★★ 부품 칸(리뷰 P1 · 2026-11-23) — 호출자가 부품 값(o1/o2 From·To)을 하나라도 주면 그 줄은 v2 「상품 · 옵션」 줄이다:
 *      1·2차옵션 칸은 **통째 표시 바꾸기(optFrom→optTo)에서 빠지고** 부품 값끼리만 바꾼다. 안 빼면 1차옵션 「라지」가 옵션 이름과 같아
 *      통째 표시 「티셔츠 · 블루」로 바뀌고, 뒤의 부품 바꾸기는 더 이상 옛 값을 못 찾는다(그 뒤 주문은 빈 칸만 채워 그대로 남는다).
 *      부품 값을 안 주는 호출(이름 바꾸기 — v1 줄은 주문도 그 칸에 옵션 이름을 통째로 적는다)은 종전 그대로.
 * @returns 새 row_json(입력은 바꾸지 않는다)
 */
const _O1_RE = /^(?:1차|1st)\s*옵션$/;
const _O2_RE = /^(?:2차|2nd)\s*옵션$/;
/** v2 부품 칸(1차옵션·2차옵션) 위치 — 매퍼의 「상품 · 옵션」 쓰기 칸(orderLedger stagedCols)과 같은 열 이름 규칙. */
function stagedComponentColumns(heads) {
  const idxOf = re => (heads || []).map((h, i) => (re.test(String(h).trim().toLowerCase()) ? i : -1)).filter(i => i >= 0);
  return { o1: idxOf(_O1_RE), o2: idxOf(_O2_RE) };
}
function relabelRowCells(rowJson, { optFrom = [], optTo = null, productFrom = [], productTo = null, o1From = [], o1To = null, o2From = [], o2To = null } = {}) {
  const { optionWriteColumns, productWriteColumns } = require('./orderLedger.service');
  const rj = rowJson && typeof rowJson === 'object' ? { ...rowJson } : {};
  const heads = Object.keys(rj);
  const norm = v => String(v == null ? '' : v).trim();
  const setOf = list => new Set((list || []).map(norm).filter(Boolean));
  const swap = (idx, from, to) => {
    if (to == null) return;
    const f = setOf(from);
    if (!f.size) return;
    for (const i of idx) if (f.has(norm(rj[heads[i]]))) rj[heads[i]] = to;
  };
  const comp = stagedComponentColumns(heads);
  const componentMode = setOf(o1From).size > 0 || setOf(o2From).size > 0 || o1To != null || o2To != null;
  const compSet = new Set(componentMode ? [...comp.o1, ...comp.o2] : []);
  swap(optionWriteColumns(heads).filter(i => !compSet.has(i)), optFrom, optTo);
  swap(productWriteColumns(heads), productFrom, productTo);
  swap(comp.o1, o1From, o1To);
  swap(comp.o2, o2From, o2To);
  return rj;
}

/**
 * ★ 결정 400 — v2 「상품 · 옵션」 빈 줄(표시 「티셔츠 · XL」 · 1·2차옵션 칸)의 이름 바꾸기 계획(순수 함수).
 *   종전엔 표시가 옵션 이름과 **정확히 같은** 빈 줄(v1)만 따라가, v2 빈 줄은 옛 이름에 묶여 새 이름 바로 구매가 「빈 줄 없음」이 됐다(결정 291·394 사각).
 *   짝 = 주문 줄 고르기 함수(sheetlessOrder.stagedSlotRows — 상품까지 맞음 → 없으면 표시 상품이 하나뿐일 때만 옵션만) 그대로:
 *     이름 바꾸기 **전** 선택지 목록(지금 원장의 새 이름을 옛 이름으로 되돌린 것)으로 읽어, 이번에 이름을 바꾼 옵션 **하나에만** 걸리는 줄만 바꾼다.
 *   새 표시 = productOptions.selectionKey(줄의 상품 표기 그대로, 새 1차, 새 2차) · 칸 = relabelRowCells(부품 칸은 부품 값끼리만 · 빈 칸은 빈 칸).
 *   새 1·2차 값 = 새 이름을 derivedLabel 의 「 + 」로 나눈 것 — **줄의 단 수(1단/2단)를 그대로** 둘 때 한 가지로만 나뉘어야 한다.
 * ★ fail-closed(그 줄만 그대로 · 이름 바꾸기 자체는 성공): 옵션 둘 이상에 걸림 · 단 수가 바뀌는 이름 · 부품 칸에 다른 값(작업지시) ·
 *   바꾼 표시를 같은 함수로 되읽었을 때 새 이름 하나로만 읽히지 않음.
 * @param rows  빈 줄 [{id, option_text, row_json}] (v1 줄이 섞여도 된다 — 「 · 」 표시 줄만 본다)
 * @param pairs Map(옛 이름 → 새 이름)
 * @param opts  지금(이름 바꾼 뒤) 공고 선택지 [{opt_key, product_name, unit_kind}]
 * @returns {{changes: Map<string, {option_text, row_json}>, skipped: number}}
 */
function planStagedRenames(rows, pairs, opts) {
  const so = require('./sheetlessOrder.service');
  const { parseSelectionKey, selectionKey } = require('./productOptions.service');
  const t = v => String(v == null ? '' : v).trim();
  const map = pairs instanceof Map ? pairs : new Map((pairs || []).map(p => [p.from, p.to]));
  const changes = new Map();
  let skipped = 0;
  const staged = (rows || []).filter(r => r && t(r.option_text).includes(' · ') && !map.has(t(r.option_text)) && parseSelectionKey(r.option_text));
  if (!map.size || !staged.length) return { changes, skipped };
  const keyed = (opts || []).filter(o => o && String(o.unit_kind || 'option') !== 'product' && t(o.opt_key)).map(o => ({ key: t(o.opt_key), product: t(o.product_name) }));
  const back = new Map([...map].map(([f, to]) => [to, f]));
  const oldKeys = keyed.map(k => ({ key: back.has(k.key) ? back.get(k.key) : k.key, product: k.product }));
  const ownersBy = (list, keys) => {
    const own = new Map();
    for (const k of keys) for (const r of so.stagedSlotRows(list, k.key, k.product)) { const id = String(r.id); own.set(id, [...(own.get(id) || []), k.key]); }
    return own;
  };
  const plus = s => s.split(' + ').length - 1;
  const own0 = ownersBy(staged, oldKeys);
  const draft = new Map();
  for (const r of staged) {
    const ow = own0.get(String(r.id)) || [];
    if (!ow.some(k => map.has(k))) continue;          // 이번 이름 바꾸기와 무관한 줄
    if (ow.length !== 1) { skipped++; continue; }      // 옵션 둘 이상에 걸림
    const ot = t(r.option_text);
    const to = map.get(ow[0]);
    const sel = parseSelectionKey(ot);
    const o1 = t(sel.option1Value), o2 = t(sel.option2Value);
    let n1, n2 = '';
    if (!o2) {
      if (plus(to) !== plus(o1)) { skipped++; continue; }
      n1 = to;
    } else {
      if (plus(to) !== plus(o1) + plus(o2) + 1) { skipped++; continue; }
      const parts = to.split(' + '), c = plus(o1) + 1;
      n1 = parts.slice(0, c).join(' + ').trim(); n2 = parts.slice(c).join(' + ').trim();
      if (!n1 || !n2) { skipped++; continue; }
    }
    const rj0 = r.row_json && typeof r.row_json === 'object' ? r.row_json : {};
    const heads = Object.keys(rj0);
    const comp = stagedComponentColumns(heads);
    const cellOk = (idx, v) => idx.every(i => ['', v].includes(t(rj0[heads[i]])));
    if (!cellOk(comp.o1, o1) || !cellOk(comp.o2, o2)) { skipped++; continue; }   // 부품 칸에 다른 값 = 칸을 모름
    const nl = selectionKey(sel.productName, n1, n2);
    const rj = relabelRowCells(rj0, { optFrom: [ot], optTo: nl, o1From: [o1], o1To: n1, o2From: o2 ? [o2] : [], o2To: o2 ? n2 : null });
    draft.set(String(r.id), { option_text: nl, row_json: rj, to });
  }
  if (draft.size) {
    // 되읽기 — 바꾼 표시를 주문 쪽 같은 함수로 다시 읽어 새 이름 하나로만 읽히는 줄만 쓴다
    const after = staged.map(r => (draft.has(String(r.id)) ? { ...r, option_text: draft.get(String(r.id)).option_text } : r));
    const own1 = ownersBy(after, keyed);
    for (const [id, d] of draft) {
      const ow = own1.get(id) || [];
      if (ow.length === 1 && ow[0] === d.to && so.stagedLabelMatches(d.option_text, d.to)) changes.set(id, { option_text: d.option_text, row_json: d.row_json });
      else skipped++;
    }
  }
  return { changes, skipped };
}

/**
 * 아직 아무도 채우지 않은 작업표 빈 줄 — 배정 표식(option_text)과 옛 이름이 적힌 옵션·상품 칸을 새 이름으로(사용자 확정 2026-10-21 「2.가」).
 *   pairs = [{from, to}](선택지 이름) · productPairs = [{from, to}](상품 칸만 · 상품 이름 바꾸기).
 * ★ 무시트 작업표만 · 다른 살아 있는 공고와 같이 쓰는 탭은 건드리지 않는다(작업표 줄 맞추기와 같은 조건) · 채운 줄은 절대 안 바꾼다.
 * ★ 실패해도 저장은 이어 간다(SAVEPOINT · 기록) — 빈 줄은 다른 옵션 바꿔 쓰기 경로로도 쓰인다.
 */
async function relabelEmptySlotsInTx(client, campaignId, pairs, productPairs = []) {
  const map = new Map((pairs || []).filter(p => p && p.from && p.to && p.from !== p.to).map(p => [p.from, p.to]));
  const pmap = new Map((productPairs || []).filter(p => p && p.from && p.to && p.from !== p.to).map(p => [p.from, p.to]));
  if (!map.size && !pmap.size) return 0;
  await client.query('SAVEPOINT rename_slots');
  try {
    const { rows: cr } = await client.query('SELECT linked_sheet_id, linked_tab_name FROM recruit_campaigns WHERE id = $1', [campaignId]);
    const camp = cr[0];
    if (!camp || !camp.linked_sheet_id || !camp.linked_tab_name) { await client.query('RELEASE SAVEPOINT rename_slots'); return 0; }
    const { isSheetless } = require('../utils/sheetlessScope');
    if (!await isSheetless(client, camp.linked_sheet_id, camp.linked_tab_name)) { await client.query('RELEASE SAVEPOINT rename_slots'); return 0; }
    const { rows: shared } = await client.query(
      `SELECT id FROM recruit_campaigns WHERE participation_mode AND status = 'active' AND archived_at IS NULL AND linked_sheet_id = $1 AND linked_tab_name = $2 AND id <> $3 LIMIT 1`,
      [camp.linked_sheet_id, camp.linked_tab_name, campaignId]);
    if (shared.length) { await client.query('RELEASE SAVEPOINT rename_slots'); return 0; }
    const { rows } = await client.query(
      `SELECT id, option_text, row_json FROM campaign_participants
        WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL AND active = TRUE AND order_submission_id IS NULL
          AND NULLIF(btrim(COALESCE(reviewer_name, '')), '') IS NULL AND NULLIF(btrim(COALESCE(recipient_name, '')), '') IS NULL
          AND NULLIF(btrim(COALESCE(phone8, '')), '') IS NULL
        FOR UPDATE`, [camp.linked_sheet_id, camp.linked_tab_name]);
    const { productWriteColumns } = require('./orderLedger.service');
    // ★ 결정 400 — v2 「상품 · 옵션」 빈 줄도 따라간다(같은 줄 범위 · 같은 잠금 · 짝 = 주문 줄 고르기 함수 · 모르면 그 줄만 그대로).
    //   주문 쪽 「상품 · 옵션」 짝짓기를 끄는 스위치(WORKTABLE_STAGED_OPTION_MATCH=0)면 주문도 이 줄을 안 쓰므로 바꾸지 않는다(종전).
    let staged = { changes: new Map(), skipped: 0 };
    if (map.size && process.env.WORKTABLE_STAGED_OPTION_MATCH !== '0' && rows.some(r => String(r.option_text || '').includes(' · '))) {
      const { rows: co } = await client.query(
        `SELECT opt_key, product_name, unit_kind FROM campaign_options WHERE campaign_id = $1 AND COALESCE(status, 'active') <> 'deleted'`, [campaignId]);
      staged = planStagedRenames(rows, map, co);
      if (staged.skipped) logger.info(`[campaign/options] ${campaignId} 이름 바꾼 선택지의 「상품 · 옵션」 빈 줄 ${staged.skipped}줄은 어느 칸인지 정할 수 없어 그대로 둠`);
    }
    let n = 0;
    for (const r of rows) {
      const ot = String(r.option_text || '').trim();
      const rj0 = r.row_json && typeof r.row_json === 'object' ? r.row_json : {};
      let changed = false;
      let nextOt = r.option_text;
      let rj = { ...rj0 };
      if (map.has(ot)) {
        nextOt = map.get(ot); changed = true;
        rj = relabelRowCells(rj, { optFrom: [ot], optTo: nextOt });
      } else if (staged.changes.has(String(r.id))) {
        const ch = staged.changes.get(String(r.id));
        nextOt = ch.option_text; rj = { ...ch.row_json }; changed = true;
      }
      if (pmap.size) {
        const heads = Object.keys(rj);
        for (const i of productWriteColumns(heads)) {
          const v = String(rj[heads[i]] == null ? '' : rj[heads[i]]).trim();
          if (pmap.has(v)) { rj[heads[i]] = pmap.get(v); changed = true; }
        }
        if (!map.has(ot) && pmap.has(ot)) { nextOt = pmap.get(ot); changed = true; }   // 옵션 없는 상품 = 표식이 곧 상품 이름
      }
      if (!changed) continue;
      await client.query(`UPDATE campaign_participants SET option_text = $2, row_json = $3::jsonb, updated_by = 'option-rename', updated_at = NOW() WHERE id = $1`,
        [r.id, nextOt, JSON.stringify(rj)]);
      n += 1;
    }
    await client.query('RELEASE SAVEPOINT rename_slots');
    return n;
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT rename_slots').catch(() => {});
    logger.warn(`[campaign/options] ${campaignId} 이름 바꾼 선택지의 빈 줄 표식 바꾸기 실패(저장은 이어 감): ${e.message}`);
    return 0;
  }
}

module.exports = { planOptionRenames, applyRenamePlanInTx, applyOptionRenames, relabelEmptySlotsInTx, relabelRowCells, stagedComponentColumns, planStagedRenames };
