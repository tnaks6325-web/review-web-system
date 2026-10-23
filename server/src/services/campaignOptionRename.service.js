/**
 * campaignOptionRename — 선택지 이름 바꾸기 단일 출처(결정 197 · 결정 274 7단계-④ ③).
 *
 * 공고 창 저장(`_saveCampaignOptions`)과 양방향 공유 저장(`sharedPatch._projectStructureInTx`)이 같은 규칙을 쓴다.
 *   바뀌는 곳: 공고 선택지(campaign_options.opt_key) · 참여 기록(campaign_applications.option_key) · 품절 신고·알림(결정 229) ·
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
    const { optionWriteColumns, productWriteColumns } = require('./orderLedger.service');
    let n = 0;
    for (const r of rows) {
      const ot = String(r.option_text || '').trim();
      const rj = r.row_json && typeof r.row_json === 'object' ? { ...r.row_json } : {};
      const heads = Object.keys(rj);
      let changed = false;
      let nextOt = r.option_text;
      if (map.has(ot)) {
        nextOt = map.get(ot); changed = true;
        for (const i of optionWriteColumns(heads)) if (String(rj[heads[i]] == null ? '' : rj[heads[i]]).trim() === ot) rj[heads[i]] = nextOt;
      }
      if (pmap.size) {
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

module.exports = { planOptionRenames, applyRenamePlanInTx, applyOptionRenames, relabelEmptySlotsInTx };
