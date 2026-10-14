'use strict';

/**
 * 결정 252 — 구매양식(공고 참여 없이 바로 내는 구매)의 "정원이 찬 상품" 판정 단일 출처.
 *
 *   ① 양식을 열 때 안내 재료(`GET /api/campaign/order-form-gate` 의 optionFull)
 *   ② 제출 때 접수 거절(`POST /api/submit/order` — 사용자 확정 2026-10-15 "모집이 끝났다면 수용하지 않게 · 이미 샀다면 그대로 제출하지 못하도록")
 *   두 곳이 같은 함수를 쓴다 — 화면이 "끝났어요"라 했는데 서버가 받거나, 그 반대가 되지 않게.
 *
 * ★ 정원 찬 판정 = 참여 버튼과 같은 셈(`fetchOptionCounts` + `computeOptionViews` 의 soldout — 공고 참여 + 바로 구매).
 * ★ 양식 표기 → 상품 = `matchOrderOption`(바로 구매를 세는 것과 같은 짝짓기 · 상품 1개 공고는 표기와 무관).
 * ★ 모르면 막지 않는다(fail-open): 공고 없음·보관 공고·정원 있는 상품 없음·상품을 정할 수 없음(여러 상품인데 고르지 않음)·조회 실패.
 *   그렇게 들어온 넘친 구매는 작업보드 ⚠ "정원 넘친 상품 구매"(directPurchaseRules option_full)가 잡는다.
 */

const { logger } = require('../utils/logger');

/** 접수 거절 스위치 — '0' 이면 안내만(막지 않음 · 결정 252 1차 동작). 화면도 응답의 blocking 값을 따른다. */
function blockingEnabled() { return process.env.ORDER_FORM_OPTION_FULL_BLOCK !== '0'; }

/** 그 작업표에 연결된 가장 최근 참여형 공고(이름 또는 gid — 탭 이름이 바뀐 옛 링크도 · 결정 243 과 같은 찾기). */
async function findFormCampaign(db, { sheetId, tabName, gid }) {
  const { rows } = await db.query(
    `SELECT id, title, is_popular, archived_at FROM recruit_campaigns
      WHERE participation_mode IS TRUE AND linked_sheet_id = $1
        AND ((linked_tab_name = $2 AND $2 <> '') OR (NULLIF(linked_tab_gid, '') IS NOT NULL AND linked_tab_gid = NULLIF($3, '')))
      ORDER BY (linked_tab_name = $2) DESC, created_at DESC NULLS LAST, id DESC LIMIT 1`,
    [String(sheetId || ''), String(tabName || ''), String(gid || '')]);
  return rows[0] || null;
}

/**
 * 정원이 찬 상품 재료. null = 모름/해당 없음(안내·거절 없음).
 * @returns {Promise<null|{campaignId, title, fullProducts:string[], singleFull:boolean, singleName?:string,
 *   blocking:boolean, _optRows:Array, _fullKeys:Set, _singleKey:string|null}>}
 */
async function loadFormOptionFull(db, camp, { sheetId, tabName }) {
  try {
    if (!camp || camp.archived_at || process.env.ORDER_FORM_OPTION_FULL_NOTICE === '0') return null;
    const { rows: optRows } = await db.query(
      `SELECT opt_key, option_url, pay_amount, recruit_total, daily_limit, status, product_name, unit_kind, thumbnail_url, paused_at
         FROM campaign_options WHERE campaign_id = $1 ORDER BY (status='closed'), sort_order, id`, [camp.id]);
    if (!optRows.some(o => Number(o.recruit_total) > 0)) return null;   // 정원 있는 상품이 없으면 찰 일이 없다(조회 생략)
    const st = require('./campaignState.service');
    const now = new Date();
    const counts = await st.fetchOptionCounts(db, camp.id, now);
    const sequential = st.sequentialFor(await st.fetchSequentialCampaignIds(db, [camp.id]), camp.id);
    const views = st.computeOptionViews(optRows, counts, null, { sequential });
    const fullKeys = new Set(views.filter(v => v && v.status === 'soldout').map(v => v.optKey));
    let choices = [];
    if (fullKeys.size && tabName) {
      try { choices = await require('./sheetlessOrder.service').listProductChoices(db, sheetId, tabName); }
      catch (_) { choices = []; }
    }
    const keyOf = label => st.matchOrderOption(optRows, { selectedProduct: label });
    const fullProducts = choices.filter(label => fullKeys.has(keyOf(label)));
    // 양식에 상품 고르기가 안 뜨는 경우(상품 표기 1개 이하) — 그 주문이 세어질 상품 하나
    let singleKey = null;
    if (choices.length < 2) singleKey = choices.length === 1 ? keyOf(choices[0]) : (optRows.length === 1 ? optRows[0].opt_key : null);
    const singleFull = !!(singleKey && fullKeys.has(singleKey));
    const single = singleFull ? optRows.find(o => o.opt_key === singleKey) : null;
    return {
      campaignId: camp.id, title: String(camp.title || ''), fullProducts, singleFull,
      ...(single ? { singleName: String(single.product_name || single.opt_key || '') } : {}),
      blocking: blockingEnabled(),
      _optRows: optRows, _fullKeys: fullKeys, _singleKey: singleKey, _choices: choices,
    };
  } catch (e) {
    logger.warn('[order-form-option-full] 상품 정원 확인 실패(안내·거절 없음): ' + e.message);
    return null;
  }
}

/** 화면에 내보낼 모양(내부 재료 제거). */
function publicView(info) {
  if (!info) return null;
  const { _optRows, _fullKeys, _singleKey, _choices, ...pub } = info;
  return pub;
}

/**
 * 제출 때 접수 거절 판정. null = 받는다.
 * @param picked 리뷰어가 양식에서 고른 상품(서버가 선택지로 짝지은 값 — submit.routes formPickedProduct). 없으면 ''.
 * @returns {Promise<null|{campaignId, optKey, name}>}
 */
async function submitBlock(db, { sheetId, tabName, gid, picked }) {
  if (!blockingEnabled()) return null;
  try {
    const camp = await findFormCampaign(db, { sheetId, tabName, gid });
    const info = await loadFormOptionFull(db, camp, { sheetId, tabName });
    if (!info || !info._fullKeys.size) return null;
    let key = null;
    if (picked) key = require('./campaignState.service').matchOrderOption(info._optRows, { selectedProduct: picked });
    else if (info._choices.length < 2) key = info._singleKey;   // 상품 고르기가 없는 양식 — 그 하나
    if (!key || !info._fullKeys.has(key)) return null;           // 상품을 정할 수 없으면 받는다(작업보드 ⚠ 가 잡는다)
    const o = info._optRows.find(r => r.opt_key === key) || {};
    return { campaignId: info.campaignId, optKey: key, name: String(o.product_name || key) };
  } catch (e) {
    logger.warn('[order-form-option-full] 제출 거절 판정 실패(받음): ' + e.message);
    return null;
  }
}

const BLOCK_MESSAGE = '모집이 끝난 상품이라 접수할 수 없어요. 이미 결제했다면 쿠팡에서 주문을 취소해 주세요.';

module.exports = { findFormCampaign, loadFormOptionFull, publicView, submitBlock, blockingEnabled, BLOCK_MESSAGE };
