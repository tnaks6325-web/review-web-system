'use strict';
/**
 * campaignPayAmountSync.service.js — 작업오더 결제금액 → 연결 모집공고 전파 (사용자 확정 2026-09-21)
 *
 * ★★ 배경: 리뷰어가 보는 결제금액은 **모집공고**에 있다(작업오더가 아니다). 그래서 인트라넷에서
 *   원본 금액만 고치면 "통과했다고 뜨는데 리뷰어 화면은 옛 금액" 이 된다. 사용자 확정으로
 *   **공고까지 같이** 바꾼다 — 지금까지 작업오더→공고 자동 전파는 정원(`recruit_count`) 하나뿐이었고
 *   금액이 두 번째다("공고는 발행 당시의 스냅샷" 이라는 기본 설계를 여는 두 번째 자리).
 *
 * ★★★ **1건당 금액은 `product_options_json` 에서만 읽는다** — `work_orders.pay_amount` 는 **합계**다
 *   (인트라넷 `totals.cost`). 합계를 1건당 자리에 넣으면 60건 작업에 9,324만원이 찍힌 사고가 재현된다.
 *   추출 규칙은 `utils/workOrderPayAmounts` 단일 출처(발행 프리필 `_woOptionRows` 와 같은 규칙).
 *
 * ★★ 공고의 금액 저장처는 **둘**이고 성질이 다르다:
 *   ㉮ 옵션 있는 공고 → `campaign_options.pay_amount`(숫자 칸) — 옵션명(`opt_key`)으로 짝지어 갱신.
 *   ㉯ 옵션 없는 공고 → `recruit_campaigns.work_detail` 의 `payAmount` + **`productLines` 글자 안의
 *      `결제금액 N원`**. 리뷰어 화면(`campaign-workdetail.fmtProduct`)은 **글자 안 금액이 한 종류면
 *      그것을 쓰고 `payAmount` 는 무시**하므로 둘 다 맞춰야 실제로 바뀐다.
 *
 * ★★ **fail-closed(완화 금지)** — 짝을 지을 근거가 없으면 **안 고치고 사유를 보고**한다.
 *   틀린 금액이 리뷰어 화면에 뜨는 것은 안 바뀌는 것보다 나쁘다. 특히 글자 치환은
 *   **금액이 정확히 한 종류일 때만** 한다(여러 상품·옵션이면 어느 글자를 바꿀지 정할 근거가 없다).
 *
 * ★ **절대 throw 하지 않는다** — 전파 실패가 원본 수정 저장을 되돌리면 안 된다(082 apply 규율).
 *   쓰기 표면 = `campaign_options.pay_amount` · `recruit_campaigns.work_detail` 둘뿐
 *   (정원·옵션 구성·작업표·주문·시트 무접촉).
 */

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { payAmountsFromWorkOrder } = require('../utils/workOrderPayAmounts');
const { PRODUCT_LINE_PAY_RE } = require('../utils/campaignProductLines');

/** 테스트 주입용 */
let _pool = null;
function __setPoolForTest(p) { _pool = p; }
function getPool() { return _pool || pool; }

/** `결제금액 N원` 을 전부 찾아 서로 다른 금액의 종류를 센다. */
function distinctAmountsInText(text) {
  const s = String(text == null ? '' : text);
  const re = new RegExp(PRODUCT_LINE_PAY_RE.source, 'g');
  const set = new Set();
  let m;
  while ((m = re.exec(s))) {
    const v = Number(String(m[1]).replace(/[^0-9]/g, ''));
    if (Number.isFinite(v) && v > 0) set.add(v);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 상품 안내 글의 `결제금액 N원` 을 새 금액으로 바꾼다.
 * ★ 금액이 **한 종류일 때만** 부른다(호출부가 판정) — 그때는 전부 같은 값이라 전량 치환이 안전하다.
 * ★ 숫자 표기는 발행 폼과 같은 천 단위 구분(`_syncPreviewFromOptRows` 형식 유지).
 */
function replaceAmountInProductLines(text, nextAmount) {
  const s = String(text == null ? '' : text);
  const re = new RegExp(PRODUCT_LINE_PAY_RE.source, 'g');
  return s.replace(re, '결제금액 ' + Number(nextAmount).toLocaleString('en-US') + '원');
}

/**
 * 작업오더 금액을 연결 공고에 반영한다.
 * @returns {Promise<{applied:boolean, reason?:string, campaignId?:string, options?:number, workDetail?:boolean, detail?:object}>}
 *   ★ `applied:false` 는 실패가 아니라 "해당 없음/근거 없음" 도 포함한다 — `reason` 이 그 사유다.
 */
async function syncCampaignPayAmount({ workOrderId, productOptionsJson, by = 'source' } = {}) {
  const db = getPool();
  const parsed = payAmountsFromWorkOrder(productOptionsJson);
  if (!parsed.units.length) return { applied: false, reason: 'no_units' };

  let client;
  try {
    client = await db.connect();
  } catch (e) {
    logger.warn(`[campaign/pay-sync] 커넥션 실패(전파 생략): ${(e && e.message) || e}`);
    return { applied: false, reason: 'db_unavailable' };
  }

  try {
    await client.query('BEGIN');
    const { rows: woRows } = await client.query(
      'SELECT id, linked_campaign_id FROM work_orders WHERE id = $1 FOR UPDATE', [workOrderId]);
    if (!woRows.length) { await client.query('ROLLBACK'); return { applied: false, reason: 'order_not_found' }; }

    // ★ 짝짓기는 정원 전파와 **같은 함수** — "정원은 A 공고, 금액은 B 공고" 를 만들지 않는다.
    const { linkedCampaign } = require('./linkedRecruitQuota.service');
    const camp = await linkedCampaign(client, woRows[0]);
    if (!camp) { await client.query('ROLLBACK'); return { applied: false, reason: 'no_campaign' }; }

    // ── ㉮ 살아있는 공고 옵션이 있으면 옵션명으로 짝지어 숫자 칸만 갱신 ──────────────
    const { rows: liveOpts } = await client.query(
      `SELECT opt_key, pay_amount FROM campaign_options
        WHERE campaign_id = $1 AND COALESCE(status,'active') <> 'closed' FOR UPDATE`, [camp.id]);

    if (liveOpts.length) {
      const wanted = new Map();
      for (const u of parsed.units) {
        if (u.optKey && u.payAmount > 0) wanted.set(u.optKey, u.payAmount);
      }
      let changed = 0, matched = 0;
      const unmatched = [];
      for (const o of liveOpts) {
        const next = wanted.get(o.opt_key);
        if (next == null) { unmatched.push(o.opt_key); continue; }
        matched += 1;
        if (Number(o.pay_amount) === Number(next)) continue;
        await client.query(
          'UPDATE campaign_options SET pay_amount = $3, updated_at = NOW() WHERE campaign_id = $1 AND opt_key = $2',
          [camp.id, o.opt_key, next]);
        changed += 1;
      }
      await client.query('COMMIT');
      if (!matched) {
        return { applied: false, reason: 'option_key_mismatch', campaignId: camp.id, detail: { unmatched } };
      }
      logger.info(`[campaign/pay-sync] ${camp.id} 옵션 금액 갱신 ${changed}/${matched} by ${by}`);
      return { applied: changed > 0, reason: changed ? undefined : 'already_same',
        campaignId: camp.id, options: changed, detail: { matched, unmatched } };
    }

    // ── ㉯ 옵션 없는 공고 — 상품 안내 글 + payAmount ────────────────────────────────
    // ★ 작업오더 금액이 여러 종류면 어느 글자를 바꿀지 정할 근거가 없다(fail-closed).
    if (parsed.single == null) {
      await client.query('ROLLBACK');
      return { applied: false, reason: 'multiple_amounts', campaignId: camp.id, detail: { amounts: parsed.distinct } };
    }

    const { rows: wdRows } = await client.query(
      'SELECT work_detail FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [camp.id]);
    let wd = wdRows[0] && wdRows[0].work_detail;
    if (typeof wd === 'string') { try { wd = JSON.parse(wd); } catch (_) { wd = null; } }
    if (!wd || typeof wd !== 'object' || Array.isArray(wd)) {
      await client.query('ROLLBACK');
      return { applied: false, reason: 'no_work_detail', campaignId: camp.id };
    }

    const lines = String(wd.productLines == null ? '' : wd.productLines);
    const inText = distinctAmountsInText(lines);
    // ★ 글자 안 금액이 **두 종류 이상**이면 건드리지 않는다 — 리뷰어 화면이 그 원문을 그대로 그린다.
    if (inText.length > 1) {
      await client.query('ROLLBACK');
      return { applied: false, reason: 'campaign_multiple_amounts', campaignId: camp.id, detail: { amounts: inText } };
    }

    const nextLines = inText.length === 1 ? replaceAmountInProductLines(lines, parsed.single) : lines;
    const sameLines = nextLines === lines;
    const samePay = Number(wd.payAmount || 0) === Number(parsed.single);
    if (sameLines && samePay) {
      await client.query('ROLLBACK');
      return { applied: false, reason: 'already_same', campaignId: camp.id };
    }

    const nextWd = Object.assign({}, wd, { payAmount: parsed.single, productLines: nextLines });
    await client.query(
      'UPDATE recruit_campaigns SET work_detail = $2::jsonb, updated_at = NOW() WHERE id = $1',
      [camp.id, JSON.stringify(nextWd)]);
    await client.query('COMMIT');
    logger.info(`[campaign/pay-sync] ${camp.id} 상품 금액 ${parsed.single}원 반영(글자 ${inText.length ? '치환' : '유지'}) by ${by}`);
    return { applied: true, campaignId: camp.id, workDetail: true,
      detail: { payAmount: parsed.single, linesReplaced: !sameLines } };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    logger.warn(`[campaign/pay-sync] 전파 실패(원본 수정은 유지): ${(e && e.message) || e}`);
    return { applied: false, reason: 'error', error: (e && e.message) || String(e) };
  } finally {
    client.release();
  }
}

/**
 * 작업오더 썸네일을 연결 공고에 반영한다(163 · 사용자 확정 2026-09-21).
 * ★ 금액 전파와 달리 **짝지을 것이 없다** — 공고당 그림 한 장이라 값만 덮으면 된다.
 * ★ **빈 값이면 아무것도 하지 않는다** — "안 정했다" 를 "지워라" 로 읽으면 리뷰웹에서 올려 둔
 *   썸네일이 구버전 인트라넷 저장 한 번에 사라진다(blank-only 규율).
 * ★ 값 검증은 `order.routes._thumbnailUrl` 이 저장 전에 이미 했다(우리 프록시 절대 URL만) —
 *   여기서 규칙을 또 만들지 않는다. 다만 **빈 값만** 거른다.
 * ★ **절대 throw 하지 않는다** · 쓰기 표면 = `recruit_campaigns.thumbnail_url` 한 칸.
 */
async function syncCampaignThumbnail({ workOrderId, thumbnailUrl, by = 'source' } = {}) {
  const url = String(thumbnailUrl == null ? '' : thumbnailUrl).trim();
  if (!url) return { applied: false, reason: 'empty' };

  let client;
  try {
    client = await getPool().connect();
  } catch (e) {
    logger.warn(`[campaign/thumb-sync] 커넥션 실패(전파 생략): ${(e && e.message) || e}`);
    return { applied: false, reason: 'db_unavailable' };
  }
  try {
    await client.query('BEGIN');
    const { rows: woRows } = await client.query(
      'SELECT id, linked_campaign_id FROM work_orders WHERE id = $1 FOR UPDATE', [workOrderId]);
    if (!woRows.length) { await client.query('ROLLBACK'); return { applied: false, reason: 'order_not_found' }; }
    const { linkedCampaign } = require('./linkedRecruitQuota.service');
    const camp = await linkedCampaign(client, woRows[0]);
    if (!camp) { await client.query('ROLLBACK'); return { applied: false, reason: 'no_campaign' }; }

    const { rowCount } = await client.query(
      `UPDATE recruit_campaigns SET thumbnail_url = $2, updated_at = NOW()
        WHERE id = $1 AND COALESCE(thumbnail_url,'') <> $2`, [camp.id, url]);
    await client.query('COMMIT');
    if (!rowCount) return { applied: false, reason: 'already_same', campaignId: camp.id };
    logger.info(`[campaign/thumb-sync] ${camp.id} 썸네일 갱신 by ${by}`);
    return { applied: true, campaignId: camp.id };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    logger.warn(`[campaign/thumb-sync] 전파 실패(원본 수정은 유지): ${(e && e.message) || e}`);
    return { applied: false, reason: 'error', error: (e && e.message) || String(e) };
  } finally {
    client.release();
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   유입방식·유입가이드 전파 (사용자 확정 2026-09-22)
   ─────────────────────────────────────────────────────────────────────────────
   ★★ **왜 필요한가** — 리뷰어 화면은 공고에 저장된 유입방식을 **작업오더 폴백보다 먼저** 본다
      (`campaign.routes` work-detail: `workDetail.inflowType || _lookupInflowType(...)`).
      게다가 공고를 한 번이라도 저장하면 그 값이 항상 채워진다(발행 폼이 늘 guide|link 를 싣는다).
      그래서 작업오더만 고치면 "인트라넷은 가이드유입인데 리뷰어는 링크유입" 이 된다.

   ★★★ **가이드가 빈 채로 가이드유입이 되면 안 된다(완화 금지)** — 공고 저장 화면에는 이미
      "가이드유입이면 활성 상품·옵션 전부에 가이드가 있어야 한다" 는 규칙이 있는데(`_validateActiveUnitInflowGuides`),
      전파가 그 검사를 건너뛰면 **"가이드 보고 들어가세요" 라면서 가이드가 없는 공고**가 만들어진다.
      → 전파를 **다 쓴 뒤 그 상태로 검사**하고, 걸리면 **통째로 되돌리고 사유를 보고**한다.
      ★ 옵션이 없는 공고는 화면 규칙이 검사하지 않지만 여기서는 **공통 가이드도 비면 거부**한다
        (화면보다 좁은 = 안전한 쪽. 넓히지 말 것).

   ★ 쓰기 표면 = `campaign_options.inflow_guide_html/inflow_guide_images` ·
                 `recruit_campaigns.work_detail` 둘뿐(정원·옵션 구성·작업표·주문·시트 무접촉).
   ★ **절대 throw 하지 않는다** — 전파 실패가 원본 수정 저장을 되돌리면 안 된다.
   ★ 선택 단위(optKey) 짝짓기는 **금액 전파와 같은 함수**(`payAmountsFromWorkOrder`)를 쓴다 —
     따로 세면 "금액은 A 옵션에, 가이드는 B 옵션에" 로 갈린다.
   ══════════════════════════════════════════════════════════════════════════════ */

/** 유입방식으로 인정하는 값 — 그 외(빈 값·오타)는 "안 바뀜" 으로 읽는다. */
function normalizeInflowType(v) {
  const s = String(v == null ? '' : v).trim();
  return (s === 'guide' || s === 'link') ? s : '';
}

async function syncCampaignInflow({ workOrderId, inflowType, commonGuide, productOptionsJson, by = 'source' } = {}) {
  const nextType = normalizeInflowType(inflowType);
  const hasGuideEdit = commonGuide !== undefined;
  const hasUnitEdit = productOptionsJson !== undefined;
  if (!nextType && !hasGuideEdit && !hasUnitEdit) return { applied: false, reason: 'nothing_to_apply' };

  let client;
  try {
    client = await getPool().connect();
  } catch (e) {
    logger.warn(`[campaign/inflow-sync] 커넥션 실패(전파 생략): ${(e && e.message) || e}`);
    return { applied: false, reason: 'db_unavailable' };
  }
  try {
    await client.query('BEGIN');
    const { rows: woRows } = await client.query(
      'SELECT id, linked_campaign_id FROM work_orders WHERE id = $1 FOR UPDATE', [workOrderId]);
    if (!woRows.length) { await client.query('ROLLBACK'); return { applied: false, reason: 'order_not_found' }; }
    const { linkedCampaign } = require('./linkedRecruitQuota.service');
    const camp = await linkedCampaign(client, woRows[0]);
    if (!camp) { await client.query('ROLLBACK'); return { applied: false, reason: 'no_campaign' }; }

    const { rows: wdRows } = await client.query(
      'SELECT work_detail FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [camp.id]);
    let wd = wdRows[0] && wdRows[0].work_detail;
    if (typeof wd === 'string') { try { wd = JSON.parse(wd); } catch (_) { wd = null; } }
    if (!wd || typeof wd !== 'object' || Array.isArray(wd)) wd = {};

    const compose = require('../utils/inflowGuideCompose');
    let optionsChanged = 0;

    // ── 선택지별 유입가이드 ────────────────────────────────────────────────────
    if (hasUnitEdit) {
      const { payAmountsFromWorkOrder } = require('../utils/workOrderPayAmounts');
      const parsed = payAmountsFromWorkOrder(productOptionsJson);
      const wanted = new Map();
      for (const u of parsed.units) {
        /* ★★ 공고의 선택지 키는 **옵션명, 옵션이 없는 상품이면 상품명**이다(137 `unit_kind='product'`).
           금액 전파는 옵션 없는 공고를 다른 경로로 처리해 `optKey` 만 보지만, 가이드는 상품 단위
           선택지에도 붙어야 한다 — 상품명까지 키로 잡지 않으면 복합유형 작업에서 그 선택지의
           가이드가 통째로 안 따라가고, 곧바로 아래 "가이드유입인데 빈 선택지" 검사에 걸린다. */
        const key = u.optKey || u.productName;
        if (!key) continue;
        const src = u.optKey ? u.src : compose.productUnitSrc(u.src);
        wanted.set(key, compose.composeUnitGuide(src));
      }
      if (wanted.size) {
        const { rows: liveOpts } = await client.query(
          `SELECT opt_key, inflow_guide_html, inflow_guide_images
             FROM campaign_options WHERE campaign_id = $1 AND status <> 'closed'`, [camp.id]);
        for (const o of liveOpts) {
          const next = wanted.get(o.opt_key);
          if (!next) continue;
          const curImgs = JSON.stringify(Array.isArray(o.inflow_guide_images) ? o.inflow_guide_images : []);
          const nextImgs = JSON.stringify(next.images);
          if (String(o.inflow_guide_html || '') === next.html && curImgs === nextImgs) continue;
          await client.query(
            `UPDATE campaign_options
                SET inflow_guide_html = $3, inflow_guide_images = $4::jsonb, updated_at = NOW()
              WHERE campaign_id = $1 AND opt_key = $2`,
            [camp.id, o.opt_key, next.html, nextImgs]);
          optionsChanged += 1;
        }
      }
    }

    // ── 공통 유입가이드 · 유입방식 ─────────────────────────────────────────────
    const nextWd = Object.assign({}, wd);
    let wdChanged = false;
    if (hasGuideEdit) {
      const html = compose.composeCommonGuide(
        commonGuide && commonGuide.text, commonGuide && commonGuide.images);
      if (String(wd.inflowGuideHtml || '') !== html) { nextWd.inflowGuideHtml = html; wdChanged = true; }
    }
    if (nextType && String(wd.inflowType || '') !== nextType) { nextWd.inflowType = nextType; wdChanged = true; }
    if (wdChanged) {
      await client.query(
        'UPDATE recruit_campaigns SET work_detail = $2::jsonb, updated_at = NOW() WHERE id = $1',
        [camp.id, JSON.stringify(nextWd)]);
    }

    if (!wdChanged && !optionsChanged) {
      await client.query('ROLLBACK');
      return { applied: false, reason: 'already_same', campaignId: camp.id };
    }

    // ── 가이드유입 검사(전파가 끝난 상태로) ───────────────────────────────────
    const effectiveType = nextType || normalizeInflowType(wd.inflowType);
    if (effectiveType === 'guide') {
      const { rows: liveOpts } = await client.query(
        `SELECT opt_key, product_name, inflow_guide_html, inflow_guide_images
           FROM campaign_options WHERE campaign_id = $1 AND status <> 'closed'`, [camp.id]);
      if (liveOpts.length) {
        const missing = liveOpts
          .filter(o => !String(o.inflow_guide_html || '').trim()
            && !(Array.isArray(o.inflow_guide_images) && o.inflow_guide_images.length))
          .map(o => o.opt_key || o.product_name || '이름 없는 선택지');
        if (missing.length) {
          await client.query('ROLLBACK');
          return { applied: false, reason: 'guide_missing', campaignId: camp.id, detail: { missing } };
        }
      } else if (!String(nextWd.inflowGuideHtml || '').trim()) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'guide_missing', campaignId: camp.id, detail: { missing: ['공통 유입가이드'] } };
      }
    }

    await client.query('COMMIT');
    logger.info(`[campaign/inflow-sync] ${camp.id} 유입 반영(방식 ${nextType || '유지'} · 선택지 ${optionsChanged}) by ${by}`);
    return { applied: true, campaignId: camp.id, inflowType: effectiveType, options: optionsChanged, workDetail: wdChanged };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    logger.warn(`[campaign/inflow-sync] 전파 실패(원본 수정은 유지): ${(e && e.message) || e}`);
    return { applied: false, reason: 'error', error: (e && e.message) || String(e) };
  } finally {
    client.release();
  }
}

/**
 * 구매시간대 → 연결 공고의 참여 가능 시간창(사용자 확정 2026-09-22).
 *
 * ★★ 이미 발행된 공고의 시간창은 **발행 때 한 번 계산해 굳힌 값**이라 작업오더를 고쳐도 따라오지
 *    않았다. 광고주 사정으로 구매시간이 바뀌면 리뷰어가 실제로 그 시간에 참여할 수 있어야 한다.
 * ★★ 문장 → 시각 계산은 `utils/purchaseTimeWindow` 단일 출처(발행 화면 사본과 가드가 대조).
 * ★ **해석하지 못하면 아무것도 바꾸지 않는다** — 해석 못 하는 문장은 지금도 "하루 종일 열림"으로
 *   운영된다. 여기서 추측해 시간창을 만들면 멀쩡히 열려 있던 공고가 갑자기 닫힌다.
 * ★ **참여형 공고만** — 시간창은 참여형 개념이다(레거시 공고엔 쓰이지 않는다).
 * ★ 이미 구매를 진행 중인 리뷰어는 영향 없다(제출은 시간창을 보지 않는다 — 실측 확인).
 * ★ **절대 throw 하지 않는다** · 쓰기 표면 = `recruit_campaigns.window_start/window_end` 두 칸.
 */
async function syncCampaignPurchaseWindow({ workOrderId, purchaseTime, by = 'source' } = {}) {
  const { parsePurchaseTime } = require('../utils/purchaseTimeWindow');
  const win = parsePurchaseTime(purchaseTime);
  if (!win) return { applied: false, reason: 'unparsed' };

  let client;
  try {
    client = await getPool().connect();
  } catch (e) {
    logger.warn(`[campaign/time-sync] 커넥션 실패(전파 생략): ${(e && e.message) || e}`);
    return { applied: false, reason: 'db_unavailable' };
  }
  try {
    await client.query('BEGIN');
    const { rows: woRows } = await client.query(
      'SELECT id, linked_campaign_id FROM work_orders WHERE id = $1 FOR UPDATE', [workOrderId]);
    if (!woRows.length) { await client.query('ROLLBACK'); return { applied: false, reason: 'order_not_found' }; }
    const { linkedCampaign } = require('./linkedRecruitQuota.service');
    const camp = await linkedCampaign(client, woRows[0]);
    if (!camp) { await client.query('ROLLBACK'); return { applied: false, reason: 'no_campaign' }; }

    const { rows } = await client.query(
      'SELECT participation_mode FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [camp.id]);
    if (!rows.length || rows[0].participation_mode !== true) {
      await client.query('ROLLBACK');
      return { applied: false, reason: 'not_participation', campaignId: camp.id };
    }

    const { rowCount } = await client.query(
      `UPDATE recruit_campaigns SET window_start = $2, window_end = $3, updated_at = NOW()
        WHERE id = $1 AND (COALESCE(window_start::text,'') <> $2 OR COALESCE(window_end::text,'') <> $3)`,
      [camp.id, win.start + ':00', win.end === '24:00' ? '24:00:00' : win.end + ':00']);
    await client.query('COMMIT');
    if (!rowCount) return { applied: false, reason: 'already_same', campaignId: camp.id, window: win };
    logger.info(`[campaign/time-sync] ${camp.id} 시간창 ${win.start}~${win.end} by ${by}`);
    return { applied: true, campaignId: camp.id, window: win };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    logger.warn(`[campaign/time-sync] 전파 실패(원본 수정은 유지): ${(e && e.message) || e}`);
    return { applied: false, reason: 'error', error: (e && e.message) || String(e) };
  } finally {
    client.release();
  }
}

module.exports = {
  syncCampaignPayAmount,
  syncCampaignThumbnail,
  syncCampaignInflow,
  syncCampaignPurchaseWindow,
  normalizeInflowType,
  distinctAmountsInText,
  replaceAmountInProductLines,
  __setPoolForTest,
};
