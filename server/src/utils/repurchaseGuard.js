'use strict';

/**
 * 재참여(재구매) 기간 제한 — "같은 작업 전체" 기준, 계정(전화번호) 단위.
 *
 * ★★ 판정 단일 출처 — 리뷰어 셀프 참여(campaign.routes._applyParticipation)와 관리자 외부모집
 *   수동제출(manualOrder.service) 둘 다 이 모듈을 쓴다. 사본을 두면 한쪽만 기간이 어긋난다.
 *
 * ★★ 기준 = order_submissions(모든 참여 경로가 최종적으로 여기 기록된다)의
 *   같은 sheet_id + 작업 기준 키(repurchase_work_key) + phone8. 구매일별 탭이 달라도
 *   같은 작업명으로 묶여 있으면 한 작업으로 판정한다. 기준 키는 주문을 기록할 때 함께 보존하므로
 *   과거 날짜 탭의 tab_configs 행이 정리된 뒤에도 제한이 풀리지 않는다. 현재 탭 설정의 작업명이
 *   정정된 경우에도 그 정정을 반영하도록, 보존 키와 현재 작업명 대조를 함께 쓴다. 작업명이 비어
 *   있거나 탭 설정이 없을 때는 종전처럼 (sheet_id, tab_name)으로 안전하게 폴백한다. 캠페인이 재발행(차수)돼
 *   recruit_campaigns.id가 달라져도, 또는 캠페인 연결 없이 외부모집으로 등록돼도 잡힌다.
 *
 * ★ 취소된 주문(deleted_at 有)은 세지 않는다 — 취소한 구매까지 재참여를 막으면 안 된다.
 * ★ 모르면 막지 않는다(fail-open) — 탭·번호를 판정할 수 없으면 통과시킨다.
 * ★ 공고별 기간은 recruit_campaigns.repurchase_days(0=제한 없음)에 저장한다.
 * ★ env CAMPAIGN_REPARTICIPATE_DAYS는 기존 공고/미지정 호출의 기본값(기본 14)이자
 *   0일 때 전체 기능을 즉시 끄는 운영 킬스위치다.
 */

function repurchaseDays(campaignDays) {
  const n = parseInt(process.env.CAMPAIGN_REPARTICIPATE_DAYS, 10);
  const globalDays = Number.isFinite(n) && n >= 0 ? n : 14;
  if (globalDays <= 0) return 0;
  if (campaignDays === undefined || campaignDays === null || campaignDays === '') return globalDays;
  const selected = Number(campaignDays);
  return Number.isInteger(selected) && selected >= 0 && selected <= 365 ? selected : globalDays;
}

/** 관리자 수동제출처럼 캠페인 행을 아직 읽지 않은 경로에서 공고별 기간을 한 번 조회한다. */
async function resolveCampaignRepurchaseDays(dbOrClient, campaignId) {
  const fallback = repurchaseDays();
  if (fallback <= 0 || !campaignId) return fallback;
  const { rows } = await dbOrClient.query(
    'SELECT repurchase_days FROM recruit_campaigns WHERE id = $1 LIMIT 1', [campaignId]);
  return repurchaseDays(rows[0] && rows[0].repurchase_days);
}

function phone8Of(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-8);
}

/**
 * 그 작업 전체에 이 계정(phone8)이 최근 N일 안에 이미 구매양식을 낸 적이 있는지 확인한다.
 * @param {object} dbOrClient - pool 또는 트랜잭션 client (.query 인터페이스)
 * @param {{sheetId:string, tabName:string, phone?:string, phone8?:string, days?:number}} p
 * @returns {Promise<{blocked:boolean, days:number, lastSubmittedAt:Date|null, availableFrom:Date|null}>}
 */
async function checkRepurchaseWindow(dbOrClient, { sheetId, tabName, phone, phone8, days: campaignDays } = {}) {
  const days = repurchaseDays(campaignDays);
  const p8 = phone8 || phone8Of(phone);
  if (days <= 0 || !sheetId || !tabName || p8.length !== 8) {
    return { blocked: false, days, lastSubmittedAt: null, availableFrom: null };
  }
  const { rows } = await dbOrClient.query(
    `WITH scope AS (
       SELECT (
         SELECT NULLIF(BTRIM(campaign_name), '')
           FROM tab_configs
          WHERE sheet_id = $1 AND tab_name = $2
          LIMIT 1
       ) AS work_name
     )
     SELECT os.submitted_at
       FROM order_submissions os
       LEFT JOIN tab_configs submitted_tab
         ON submitted_tab.sheet_id = os.sheet_id
        AND submitted_tab.tab_name = os.tab_name
       CROSS JOIN scope
      WHERE os.sheet_id = $1
        AND (
          (scope.work_name IS NOT NULL AND (
            os.repurchase_work_key = $1 || E'\\x1f' || scope.work_name
            OR NULLIF(BTRIM(submitted_tab.campaign_name), '') = scope.work_name
          ))
          OR (scope.work_name IS NULL AND os.tab_name = $2)
        )
        AND os.deleted_at IS NULL
        AND RIGHT(regexp_replace(COALESCE(os.phone,''), '[^0-9]', '', 'g'), 8) = $3
        AND os.submitted_at >= NOW() - make_interval(days => $4)
      ORDER BY os.submitted_at DESC
      LIMIT 1`,
    [sheetId, tabName, p8, days]);
  if (!rows.length) return { blocked: false, days, lastSubmittedAt: null, availableFrom: null };
  const lastSubmittedAt = rows[0].submitted_at;
  const availableFrom = new Date(new Date(lastSubmittedAt).getTime() + days * 86400000);
  return { blocked: true, days, lastSubmittedAt, availableFrom };
}

/**
 * 여러 번호를 한 번에 확인(외부모집 일괄 접수용) — 같은 작업 전체를 왕복 1회로 판정한다.
 * @param {object} dbOrClient
 * @param {{sheetId:string, tabName:string, phone8List:string[], days?:number}} p
 * @returns {Promise<Map<string,{blocked:boolean, lastSubmittedAt:Date, availableFrom:Date}>>} phone8 → 결과(막힌 것만 담김)
 */
async function checkRepurchaseWindowBatch(dbOrClient, { sheetId, tabName, phone8List, days: campaignDays } = {}) {
  const days = repurchaseDays(campaignDays);
  const map = new Map();
  const list = Array.from(new Set((phone8List || []).map(String).filter(p => p.length === 8)));
  if (days <= 0 || !sheetId || !tabName || !list.length) return map;
  const { rows } = await dbOrClient.query(
    `WITH scope AS (
       SELECT (
         SELECT NULLIF(BTRIM(campaign_name), '')
           FROM tab_configs
          WHERE sheet_id = $1 AND tab_name = $2
          LIMIT 1
       ) AS work_name
     )
     SELECT RIGHT(regexp_replace(COALESCE(os.phone,''), '[^0-9]', '', 'g'), 8) AS p8,
            MAX(os.submitted_at) AS last_at
       FROM order_submissions os
       LEFT JOIN tab_configs submitted_tab
         ON submitted_tab.sheet_id = os.sheet_id
        AND submitted_tab.tab_name = os.tab_name
       CROSS JOIN scope
      WHERE os.sheet_id = $1
        AND (
          (scope.work_name IS NOT NULL AND (
            os.repurchase_work_key = $1 || E'\\x1f' || scope.work_name
            OR NULLIF(BTRIM(submitted_tab.campaign_name), '') = scope.work_name
          ))
          OR (scope.work_name IS NULL AND os.tab_name = $2)
        )
        AND os.deleted_at IS NULL
        AND os.submitted_at >= NOW() - make_interval(days => $3)
        AND RIGHT(regexp_replace(COALESCE(os.phone,''), '[^0-9]', '', 'g'), 8) = ANY($4::text[])
      GROUP BY 1`,
    [sheetId, tabName, days, list]);
  for (const r of rows) {
    const lastSubmittedAt = r.last_at;
    map.set(r.p8, {
      blocked: true, days, lastSubmittedAt,
      availableFrom: new Date(new Date(lastSubmittedAt).getTime() + days * 86400000),
    });
  }
  return map;
}

/**
 * 리뷰어 화면에 "N일 후 재참여 가능"/"지금 재참여 가능"을 표시하기 위한 배치 조회.
 *   화면(카드 목록)에 걸린 모집공고 여러 개를 한 왕복으로 확인한다 — 공고별로 각각
 *   물으면 카드 수만큼 왕복이 생긴다(N+1 금지).
 * ★ 구매일별 탭이 달라도 같은 작업명으로 묶여 있으면 같은 판정을 준다 —
 *   checkRepurchaseWindow와 같은 기준.
 * ★ "차단 여부"만 보는 checkRepurchaseWindow와 달리, 기간이 지난 과거 참여도 "ready"로 알려준다
 *   (리뷰어에게 "예전에 참여했었다"는 사실 자체가 안내 대상이라 기간 필터를 걸지 않는다).
 * ★ 킬스위치(days<=0)면 빈 맵 — 제한이 꺼진 상태에서 "N일 후" 안내가 뜨는 모순 방지.
 * @param {object} dbOrClient
 * @param {{campaignIds:string[], phone8:string}} p
 * @returns {Promise<Map<string, {status:'locked'|'ready', lastSubmittedAt:Date, availableFrom?:Date}>>}
 */
async function checkRepurchaseStatusForCampaigns(dbOrClient, { campaignIds, phone8 } = {}) {
  const map = new Map();
  const ids = Array.from(new Set((campaignIds || []).map(String).filter(Boolean)));
  const p8 = String(phone8 || '');
  if (repurchaseDays() <= 0 || !ids.length || p8.length !== 8) return map;
  const { rows } = await dbOrClient.query(
    `SELECT rc.id AS campaign_id, rc.repurchase_days, MAX(os.submitted_at) AS last_at
       FROM recruit_campaigns rc
       LEFT JOIN tab_configs base_tab
         ON base_tab.sheet_id = rc.linked_sheet_id
        AND base_tab.tab_name = rc.linked_tab_name
       JOIN order_submissions os
         ON os.sheet_id = rc.linked_sheet_id
        AND os.deleted_at IS NULL
        AND RIGHT(regexp_replace(COALESCE(os.phone,''), '[^0-9]', '', 'g'), 8) = $2
       LEFT JOIN tab_configs submitted_tab
         ON submitted_tab.sheet_id = os.sheet_id
        AND submitted_tab.tab_name = os.tab_name
      WHERE rc.id = ANY($1::text[])
        AND COALESCE(rc.linked_sheet_id, '') <> '' AND COALESCE(rc.linked_tab_name, '') <> ''
        AND (
          (NULLIF(BTRIM(base_tab.campaign_name), '') IS NOT NULL AND (
            os.repurchase_work_key = rc.linked_sheet_id || E'\\x1f' || BTRIM(base_tab.campaign_name)
            OR NULLIF(BTRIM(submitted_tab.campaign_name), '') = NULLIF(BTRIM(base_tab.campaign_name), '')
          ))
          OR (NULLIF(BTRIM(base_tab.campaign_name), '') IS NULL AND os.tab_name = rc.linked_tab_name)
        )
      GROUP BY rc.id, rc.repurchase_days`,
    [ids, p8]);
  const now = Date.now();
  for (const r of rows) {
    const days = repurchaseDays(r.repurchase_days);
    if (days <= 0) continue;
    const lastSubmittedAt = r.last_at;
    const availableFromMs = new Date(lastSubmittedAt).getTime() + days * 86400000;
    if (availableFromMs > now) {
      map.set(String(r.campaign_id), { status: 'locked', days, lastSubmittedAt, availableFrom: new Date(availableFromMs) });
    } else {
      map.set(String(r.campaign_id), { status: 'ready', days, lastSubmittedAt });
    }
  }
  return map;
}

// 여러 명의의 공고별 재참여 상태를 한 번에 계산한다.
async function checkRepurchaseStatusForAccounts(dbOrClient, { campaignIds, phone8List } = {}) {
  const out = new Map();
  const ids = Array.from(new Set((campaignIds || []).map(String).filter(Boolean)));
  const phones = Array.from(new Set((phone8List || []).map(String).filter(p => p.length === 8)));
  if (repurchaseDays() <= 0 || !ids.length || !phones.length) return out;
  const { rows } = await dbOrClient.query(
    `SELECT rc.id AS campaign_id, rc.repurchase_days,
            RIGHT(regexp_replace(COALESCE(os.phone,''), '[^0-9]', '', 'g'), 8) AS phone8,
            MAX(os.submitted_at) AS last_submitted_at
       FROM recruit_campaigns rc
       LEFT JOIN tab_configs base_tab
         ON base_tab.sheet_id = rc.linked_sheet_id
        AND base_tab.tab_name = rc.linked_tab_name
       JOIN order_submissions os ON os.sheet_id = rc.linked_sheet_id
       LEFT JOIN tab_configs submitted_tab
         ON submitted_tab.sheet_id = os.sheet_id
        AND submitted_tab.tab_name = os.tab_name
      WHERE rc.id = ANY($1::text[]) AND os.deleted_at IS NULL
        AND RIGHT(regexp_replace(COALESCE(os.phone,''), '[^0-9]', '', 'g'), 8) = ANY($2::text[])
        AND (
          (NULLIF(BTRIM(base_tab.campaign_name), '') IS NOT NULL AND (
            os.repurchase_work_key = rc.linked_sheet_id || E'\\x1f' || BTRIM(base_tab.campaign_name)
            OR NULLIF(BTRIM(submitted_tab.campaign_name), '') = NULLIF(BTRIM(base_tab.campaign_name), '')
          ))
          OR (NULLIF(BTRIM(base_tab.campaign_name), '') IS NULL AND os.tab_name = rc.linked_tab_name)
        )
      GROUP BY rc.id, rc.repurchase_days,
               RIGHT(regexp_replace(COALESCE(os.phone,''), '[^0-9]', '', 'g'), 8)`, [ids, phones]);
  const now = Date.now();
  for (const r of rows) {
    const days = repurchaseDays(r.repurchase_days);
    if (days <= 0) continue;
    const at = new Date(r.last_submitted_at || r.last_at);
    const availableFrom = new Date(at.getTime() + days * 86400000);
    const status = availableFrom.getTime() > now ? 'locked' : 'ready';
    const p8 = r.phone8 || r.p8;
    if (!out.has(p8)) out.set(p8, new Map());
    out.get(p8).set(String(r.campaign_id), { status, days, lastSubmittedAt: at, availableFrom });
  }
  return out;
}

module.exports = {
  checkRepurchaseWindow, checkRepurchaseWindowBatch, checkRepurchaseStatusForCampaigns, checkRepurchaseStatusForAccounts,
  phone8Of, repurchaseDays, resolveCampaignRepurchaseDays,
};
