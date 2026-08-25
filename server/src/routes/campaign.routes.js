const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { appendSheet, readSheet } = require('../services/sheets.service');
const { logger } = require('../utils/logger');
const {
  computeCampaignState, nextOpenAt,
  fetchCampaignCounts,
  fetchOptionCounts,
  computeOptionView,
  liveOptions,
  timeStrToMinutes,
  kstDayStartUtc,
  kstTodayAt,
} = require('../services/campaignState.service');
const { deriveSchedules, tabsOfCampaigns, scheduleFor, describeTabDates } = require('../services/campaignSchedule.service');
const { sanitizeWorkDetail, sanitizeGuideHtml, sanitizeGuideImages, GUIDE_IMAGE_FIELDS } = require('../utils/sanitizeGuideHtml');
const { isActiveEditor } = require('../services/reviewerCampaignEditor.service');
const {
  normalizeFeeSchedules, currentReviewFee, resolveReviewFee, kstDateStr,
} = require('../utils/campaignFee');
// ★ 087: 리뷰타입 판정은 utils/reviewType 단일 출처 — 여기서 정규식을 다시 만들지 말 것
//   (화면마다 규칙을 두면 "공고는 구매확정인데 검수는 리뷰"로 갈라진다)
const { normalizeReviewType } = require('../utils/reviewType');
const { normalizeReviewTypeMix, validateReviewTypeMix, validateOptionReviewTypeMix } = require('../utils/reviewTypeMix');
const { normalizeDeliveryTypeMix, validateDeliveryTypeMix } = require('../utils/deliveryTypeMix');
const { deliveryBaseType } = require('../utils/deliveryType');
const { normalizeRecruitBadges } = require('../utils/recruitBadges');
// ★ 099: 체험단 종류(리뷰/블로그) 저장 정규화 — 판정 단일 출처. 사본을 만들지 않는다.
const { workKindForStore, resolveWorkKind, isBlogKind } = require('../utils/workKind');
const { weekendPublicationState } = require('../services/campaignWeekend.service');
// ★ 101 블로그URL — 형식 판정은 포스팅URL 과 **같은 단일 출처**(둘 다 "사람이 붙여넣는 주소").
//   라벨만 다르다: 블로그URL = 블로그 주소 / 포스팅URL = 쓴 글 주소.
const { isPostUrl, BLOG_URL_HINT } = require('../utils/blogPostUrl');
const { workKindForTab: tabWorkKind } = require('../services/workKindContext.service');
const { syncCampaignRecruitTotal, displayRecruitTotalForCampaign, assertCampaignRecruitTotal } = require('../services/linkedRecruitQuota.service');
const { loadPopularCreditState, canUsePopularCredit } = require('../services/popularCredit.service');

/** work_detail 저장용 정규화(M2 변경②): 발행/수정 시점 sanitize(§03-E 이중 적용의 1차) + JSON 문자열화 */
function _prepWorkDetail(wd) {
  if (wd === undefined) return undefined;              // 미전달 = 변경 없음(COALESCE 유지)
  if (!wd || typeof wd !== 'object') return null;      // 명시적 비움
  const out = { ...wd, inflowGuideHtml: sanitizeGuideHtml(wd.inflowGuideHtml) };
  // ★ 첨부 이미지 배열(리뷰가이드·특이사항)은 우리 프록시 주소만 · 칸당 4장 — 화면만 믿지 않는다.
  //   미전송 필드는 만들지 않는다(옛 스냅샷에 빈 배열을 심지 않기 위해).
  for (const f of GUIDE_IMAGE_FIELDS) {
    if (out[f] !== undefined) out[f] = sanitizeGuideImages(out[f]);
  }
  return JSON.stringify(out);
}

// ID 생성 헬퍼
/**
 * ★ 086: 이체 은행 값 정규화 — 'kbank' | 'hana' 두 값만 통과시킨다.
 *   그 외(오타·구버전 클라이언트·임의 문자열)는 **null**(=자동 판정으로 되돌림).
 *   자유 문자열을 그대로 저장하면 대상 추출에서 어느 은행에도 안 잡혀 그 탭 전체가
 *   조용히 입금에서 빠진다 — 틀린 값보다 빈 값(레포 규율).
 */
function _normTransferBank(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return (s === 'kbank' || s === 'hana') ? s : null;
}

function _genCampaignId() {
  return 'camp_' + crypto.randomBytes(6).toString('hex');
}

/** 공고에 연결된 작업오더의 유입방식(inflow_type)을 라이브 역조회.
 *  우선순위: work_orders.linked_campaign_id = campId(발행 시 기록) → source_work_order_id 보조.
 *  Track A 무접촉(읽기만) · 실패/미연결은 '' 폴백(fail-soft — 홀드/제출 경로에 영향 없음). */
/* ★★ 짝짓기 규칙 사본 금지 — 정원 폴백·혼합 조합과 **같은 작업오더**를 본다
     (`linkedRecruitQuota` 공유 조각). ⚠ 이 통합으로 **소프트삭제된 오더는 근거에서 빠진다**
     (종전에는 `deleted_at` 필터가 없어 지워진 오더의 값도 썼다) — 레포의 반복 규율과 같은 방향이다. */
async function _lookupInflowType(campId, sourceWoId) {
  try {
    const { linkedWorkOrderForCampaign } = require('../services/linkedRecruitQuota.service');
    const wo = await linkedWorkOrderForCampaign(
      { id: campId || '', source_work_order_id: sourceWoId || '' }, ['inflow_type']);
    return (wo && wo.inflow_type) || '';
  } catch (_) {
    return '';   // 컬럼/테이블 이슈 등은 조용히 폴백(라이브 핫패스 보호)
  }
}

/** 저장된 유입방식(둘 중 하나일 때만 값) — 없으면 ''(= 작업오더 폴백 대상). */
function _savedInflowType(workDetail) {
  const v = String((workDetail && workDetail.inflowType) || '');
  return (v === 'guide' || v === 'link') ? v : '';
}

/**
 * 현금영수증 안내(1단계) — 모집공고의 직접 설정이 진실원본이고, 이전 탭 진행방식의
 * '현영' 표기는 호환용 폴백이다. 무시트 작업은 tab_configs가 없으므로 직접 설정 없이는
 * 리뷰어 구매 안내가 사라진다.
 *   리뷰어가 결제 단계에서 지출증빙 발행을 놓치지 않도록 work-detail에 사업자번호 +
 *   채널별(네이버/쿠팡) 발행방법 이미지를 동봉한다. 발행 여부의 진실원본은 탭 설정
 *   (tab_configs.income_type)은 이전 공고만을 위한 호환 폴백이며, 신규 공고 폼은 직접 설정한다.
 *   실패는 null(fail-soft) — 안내 조회 장애가 작업내용 응답을 막지 않는다.
 */
async function _cashReceiptInfo(camp) {
  try {
    if (!camp) return null;
    let incomeType = '';
    if (camp.linked_sheet_id && camp.linked_tab_name) {
      const { rows } = await pool.query(
        'SELECT income_type FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
        [camp.linked_sheet_id, camp.linked_tab_name]
      );
      incomeType = rows[0]?.income_type || '';
    }
    const required = camp.cash_receipt_required === true || incomeType.includes('현영');
    if (!required) return null;
    // 채널 목록·판정은 utils/cashReceiptChannels 단일 출처 — 저장 라우트·설정 화면과 같은 표를 본다.
    const { CASH_RECEIPT_SETTING_KEYS, cashReceiptSettingKey, cashReceiptChannelKey } =
      require('../utils/cashReceiptChannels');
    const { rows: s } = await pool.query(
      `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
      [['company_business_no', ...CASH_RECEIPT_SETTING_KEYS]]
    );
    const map = {};
    for (const r of s) map[r.key] = r.value || '';
    const ch = String(camp.channel === '직접입력' ? (camp.channel_custom || '') : (camp.channel || ''));
    const chKey = cashReceiptChannelKey(ch);
    // 판정 안 되는 채널 = 이미지 없이 문구 안내만(틀린 발행방법을 보여주는 것보다 낫다)
    const guideImageUrl = chKey ? (map[cashReceiptSettingKey(chKey)] || '') : '';
    return { required: true, incomeType: incomeType || '현금영수증 발행', businessNo: map.company_business_no || '', guideImageUrl };
  } catch (_) {
    return null;
  }
}

/**
 * 현금영수증 대상 여부 배치 판정(D안 ① — 참여 전 예고).
 *   공개 목록/상세 카드에 "🧾 현금영수증" 배지를 띄우기 위한 **불리언 하나만** 파생한다
 *   (사업자번호·발행방법 이미지는 종전대로 참여 후 work-detail에서만 — 공개 표면 최소화).
 *   판정 규칙은 utils/captureSlots.isCashReceiptIncome 단일 출처(슬롯 파생과 같은 규칙).
 *   실패는 null(fail-soft) — 호출부는 null이면 필드를 아예 싣지 않는다(false로 꾸미지 않음).
 * @returns {Map<string,boolean>|null}  키 = campaign id
 */
async function _cashReceiptFlags(rows) {
  try {
    const { isCashReceiptIncome } = require('../utils/captureSlots');
    const pairs = [];
    const seen = new Set();
    for (const r of rows || []) {
      if (!r.linked_sheet_id || !r.linked_tab_name) continue;
      const k = r.linked_sheet_id + ' ' + r.linked_tab_name;
      if (!seen.has(k)) { seen.add(k); pairs.push([r.linked_sheet_id, r.linked_tab_name]); }
    }
    const tabMap = new Map();
    if (pairs.length) {
      const { rows: tcs } = await pool.query(
        `SELECT sheet_id, tab_name, income_type FROM tab_configs
          WHERE (sheet_id, tab_name) IN (SELECT unnest($1::text[]), unnest($2::text[]))`,
        [pairs.map(p => p[0]), pairs.map(p => p[1])]
      );
      for (const t of tcs) tabMap.set(t.sheet_id + ' ' + t.tab_name, isCashReceiptIncome(t.income_type));
    }
    const out = new Map();
    for (const r of rows || []) {
      if (r.cash_receipt_required === true) out.set(r.id, true);
    }
    for (const r of rows || []) {
      if (out.has(r.id)) continue;
      out.set(r.id, tabMap.get((r.linked_sheet_id || '') + ' ' + (r.linked_tab_name || '')) === true);
    }
    return out;
  } catch (_) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// 상품옵션(campaign_options) 헬퍼 (061, PRD v1.1)
//   opt_key는 시트 옵션열 기입값(selected_opt_key)과 동일 문자열 → 파이프 '|'(다중옵션 구분자) 제거.
// ═══════════════════════════════════════════════════════════
function _normOptKey(s) {
  return String(s == null ? '' : s).replace(/\|/g, '').trim().slice(0, 200);
}
function _optNum(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; }
function _normalizeOptionUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw.length > 2048) return '';
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
  } catch (_) {
    return '';
  }
}

/** 입력 옵션 배열 → 정규화·중복제거 행 배열. 배열 아님=null(미전달=변경없음). 빈 optKey 제거. */
function _normalizeOptionsInput(arr) {
  if (!Array.isArray(arr)) return null;
  const seen = new Set();
  const out = [];
  for (const o of arr) {
    if (o == null) continue;
    const raw = (typeof o === 'string') ? o : (o.optKey ?? o.opt_key ?? o.name ?? o.label);
    const optKey = _normOptKey(raw);
    if (!optKey || seen.has(optKey)) continue;
    seen.add(optKey);
    const obj = (typeof o === 'object' && o) || {};
    const reviewMixState = normalizeReviewTypeMix(obj.reviewTypeMix ?? obj.review_type_mix);
    out.push({
      optKey,
      optionUrl: _normalizeOptionUrl(obj.optionUrl ?? obj.option_url ?? obj.url),
      // ★ 134 복합 작업: 선택 단위(unit)의 소속 상품명과 종류.
      //   unit_kind='product' = 옵션 없는 상품 자체가 선택지 → 시트 옵션 칸에 쓰지 않는다(submit.routes).
      //   모르는 값은 'option'(종전 동작) — 추측해서 상품 단위로 승격하지 않는다.
      productName: _normOptKey(obj.productName ?? obj.product_name),
      unitKind: (String(obj.unitKind ?? obj.unit_kind ?? '') === 'product') ? 'product' : 'option',
      // ★ 선택지별 유입가이드 — 저장 시 1차 정화(응답 직전 재정화와 이중 적용, §03-E 규율).
      //   빈 값 = "이 선택지 전용 가이드 없음" = 공고 공통 가이드로 접힌다(자동 폴백).
      inflowGuideHtml: sanitizeGuideHtml(obj.inflowGuideHtml ?? obj.inflow_guide_html ?? ''),
      inflowGuideImages: sanitizeGuideImages(obj.inflowGuideImages ?? obj.inflow_guide_images),
      payAmount: _optNum(obj.payAmount ?? obj.pay_amount),
      recruitTotal: _optNum(obj.recruitTotal ?? obj.recruit_total),
      dailyLimit: _optNum(obj.dailyLimit ?? obj.daily_limit),
      reviewTypeMix: reviewMixState.mix || [],
      reviewMixError: reviewMixState.error,
      sortOrder: out.length,
      // ★ 063 심층방어(레드 #6): 'closed'|'active'(명시)|null(미지정=기존 상태 유지) 3상태 —
      //   status를 안 싣는 호출자가 closed 옵션을 조용히 재오픈하지 못하게(자사 UI는 항상 명시 전송이라 동작 불변)
      status: (obj.status === 'closed') ? 'closed' : (obj.status === 'active' ? 'active' : null),
    });
  }
  return out;
}

/** 옵션 저장(replace-set): 제공 옵션 upsert + 목록에서 빠진 기존 옵션은 참여자 있으면 closed, 없으면 삭제.
 *  ★ 참여자 있는 옵션은 절대 삭제하지 않음(기록·정원 보호).
 *  ★★ 원자성·상호배제(레드/블루 #2·#7): 자체 트랜잭션 + recruit_campaigns 행 FOR UPDATE로
 *     apply/change-option과 동일 락 계층 확보 → "사용여부 SELECT→DELETE" 사이 동시 apply가
 *     끼어들어 방금 참여한 옵션을 삭제하는 TOCTOU를 봉합. 실패 시 전체 롤백(부분 저장 없음). */
async function _saveCampaignOptions(campaignId, options) {
  if (!Array.isArray(options)) return; // 미전달=변경 없음
  const keep = new Set(options.map(o => o.optKey));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lock } = await client.query('SELECT id FROM recruit_campaigns WHERE id=$1 FOR UPDATE', [campaignId]);
    if (!lock.length) { await client.query('ROLLBACK'); return; }
    for (const o of options) {
      await client.query(
        `INSERT INTO campaign_options (campaign_id, opt_key, option_url, pay_amount, recruit_total, daily_limit, review_type_mix, sort_order, status,
                                      product_name, unit_kind, inflow_guide_html, inflow_guide_images, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,COALESCE($9,'active'),$10,$11,$12,$13::jsonb,NOW())
         ON CONFLICT (campaign_id, opt_key) DO UPDATE SET
           option_url=EXCLUDED.option_url, pay_amount=EXCLUDED.pay_amount, recruit_total=EXCLUDED.recruit_total,
           daily_limit=EXCLUDED.daily_limit, review_type_mix=EXCLUDED.review_type_mix, sort_order=EXCLUDED.sort_order,
           status=COALESCE($9, campaign_options.status),
           product_name=EXCLUDED.product_name, unit_kind=EXCLUDED.unit_kind,
           inflow_guide_html=EXCLUDED.inflow_guide_html, inflow_guide_images=EXCLUDED.inflow_guide_images,
           updated_at=NOW()`,
        [campaignId, o.optKey, o.optionUrl, o.payAmount, o.recruitTotal, o.dailyLimit, JSON.stringify(o.reviewTypeMix || []), o.sortOrder, o.status,
         o.productName || '', o.unitKind || 'option', o.inflowGuideHtml || '', JSON.stringify(o.inflowGuideImages || [])]);
    }
    const { rows: existing } = await client.query('SELECT opt_key FROM campaign_options WHERE campaign_id=$1', [campaignId]);
    for (const e of existing) {
      if (keep.has(e.opt_key)) continue;
      const { rows: used } = await client.query(
        `SELECT 1 FROM campaign_applications
          WHERE campaign_id=$1 AND option_key=$2 AND status IN ('applied','submitted') LIMIT 1`,
        [campaignId, e.opt_key]);
      if (used.length) {
        await client.query("UPDATE campaign_options SET status='closed', updated_at=NOW() WHERE campaign_id=$1 AND opt_key=$2", [campaignId, e.opt_key]);
      } else {
        await client.query('DELETE FROM campaign_options WHERE campaign_id=$1 AND opt_key=$2', [campaignId, e.opt_key]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * ★★ 공고 옵션 ↔ 작업표 옵션 칸 정합 (2026-08-20 실측 사고) ─────────────────────
 * 작업표 열 구성(`worktablePlan.buildColumns`)은 **작업오더의 옵션만** 본다 —
 * `campaign_options` 는 참조하지 않는다. 그래서 "작업오더엔 옵션이 없고 공고에서 옵션을
 * 나눈" 작업은 **옵션 칸 없이** 만들어졌고, 리뷰어가 고른 옵션이 원장에는 남는데
 * 작업표·화면에는 **경고 한 줄 없이 사라졌다**.
 *
 * → 옵션이 2종 이상인 공고를 저장하면 연결된 무시트 작업표에 옵션 칸을 **보장**한다
 *   (이미 있으면 아무 것도 하지 않는 조회 3번 = 사실상 무비용).
 *
 * ★ 완화 금지: 실행부는 `worktableOptionColumn.service` **한 벌**(복구 창구와 같은 함수) —
 *   여기서 헤더를 직접 만지면 두 경로가 다른 칸을 만든다.
 * ★ **절대 throw 하지 않는다** — 정합 보조가 공고 저장을 죽이면 안 된다(082 apply 규율).
 * ★ 시트 기반 탭·미등록 탭은 서비스가 fail-closed 로 거부한다(열은 시트가 정한다).
 */
async function _ensureLinkedWorktableOptionColumn(campaignId, by = 'campaign') {
  try {
    const { rows } = await pool.query(
      /* ★★ 컬럼명 주의: `recruit_campaigns` 는 `linked_sheet_id` 다 — `linked_tab_sheet_id` 는
         **`work_orders`** 의 컬럼이다(033). 그걸 여기 쓰면 42703 이 나는데 아래 catch 가
         "해당 없음" 으로 삼켜, 이 재발 방지 훅이 **배포 이래 한 번도 안 돌았다**(2026-08-23 실측). */
      `SELECT c.linked_sheet_id AS "sheetId", c.linked_tab_name AS "tabName",
              (SELECT COUNT(*) FROM campaign_options o
                WHERE o.campaign_id = c.id AND COALESCE(o.status,'active') <> 'closed') AS "liveOpts"
         FROM recruit_campaigns c WHERE c.id = $1`, [campaignId]);
    const r = rows[0];
    if (!r || !r.sheetId || !r.tabName) return null;
    if (Number(r.liveOpts || 0) < 2) return null;   // 선택지가 하나면 기입 의미가 없다(배분 규칙과 같은 기준)
    const { ensureOptionColumn } = require('../services/worktableOptionColumn.service');
    const out = await ensureOptionColumn({
      sheetId: r.sheetId, tabName: r.tabName, dryRun: false, backfill: true, by: `campaign:${by}`,
    });
    if (out && (out.headerAdded || out.backfillCount)) {
      logger.info(`[campaign/options] 작업표 옵션 칸 정합 ${r.sheetId}/${r.tabName} 열추가=${out.headerAdded} 소급=${out.backfillCount}`);
    }
    return out;
  } catch (e) {
    // not_sheetless·tab_not_registered·no_headers 는 정상적인 "해당 없음" 이다.
    logger.warn(`[campaign/options] 작업표 옵션 칸 정합 생략(${campaignId}): ${(e && e.message) || e}`);
    return null;
  }
}

/**
 * 공고 저장 시 연결된 **무시트 작업표**에 「상품」 칸을 보장하고 선택을 소급 기입한다(138).
 * ★ 옵션 칸 훅과 같은 자리·같은 규율 — **절대 throw 하지 않는다**(열 보장 실패가 공고 저장을 죽이면 안 된다).
 * ★★ 문턱은 **상품 2종 이상**(살아있는 옵션 기준) — 상품이 하나면 리뷰어가 고를 여지가 없어
 *   적을 값이 없다(옵션 칸 훅의 "옵션 2종 이상"과 같은 기준).
 * ★ 컬럼명 주의: recruit_campaigns 는 linked_sheet_id 다(work_orders 의 linked_tab_sheet_id 아님) —
 *   옵션 칸 훅이 이 오타로 배포 이래 한 번도 안 돌았던 자리다(2026-08-23 실측).
 */
async function _ensureLinkedWorktableProductColumn(campaignId, by = 'campaign') {
  try {
    const { rows } = await pool.query(
      `SELECT c.linked_sheet_id AS "sheetId", c.linked_tab_name AS "tabName",
              (SELECT COUNT(DISTINCT o.product_name) FROM campaign_options o
                WHERE o.campaign_id = c.id AND COALESCE(o.status,'active') <> 'closed'
                  AND COALESCE(o.product_name,'') <> '') AS "liveProducts"
         FROM recruit_campaigns c WHERE c.id = $1`, [campaignId]);
    const r = rows[0];
    if (!r || !r.sheetId || !r.tabName) return null;
    if (Number(r.liveProducts || 0) < 2) return null;
    const { ensureProductColumn } = require('../services/worktableProductColumn.service');
    const out = await ensureProductColumn({
      sheetId: r.sheetId, tabName: r.tabName, dryRun: false, backfill: true, by: `campaign:${by}`,
    });
    if (out && (out.headerAdded || out.backfillCount)) {
      logger.info(`[campaign/products] 작업표 상품 칸 정합 ${r.sheetId}/${r.tabName} 열추가=${out.headerAdded} 소급=${out.backfillCount}`);
    }
    return out;
  } catch (e) {
    // not_sheetless·tab_not_registered·no_live_products 는 정상적인 "해당 없음" 이다.
    logger.warn(`[campaign/products] 작업표 상품 칸 정합 생략(${campaignId}): ${(e && e.message) || e}`);
    return null;
  }
}

/**
 * 회수·혼합 공고 저장 시 연결된 **무시트 작업표**에 부속 열을 보장한다(135).
 * ★ 옵션 칸 훅(_ensureLinkedWorktableOptionColumn)과 같은 자리·같은 규율 —
 *   **절대 throw 하지 않는다**(열 보장 실패가 공고 저장을 죽이면 안 된다).
 * ★ 열 이름·자리·배분은 worktablePlan 단일 출처(서비스가 그것을 그대로 쓴다).
 */
async function _ensureLinkedWorktableDeliveryColumns(campaignId, by = 'campaign') {
  try {
    const { rows } = await pool.query(
      /* ★ 컬럼명 주의: recruit_campaigns 는 linked_sheet_id 다(work_orders 의 linked_tab_sheet_id 아님) —
         옵션 칸 훅이 이 오타로 배포 이래 한 번도 안 돌았던 자리다(2026-08-23 실측). */
      `SELECT linked_sheet_id AS "sheetId", linked_tab_name AS "tabName",
              delivery_type, delivery_type_mix, recall_courier, recall_product
         FROM recruit_campaigns WHERE id = $1`, [campaignId]);
    const r = rows[0];
    if (!r || !r.sheetId || !r.tabName) return null;
    const base = deliveryBaseType(r.delivery_type);
    if (base !== '혼합' && base !== '회수') return null;
    const { ensureDeliveryColumns } = require('../services/worktableDeliveryColumn.service');
    const out = await ensureDeliveryColumns({
      sheetId: r.sheetId, tabName: r.tabName, deliveryBase: base,
      mix: r.delivery_type_mix, recall: { courier: r.recall_courier, product: r.recall_product },
      dryRun: false, backfill: true, by: `campaign:${by}`,
    });
    if (out && ((out.headerAdded && out.headerAdded.length) || out.backfillCount)) {
      logger.info(`[campaign/delivery] 작업표 배송 칸 정합 ${r.sheetId}/${r.tabName} 열추가=${(out.headerAdded || []).join(',')} 소급=${out.backfillCount}`);
    }
    return out;
  } catch (e) {
    // not_applicable·not_sheetless·tab_not_registered·no_headers·no_delivery_mix 는 정상적인 "해당 없음".
    logger.warn(`[campaign/delivery] 작업표 배송 칸 정합 생략(${campaignId}): ${(e && e.message) || e}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// 기간별 리뷰비(082) — 구간표 저장·조회
//   판정 자체는 utils/campaignFee.js 가 **단일 출처**(화면마다 규칙을 따로 만들면
//   "카드는 1,000원인데 합계는 1,500원"으로 갈라진다). 여기는 원장 입출력만 담당.
// ═══════════════════════════════════════════════════════════

/** 구간 저장(replace-set). 배열 아님=미전달=변경 없음(옵션표와 같은 계약).
 *  ★ 옵션 저장과 동일한 잠금 계층(recruit_campaigns 행 FOR UPDATE)을 써서 apply 와 상호배제 —
 *    참여 판정이 "저장 중간 상태"의 구간표를 보는 창을 없앤다. 실패 시 전체 롤백(부분 저장 없음). */
async function _saveFeeSchedules(campaignId, schedules) {
  if (!Array.isArray(schedules)) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lock } = await client.query('SELECT id FROM recruit_campaigns WHERE id=$1 FOR UPDATE', [campaignId]);
    if (!lock.length) { await client.query('ROLLBACK'); return; }
    const keep = schedules.map(s => s.effectiveFrom);
    for (const s of schedules) {
      await client.query(
        `INSERT INTO campaign_fee_schedules (campaign_id, effective_from, review_fee, memo, updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (campaign_id, effective_from) DO UPDATE SET
           review_fee = EXCLUDED.review_fee, memo = EXCLUDED.memo, updated_at = NOW()`,
        [campaignId, s.effectiveFrom, s.reviewFee, s.memo || '']);
    }
    // 목록에서 빠진 구간은 삭제 — 구간은 "설정값"이라 참여 이력을 들고 있지 않다.
    // ★ 이미 참여한 건은 review_fee_snapshot 이 지켜주므로 구간을 지워도 과거 표기는 안 바뀐다.
    if (keep.length) {
      await client.query('DELETE FROM campaign_fee_schedules WHERE campaign_id=$1 AND effective_from <> ALL($2::date[])',
        [campaignId, keep]);
    } else {
      await client.query('DELETE FROM campaign_fee_schedules WHERE campaign_id=$1', [campaignId]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

/** 공고 1건의 구간 목록(프리필·판정 공용). 조회 실패는 [](=기존 review_fee 폴백) — fail-soft. */
async function _loadFeeSchedules(db, campaignId) {
  try {
    const { rows } = await db.query(
      `SELECT to_char(effective_from,'YYYY-MM-DD') AS "effectiveFrom",
              review_fee AS "reviewFee", COALESCE(memo,'') AS memo
         FROM campaign_fee_schedules WHERE campaign_id=$1 ORDER BY effective_from`,
      [campaignId]);
    return rows;
  } catch (_) {
    return [];
  }
}

/** 목록용 배치 조회(캠페인 N개 → 1쿼리). @returns Map campaignId → 구간배열 */
async function _fetchFeeSchedulesFor(db, ids) {
  const out = new Map();
  const list = (ids || []).filter(Boolean);
  if (!list.length) return out;
  try {
    const { rows } = await db.query(
      `SELECT campaign_id AS "campaignId", to_char(effective_from,'YYYY-MM-DD') AS "effectiveFrom",
              review_fee AS "reviewFee"
         FROM campaign_fee_schedules WHERE campaign_id = ANY($1) ORDER BY campaign_id, effective_from`,
      [list]);
    for (const r of rows) {
      if (!out.has(r.campaignId)) out.set(r.campaignId, []);
      out.get(r.campaignId).push({ effectiveFrom: r.effectiveFrom, reviewFee: r.reviewFee });
    }
  } catch (_) { /* fail-soft: 구간 없음 = 기존 review_fee */ }
  return out;
}

/** 카드·목록에 보일 리뷰비를 "오늘 기준 구간값"으로 덮어쓴다(구간 없으면 무동작 = 기존 값 그대로).
 *  ★ 프론트는 종전대로 review_fee 한 필드만 읽는다 — 화면 코드를 건드리지 않고 표시를 맞춘다. */
function _applyCurrentFee(view, schedules, now) {
  if (!view || !Array.isArray(schedules) || !schedules.length) return view;
  if (view.review_fee !== undefined) view.review_fee = currentReviewFee(schedules, view.review_fee, now);
  return view;
}

/** 캠페인 옵션 뷰 목록(정렬: 활성 먼저, 마감 하단). campState 반영해 selectable 계산. 옵션 없으면 []. */
async function _loadOptionViews(db, campaignId, campState, now = new Date()) {
  const { rows } = await db.query(
    `SELECT opt_key, option_url, pay_amount, recruit_total, daily_limit, status,
            product_name, unit_kind, inflow_guide_html, inflow_guide_images
       FROM campaign_options WHERE campaign_id=$1 ORDER BY (status='closed'), sort_order, id`,
    [campaignId]);
  if (!rows.length) return [];
  const counts = await fetchOptionCounts(db, campaignId, now);
  // ★ 134: 선택지별 유입가이드는 리뷰어 화면(work-detail)으로 나가는 HTML이므로 **응답 직전 재정화**
  //   (저장 시 1차 정화와 이중 적용 — §03-E 규율. 옛 행·직접 DB 수정분을 신뢰하지 않는다).
  return rows.map(r => {
    const v = computeOptionView(r, counts.get(r.opt_key), campState);
    v.inflowGuideHtml = sanitizeGuideHtml(v.inflowGuideHtml);
    v.inflowGuideImages = sanitizeGuideImages(v.inflowGuideImages);
    return v;
  });
}

/** 참여 전 공개용 옵션 뷰: 옵션명+잔여만(금액은 참여 후 공개 원칙 — payAmount·상세카운트 제외).
 *  ★ 134: 선택지 묶음 머리에 쓸 상품명·단위 종류는 공개(민감정보 아님 — 참여 전 카드에서
 *    "상품A의 옵션1 / 상품A의 옵션2 / 상품B" 를 구분해 보여줘야 한다).
 *  ★★ 선택지별 유입가이드(inflowGuideHtml/Images)는 **여기에 절대 싣지 않는다** —
 *    가이드는 종전 공통 가이드와 같이 홀드 게이트(work-detail) 뒤에서만 공개한다. */
function _publicOptionView(v) {
  return {
    optKey: v.optKey,
    productName: v.productName || '',
    unitKind: v.unitKind || 'option',
    remaining: v.remaining,           // null=무제한
    todayRemaining: v.todayRemaining, // null=옵션 일일제한 없음
    status: v.status,                 // open|soldout|today_done|closed
    selectable: v.selectable,
  };
}

/** 홀드 게이트 뒤(work-detail·관리자 미리보기)로 나가는 **옵션 목록**에서 선택지별 유입가이드를 덜어낸다(134).
 *  목록은 옵션 변경 시트·잠금표시용이라 가이드를 쓰지 않는다 — 리뷰어가 고르지도 않은 선택지의
 *  안내 HTML·이미지를 통째로 실어 보낼 이유가 없다(데이터 최소화 + 페이로드).
 *  ★★ `selectedOption` 은 목록과 **같은 객체를 가리키므로 반드시 먼저 골라 두고** 목록만 사본으로 바꾼다
 *    (여기서 원본을 지우면 내가 참여한 선택지의 가이드까지 함께 사라진다).
 *  ★ 제거는 rest 문법(가산적) — computeOptionView 에 필드가 늘어도 그대로 흐른다. */
function _optionListForReviewer(options) {
  return (options || []).map(v => {
    const { inflowGuideHtml, inflowGuideImages, ...rest } = v || {};
    return rest;
  });
}

/** 목록용 배치 옵션 조회(캠페인 N개 → 옵션행+카운트 2쿼리). 5초 리스트 캐시로 비용 상각.
 *  @returns Map campaignId → [{ row, cnt }]  (정렬 유지) */
async function _fetchOptionsForCampaigns(db, ids, now = new Date()) {
  const out = new Map();
  const list = (ids || []).filter(Boolean);
  if (!list.length) return out;
  const dayStart = kstDayStartUtc(now).toISOString();
  const { rows: optRows } = await db.query(
    `SELECT campaign_id, opt_key, pay_amount, recruit_total, daily_limit, status, product_name, unit_kind
       FROM campaign_options WHERE campaign_id = ANY($1) ORDER BY campaign_id, (status='closed'), sort_order, id`, [list]);
  if (!optRows.length) return out;
  const { rows: cntRows } = await db.query(
    `SELECT campaign_id, option_key,
            COUNT(*) FILTER (WHERE status='applied'   AND expires_at > NOW())                      AS active_holds,
            COUNT(*) FILTER (WHERE status='applied'   AND expires_at > NOW() AND applied_at >= $2)  AS today_active_holds,
            COUNT(*) FILTER (WHERE status='submitted')                                              AS submitted,
            COUNT(*) FILTER (WHERE status='submitted' AND submitted_at >= $2)                       AS today_submitted
       FROM campaign_applications
      WHERE campaign_id = ANY($1) AND option_key IS NOT NULL
      GROUP BY campaign_id, option_key`, [list, dayStart]);
  const cntMap = new Map(); // `${camp} ${optKey}` → cnt
  for (const r of cntRows) {
    cntMap.set(r.campaign_id + ' ' + r.option_key, {
      activeHolds: Number(r.active_holds) || 0, todayActiveHolds: Number(r.today_active_holds) || 0,
      submitted: Number(r.submitted) || 0, todaySubmitted: Number(r.today_submitted) || 0,
    });
  }
  for (const row of optRows) {
    if (!out.has(row.campaign_id)) out.set(row.campaign_id, []);
    out.get(row.campaign_id).push({ row, cnt: cntMap.get(row.campaign_id + ' ' + row.opt_key) });
  }
  return out;
}

/** 관리 편집용 원본 옵션 목록(카운트 없이 설정값 그대로 — 프리필용). */
async function _loadOptionsRaw(db, campaignId) {
  const { rows } = await db.query(
    `SELECT opt_key AS "optKey", option_url AS "optionUrl", pay_amount AS "payAmount", recruit_total AS "recruitTotal", review_type_mix AS "reviewTypeMix",
            daily_limit AS "dailyLimit", sort_order AS "sortOrder", status,
            product_name AS "productName", unit_kind AS "unitKind",
            inflow_guide_html AS "inflowGuideHtml", inflow_guide_images AS "inflowGuideImages"
       FROM campaign_options WHERE campaign_id=$1 ORDER BY (status='closed'), sort_order, id`,
    [campaignId]);
  // ★ 응답 직전 재정화(§03-E 이중 적용) — 저장 시 정화본이라도 옛 행·직접 DB 수정분을 신뢰하지 않는다.
  return rows.map(r => ({
    ...r,
    inflowGuideHtml: sanitizeGuideHtml(r.inflowGuideHtml),
    inflowGuideImages: sanitizeGuideImages(r.inflowGuideImages),
  }));
}

// ═══════════════════════════════════════════════════════════
// 공개 응답 화이트리스트 (M1 선행 보안 — PRD §08)
//   레거시(participation_mode=false): 현행 /list 반환 필드 그대로 유지(카톡 신청 플로우 호환).
//   참여형(participation_mode=true): chat_url·notes·description·max/current_slots·linked_* 미반환
//     — 작업내용·카톡URL은 신청(홀드) 후 work-detail 게이트에서만, 총원 계열은 어디에도 노출 금지.
// ═══════════════════════════════════════════════════════════
const PUBLIC_FIELDS_LEGACY = [
  'id', 'title', 'channel', 'channel_custom', 'manager', 'time_range',
  'delivery_type', 'review_fee', 'badges', 'notes', 'chat_url',
  'status', 'sort_order', 'max_slots', 'current_slots', 'deadline',
  'description', 'linked_sheet_id', 'linked_tab_name', 'created_at',
  'is_popular', // ★ 064: [인기!] 배지(표시용 — 선행참여 게이트는 참여형 apply에서만 판정)
  'work_kind',  // ★ 127: 리뷰어 홈 공고 탭(리뷰/블로그) 필터 재료 — 레거시 공고도 같은 축으로 갈린다
];
const PUBLIC_FIELDS_PARTICIPATION = [
  'id', 'title', 'channel', 'channel_custom', 'manager', 'time_range',
  'delivery_type', 'review_fee', 'badges', 'status', 'sort_order',
  'thumbnail_url', 'created_at',
  'hold_ttl_min', 'close_buffer_min', // 민감정보 아님 — 프론트 안내문("N분 안에 제출")의 정확성용
  'multi_account_mode', 'sub_hold_ttl_min', // ★ 063: 카드 "타계정 가능" 배지(§09-4)+타계정 10분 안내. multi_daily_limit는 비공개(409 사유로만 전달)
  'is_popular', // ★ 064: [인기!] 배지 + 선행참여 안내
  'work_kind',  // ★ 101: 블로그 공고면 참여 시 블로그 주소를 받아야 한다(작업 종류 — 민감정보 아님)
];

function _pick(row, fields) {
  const out = {};
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

/**
 * 주말 미게시(104)로 막힌 카드의 **재개 시점** — { date, iso } (차단 중이 아니거나 계산 불가면 null).
 * ★★ 날짜는 정책값(다음 월요일)이 아니라 `nextOpenAt`(= 카드의 "다시 오픈"·apply 게이트와 **같은
 *   판정**)이 정한다 — 월요일이 0명 조절이면 그날은 열리지 않으므로 "월요일 재개"가 거짓이 된다.
 * ★ 계산 실패는 정책값으로 접는다(호출부에서 `|| weekend.resumesOn`) — 빈 값으로 두지 않는다.
 */
function _weekendResume(row, weekend, counts, now, schedule) {
  if (!weekend || !weekend.blocked) return null;
  try { return nextOpenAt(row, counts, now, schedule); }
  catch (e) { logger.warn('[campaign] 주말 재개일 계산 실패(무시): ' + e.message); return null; }
}

/** 공개 뷰: 레거시/참여형 분기 + 참여형은 상태엔진 페이로드 병합 */
function _publicView(row, counts, now, schedule) {
  if (!row.participation_mode) {
    const weekend = weekendPublicationState(row, now);
    const resume = _weekendResume(row, weekend, counts, now, null);
    return {
      ..._pick(row, PUBLIC_FIELDS_LEGACY),
      participation_mode: false,
      state: weekend.blocked ? 'weekend_unpublished' : row.status,
      stateReason: weekend.blocked ? weekend.reason : null,
      stateMessage: weekend.blocked ? weekend.message : null,
      resumesOn: resume ? resume.date : weekend.resumesOn,
      resumesAt: resume ? resume.iso : null,
    };
  }
  const st = computeCampaignState(row, counts || {
    activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0,
  }, now, schedule);
  const weekend = weekendPublicationState(row, now);
  const resume = _weekendResume(row, weekend, counts, now, schedule);
  return {
    ..._pick(row, PUBLIC_FIELDS_PARTICIPATION),
    participation_mode: true,
    state: weekend.blocked ? 'weekend_unpublished' : st.state,
    todayCount: st.todayCount,
    dailyQuota: st.dailyQuota,
    opensAt: st.opensAt,
    closesAt: st.closesAt,
    cutoffAt: st.cutoffAt,
    allDay: st.allDay === true,       // 자율주문(종일 오픈) 신호
    startDate: st.startDate || null,  // 시작일(062) — 시작일 전엔 state=preopen + opensAt=시작일 오픈시각
    // ★ 시트 일정 파생(063): 마감일·오늘 물량·다음 진행일. 미파생이면 전부 없음(기존 동작).
    endDate: st.endDate || null,
    scheduleSource: st.scheduleSource || null,
    stateReason: weekend.blocked ? weekend.reason : (st.stateReason || null),
    stateMessage: weekend.blocked ? weekend.message : null,
    resumesOn: resume ? resume.date : weekend.resumesOn,
    // 주말 미게시 카드의 "재개까지" 카운트다운 기준(ISO). 차단 중이 아니면 null.
    resumesAt: resume ? resume.iso : null,
    nextWorkDate: st.nextWorkDate || null,
    // daily_done 카드의 "다시 열릴 때까지" 카운트다운 기준(오늘의 opensAt은 이미 지난 시각)
    reopensAt: st.reopensAt || null,
  };
}

/** 요청의 JWT를 검증해 decoded 반환(없거나 무효면 null) */
function _decodeReq(req) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); } catch (_) { return null; }
}

/** 유효한 admin/master JWT 요청인지 (무인증 라우트에서 관리자에게만 전체 필드 반환할 때)
 *  ★★ `req._trustedAdminView` = **서버 코드만** 세우는 신뢰 플래그(Track B 위임이 세운다).
 *     리뷰웹시스템[3버전]의 편집 허용명단에는 `staff`(AE)도 들어갈 수 있는데, 그 사람은 공고를
 *     **수정할 수 있으면서** JWT role 이 admin/master 가 아니라 여기서 공개 화이트리스트 뷰를
 *     받는다 → 수정 모달이 work_detail·연결탭·정원·옵션을 빈 기본값으로 초기화하고,
 *     그대로 저장하면 기존 설정이 **조용히 0·빈값·options:[] 로 지워진다**(Codex 리뷰 P1).
 *     플래그는 요청(헤더·쿼리·본문)으로 만들 수 없다 — Express 는 입력을 req 에 그대로 얹지 않는다.
 *     프로토타입 오염 대비로 **자기 프로퍼티**인지까지 확인한다. */
function _isAdminReq(req) {
  if (req && Object.prototype.hasOwnProperty.call(req, '_trustedAdminView') && req._trustedAdminView === true) return true;
  const d = _decodeReq(req);
  return !!(d && ['admin', 'master'].includes(d.role));
}

/** 리뷰어앱 공고수정 스코프 토큰이 프리필로 볼 수 있는 필드만 추린 뷰(레드팀 #4 — 전체 SELECT * 노출 차단).
 *  chat_url·notes·source_work_order_id·work_detail·linked_* 등 민감/구조필드 제외. */
function _scopedEditorView(row) {
  return {
    id: row.id, title: row.title, status: row.status, participation_mode: row.participation_mode,
    delivery_type: row.delivery_type, review_fee: row.review_fee, time_range: row.time_range,
    window_start: row.window_start, window_end: row.window_end,
    daily_limit: row.daily_limit, recruit_total: row.recruit_total,
    landing_url: row.landing_url, thumbnail_url: row.thumbnail_url,
    sort_order: row.sort_order, max_slots: row.max_slots,
    // ★ 098: 이월 반영 방식(허용명단 리뷰어도 세그먼트 프리필·변경 가능 — 확정 ③)
    carry_mode: row.carry_mode || 'auto',
    // 작업내용은 **읽기 전용 프리필**로만 포함 — 수정 모달에서 "지금 어떤 유입가이드가 걸려 있는지"를
    // 육안 확인하는 용도. 저장 경로(_scopedCampaignEdit)는 여전히 work_detail을 화이트리스트에서
    // 제외하므로 쓰기 표면은 넓어지지 않는다. 내용도 이미 홀드 보유 리뷰어에게 공개되는 값이고
    // 저장 시 sanitize된 본문이라 새로 노출되는 민감정보가 없다(구조/연결 필드는 계속 미노출).
    work_detail: row.work_detail,
  };
}

/** 리뷰어앱 공고수정(via:'reviewer_campaign') 전용 저장 핸들러.
 *  레드팀 #2/#6 방어: **안전 필드 화이트리스트만** UPDATE(linked_*·participation_mode·
 *  source_work_order_id·work_detail·chat_url·notes·deadline 등 절대 미변경 = 교차테넌트
 *  PII 오배정·participation 플립·deadline 소실 원천 차단). 참여형 공고만 대상.
 *  레드팀 #3 방어: 사용 시점 isActiveEditor(phone8) 재검증 → 명단 제외 즉시 차단. */
async function _scopedCampaignEdit(req, res) {
  const { id } = req.params;
  const p8 = req.admin && req.admin.phone8;
  if (!p8 || !(await isActiveEditor(p8))) {
    return res.status(403).json({ ok: false, error: '공고수정 권한이 없습니다. (허용 명단에서 제외되었을 수 있습니다)' });
  }
  const { rows: cur } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
  if (!cur.length) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
  const c = cur[0];
  // 리뷰어 홈에는 참여형 카드만 노출 → 스코프 편집도 참여형 공고만(레거시 캠페인 미접촉)
  if (!c.participation_mode) {
    return res.status(403).json({ ok: false, error: '이 공고는 리뷰어 앱에서 수정할 수 없습니다.' });
  }

  const b = req.body || {};
  const keep = (v, curV) => (v === undefined || v === null || v === '') ? curV : v;
  const numOr = (v, curV) => (v === undefined || v === null || v === '') ? curV : (Number(v) || 0);
  const title = (b.title !== undefined && String(b.title).trim() !== '') ? String(b.title).trim() : c.title;
  const status = ['draft', 'active', 'closed'].includes(b.status) ? b.status : c.status;
  const delivery_type = b.delivery_type !== undefined ? b.delivery_type : c.delivery_type;
  const time_range = b.time_range !== undefined ? b.time_range : c.time_range;
  const thumbnail_url = b.thumbnail_url !== undefined ? b.thumbnail_url : c.thumbnail_url;
  const landing_url = b.landing_url !== undefined ? b.landing_url : c.landing_url;
  // auto_order=true(시간 표기에 자유/자율) → 구매시간 명시적 비움(자율주문). 아니면 빈값=현재값 유지.
  const autoOrder = b.auto_order === true;
  const window_start = autoOrder ? null : keep(b.window_start, c.window_start);
  const window_end = autoOrder ? null : keep(b.window_end, c.window_end);
  const review_fee = numOr(b.review_fee, c.review_fee);
  const daily_limit = numOr(b.daily_limit, c.daily_limit);
  // ★ 095: 차수 원장이 있는 공고의 총모집은 차수 합계가 진실원본 — 스코프 편집(로드값 재전송)이
  //   차수 추가분을 낡은 값으로 되돌리지 않게 항상 현재값 유지(fail-soft: 판정 실패 = 기존 동작).
  let recruit_total = numOr(b.recruit_total, c.recruit_total);
  try {
    const { roundsLockRecruitTotal } = require('../services/campaignPlan.service');
    if (await roundsLockRecruitTotal(id)) recruit_total = c.recruit_total;
  } catch (_) { /* 기존 동작 */ }
  const sort_order = numOr(b.sort_order, c.sort_order);
  const max_slots = numOr(b.max_slots, c.max_slots);
  // ★ 098(확정 ③): 이월 반영 방식은 허용명단 리뷰어도 변경 가능 — 이미 일건수(daily_limit)를
  //   수정할 수 있는 신원이라 같은 급. 알 수 없는 값·미전송 = 유지. 반영(carryApply)은 여전히
  //   adminOrMaster 전용 API 라 스코프 토큰이 보류분을 열 수는 없다.
  const carry_mode = ['auto', 'hold'].includes(b.carry_mode) ? b.carry_mode : (c.carry_mode || 'auto');

  // 참여형 활성화 게이트 재적용(linked_*는 현재값 — 편집 불가라 우회 불가)
  if (status === 'active') {
    const errs = _participationActivationErrors({ ...c, window_start, window_end, daily_limit });
    if (errs.length) return res.status(400).json({ ok: false, error: '참여형 활성화 불가: ' + errs.join(', ') });
  }

  const { rows } = await pool.query(
    `UPDATE recruit_campaigns SET
       title=$2, status=$3, delivery_type=$4, review_fee=$5, time_range=$6,
       thumbnail_url=$7, landing_url=$8, window_start=$9, window_end=$10,
       daily_limit=$11, recruit_total=$12, sort_order=$13, max_slots=$14,
       carry_mode=$15, updated_at=NOW()
     WHERE id=$1 RETURNING *`,
    [id, title, status, delivery_type, review_fee, time_range,
     thumbnail_url, landing_url, window_start || null, window_end || null,
     daily_limit, recruit_total, sort_order, max_slots, carry_mode]
  );
  // ★ 095(Codex P1): 잠금 검사와 UPDATE 사이 "첫 차수 추가" 경합 자가치유(PUT 본 라우트와 동일)
  try {
    const { repairRecruitTotalFromRounds } = require('../services/campaignPlan.service');
    const fixed = await repairRecruitTotalFromRounds(id);
    if (fixed !== null) rows[0].recruit_total = fixed;
  } catch (_) { /* fail-soft */ }
  return res.json({ ok: true, data: rows[0] });
}

// 오픈 러시 방어: 무인증 참여 엔드포인트 rate limit (신청 가부의 SoT는 서버 재검사)
//   키 = phone8(있으면) — 공유 NAT/프록시에서도 개인별 버킷. 없으면 req.ip(app.js trust proxy 1홉 전제).
//   ※ express-rate-limit 7.5.1엔 ipKeyGenerator export가 없다(심판 실측) — req.ip 직접 사용.
function _p8Key(req) {
  const src = (req.body && (req.body.phone8 || req.body.phone)) || (req.query && req.query.phone8) || '';
  const p8 = String(src).replace(/\D/g, '').slice(-8);
  return p8.length === 8 ? 'p8:' + p8 : 'ip:' + (req.ip || 'unknown');
}
const applyLimiter = rateLimit({
  windowMs: 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, keyGenerator: _p8Key,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', reason: 'rate_limited' },
});
const detailLimiter = rateLimit({
  windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, keyGenerator: _p8Key,
  message: { ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', reason: 'rate_limited' },
});

/**
 * 작업오더의 작업시트탭 → 공고 연결 탭 자동 보정.
 *
 * 작업시트탭URL은 AE 제출 **필수**라 오더에는 항상 값이 있는데, 발행 폼에서 탭을 못 고르면
 * (접수 전 발행·드롭다운 미로딩 등) 공고가 "시트 탭 미연결"로 남아 **게시 자체가 막힌다.**
 * 그래서 저장 시점에 서버가 한 번 더 채운다 — 프론트 프리필이 놓쳐도 복구되는 안전망.
 *
 * ★ **비어 있을 때만** 채운다(관리자가 고른 탭을 절대 덮지 않는다).
 * ★ 해석 순서: 접수 때 확정된 `linked_tab_*` → 없으면 `work_sheet_url`의 sheetId·gid로
 *   `tab_configs`에서 탭명을 역조회(미접수 오더 구제). 어느 쪽도 못 찾으면 그대로 둔다.
 *
 * @returns {{sheetId, tabName, tabGid}|null}
 */
async function _linkedTabFromWorkOrder(workOrderId) {
  const id = String(workOrderId || '').trim();
  if (!id) return null;
  try {
    const { rows } = await pool.query(
      `SELECT linked_tab_sheet_id, linked_tab_name, linked_tab_gid, work_sheet_url, skip_weekends
         FROM work_orders WHERE id = $1 LIMIT 1`, [id]
    );
    const o = rows[0];
    if (!o) return null;
    if (o.linked_tab_sheet_id && o.linked_tab_name) {
      return {
        sheetId: o.linked_tab_sheet_id,
        tabName: o.linked_tab_name,
        tabGid: String(o.linked_tab_gid || ''),
        skipWeekends: o.skip_weekends === true,
      };
    }
    // 미접수 오더 폴백 — URL에서 시트ID·gid를 뽑아 등록된 탭에서 이름을 찾는다
    const url = String(o.work_sheet_url || '');
    const sm = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url);
    const gm = /[#?&]gid=(\d+)/.exec(url);
    if (!sm || !gm) return null;
    const { rows: tc } = await pool.query(
      `SELECT tab_name FROM tab_configs WHERE sheet_id = $1 AND tab_gid = $2 LIMIT 1`, [sm[1], gm[1]]
    );
    if (!tc.length) return null;   // 아직 등록 안 된 탭 — 접수하면 해결된다
    return { sheetId: sm[1], tabName: tc[0].tab_name, tabGid: gm[1], skipWeekends: o.skip_weekends === true };
  } catch (e) {
    logger.warn(`[campaign] 작업오더 연결탭 조회 실패(무시): ${e.message}`);
    return null;   // fail-soft — 보정 실패가 공고 저장을 막지 않는다
  }
}

/** 참여형 활성화 게이트(레드 #6·#10): gid·일일건수 필수. 시간창은
 *  "양쪽 설정(start<end)" 또는 "양쪽 미설정(자율주문=종일 오픈)"만 허용 — 한쪽만/역전은 차단. */
function _participationActivationErrors(c) {
  const errs = [];
  // 시트 없이도 모집공고를 저장·발행할 수 있다. 다만 연결 정보를 일부만 입력하면
  // 이후 어느 탭에 동기화해야 할지 모호해지므로, 입력을 시작한 경우에는 세 값 모두를 요구한다.
  const hasAnyLink = !!(c.linked_sheet_id || c.linked_tab_name || c.linked_tab_gid);
  if (hasAnyLink && (!c.linked_sheet_id || !c.linked_tab_name || !c.linked_tab_gid)) {
    errs.push('연결 시트/탭 정보를 모두 입력해주세요');
  }
  const allDay = !c.window_start && !c.window_end; // 자율주문(종일 오픈)
  if (!allDay) {
    const s = timeStrToMinutes(c.window_start);
    const e = timeStrToMinutes(c.window_end);
    if (s === null || e === null || e <= s) errs.push('구매시간창은 시작<종료로 설정하거나, 자율주문이면 양쪽 모두 비워두세요');
  }
  if (!(Number(c.daily_limit) >= 1)) errs.push('일일진행건수(daily_limit ≥ 1) 필수');
  return errs;
}

// GET /api/campaign/list 5초 서버 캐시(rows+counts만 캐시, 상태는 매 요청 신선한 시각으로 재계산)
let _listCache = { at: 0, rows: null, countsMap: null, feeMap: null, filledMap: null };
const LIST_CACHE_MS = 5000;

// ═══════════════════════════════════════════════════════════
// 테이블 자동 생성 (마이그레이션 실패 시 안전장치)
// ═══════════════════════════════════════════════════════════
let _tableChecked = false;
async function _ensureTables() {
  // The verification preview intentionally connects with a database role that
  // can only SELECT. Do not let a GET request attempt schema DDL there.
  if (process.env.READ_ONLY_MODE === 'true') return;
  if (_tableChecked) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recruit_campaigns (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        channel TEXT DEFAULT '',
        channel_custom TEXT DEFAULT '',
        manager TEXT DEFAULT '',
        time_range TEXT DEFAULT '',
        delivery_type TEXT DEFAULT '',
        review_fee INTEGER DEFAULT 0,
        badges JSONB DEFAULT '[]'::jsonb,
        notes TEXT DEFAULT '',
        chat_url TEXT DEFAULT '',
        status TEXT DEFAULT 'draft',
        sort_order INTEGER DEFAULT 0,
        max_slots INTEGER DEFAULT 0,
        current_slots INTEGER DEFAULT 0,
        deadline TIMESTAMPTZ,
        description TEXT DEFAULT '',
        linked_sheet_id TEXT DEFAULT '',
        linked_tab_name TEXT DEFAULT '',
        linked_tab_gid TEXT DEFAULT '',
        cash_receipt_required BOOLEAN NOT NULL DEFAULT FALSE,
        created_by TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_applications (
        id SERIAL PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES recruit_campaigns(id) ON DELETE CASCADE,
        applicant_name TEXT NOT NULL,
        applicant_phone TEXT DEFAULT '',
        applicant_inad TEXT DEFAULT '',
        status TEXT DEFAULT 'confirmed',
        sheet_row_added BOOLEAN DEFAULT FALSE,
        applied_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(campaign_id, applicant_name, applicant_phone)
      )
    `);
    _tableChecked = true;
  } catch (e) {
    // 이미 존재하는 경우 무시
    if (e.message.includes('already exists')) {
      _tableChecked = true;
    } else {
      logger.error('[campaign] 테이블 생성 실패:', e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 공개 API (로그인 불필요)
// ═══════════════════════════════════════════════════════════

// GET /api/campaign/list — 공개 캠페인 목록 (active 우선, closed 하단)
//   ★ M1 보안: 공개 화이트리스트만 반환(SELECT * 금지). 참여형은 상태엔진 페이로드 포함.
//   오픈 러시 방어: rows/counts 5초 캐시 — 상태·serverNow는 매 요청 신선하게 재계산.
router.get('/list', async (req, res, next) => {
  try {
    await _ensureTables();
    const now = new Date();
    let { rows, countsMap, optionsMap, feeMap, crMap, filledMap } = _listCache;
    if (!rows || now.getTime() - _listCache.at > LIST_CACHE_MS) {
      const q = await pool.query(`
        SELECT id, title, channel, channel_custom, manager, time_range,
               delivery_type, review_fee, badges, notes, chat_url,
               status, sort_order, max_slots, current_slots, deadline,
               description, linked_sheet_id, linked_tab_name, linked_tab_gid, created_at,
               participation_mode, thumbnail_url, daily_limit, recruit_total,
               window_start, window_end, close_buffer_min, hold_ttl_min, start_date,
               multi_account_mode, sub_hold_ttl_min, is_popular,
               carry_mode, skip_weekends, cash_receipt_required  -- ★ 098(코드리뷰 B1): dailyQuota 가 읽는다 — 빠지면 목록은 자동 이월
                           --   정원, apply(SELECT *)는 보류 정원을 봐서 "카드는 열렸는데 참여 거부"
        FROM recruit_campaigns
        WHERE status IN ('active', 'closed')
          -- ★ 130: 보관(폐기)한 공고 제외. 모집이 끝난 공고가 리뷰어 목록에 영구히 남던 것을
          --   여기 한 줄이 덮는다(085 reviewer_hidden 과 같은 자리 = 리뷰어 노출의 유일한 출처).
          AND archived_at IS NULL
          -- ★ 085: 리뷰어 미노출(비공개/테스트) 공고 제외. 이 API 가 리뷰어 홈 미리보기·공고 목록·
          --   인기상품 게이트 모달의 유일한 출처라 여기 한 줄이 리뷰어 노출 경로 전체를 덮는다.
          --   관리자 목록·상세·참여(apply)는 무변경 → 링크로 들어가 실제 참여·제출 테스트가 가능하다.
          AND COALESCE(reviewer_hidden, FALSE) = FALSE
        ORDER BY
          CASE WHEN status = 'active' THEN 0 ELSE 1 END,
          created_at DESC
      `);
      rows = q.rows;
      const partIds = rows.filter(r => r.participation_mode).map(r => r.id);
      countsMap = await fetchCampaignCounts(pool, partIds, now);
      optionsMap = await _fetchOptionsForCampaigns(pool, partIds, now);
      // ★ 082: 기간별 리뷰비 — 목록 캐시(5초) 안에서 1쿼리로 상각. 구간 없는 공고는 무영향.
      feeMap = await _fetchFeeSchedulesFor(pool, rows.map(r => r.id));
      // ★ D안 ①: 현금영수증 대상 배지(연결 탭 income_type 파생) — 목록 캐시(5초)로 상각. 실패=null(필드 미동봉).
      crMap = await _cashReceiptFlags(rows);
      // ★ 표 기준 오늘 참여(B안) — 홈 모집공고 카드가 작업보드 툴바와 같은 숫자를 쓰게 하는 재료.
      //   작업보드·관리자 목록과 **같은 함수**(사본 금지). 목록 캐시(5초) 안이라 요청마다 돌지 않는다.
      //   ★ 실패는 null → 카드가 종전(공고 기준)으로 폴백한다(0 으로 위장 금지).
      filledMap = null;
      try {
        const { todayFilledMap, KEY: _fKey } = require('../services/tabFilled.service');
        const _fr = await todayFilledMap(pool, rows
          .filter(r => r.participation_mode && r.linked_sheet_id && r.linked_tab_name)
          .map(r => ({ sheetId: r.linked_sheet_id, tabName: r.linked_tab_name })), now);
        if (_fr.ok) filledMap = { map: _fr.map, key: _fKey };
      } catch (e) {
        logger.warn(`[campaign] list 표 기준 집계 실패 — 종전(공고 기준) 표기로 폴백: ${e.message}`);
      }
      _listCache = { at: now.getTime(), rows, countsMap, optionsMap, feeMap, crMap, filledMap };
    }
    // ★ 시트 일정 파생(063) — 자체 1분 캐시라 목록 캐시 밖에서 호출해도 저비용. 실패=null(폴백).
    const schedMap = await deriveSchedules(pool, tabsOfCampaigns(rows), now);
    const data = rows.map(r => {
      const view = _publicView(r, countsMap.get(r.id), now, scheduleFor(schedMap, r));
      _applyCurrentFee(view, feeMap && feeMap.get(r.id), now);   // ★ 082: 카드 리뷰비 = 오늘 구간
      if (crMap) view.cashReceiptRequired = crMap.get(r.id) === true;   // 조회 실패면 필드 자체가 없음(배지 미표시)
      // 표 기준 오늘 참여(B안) — 카드가 작업보드와 같은 숫자를 쓰기 위한 재료.
      //   ★ null/미동봉 = 셀 수 없음 → 카드가 종전(공고 기준)으로 폴백한다.
      //   ★★ **표시 여부는 화면이 정한다** — 관리자 토큰이 있을 때만 이 값을 쓰고, 일반 리뷰어에겐
      //     종전(공고 기준)을 보여준다. 참여 허용 판정이 공고 기준이라, 리뷰어 화면까지 표 기준으로
      //     바꾸면 "게이지는 찼는데 참여는 되는"(또는 그 반대) 상태가 생긴다.
      if (filledMap && r.linked_sheet_id && r.linked_tab_name) {
        const _k = filledMap.key(r.linked_sheet_id, r.linked_tab_name);
        if (filledMap.map.has(_k)) view.todayFilled = filledMap.map.get(_k);
      }
      // 카드 옵션명+잔여(옵션 등록 참여형만). 상태는 매 요청 신선한 view 기준.
      const opts = optionsMap && optionsMap.get(r.id);
      if (r.participation_mode && opts && opts.length) {
        // ★ 살아있는 옵션이 하나도 없으면(= 관리자가 옵션 구조를 정리한 공고) 옵션 자체를 노출하지 않는다 —
        //   apply 게이트와 같은 `liveOptions` 판정이라 "카드엔 옵션 N종인데 참여는 옵션을 안 받는" 불일치가 없다.
        const optViews = opts.map(o => computeOptionView(o.row, o.cnt, view));
        if (liveOptions(optViews).length) view.options = optViews.map(_publicOptionView);
      }
      return view;
    });
    res.json({ ok: true, data, serverNow: now.toISOString() });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/popular-status?phone8= — 인기상품 참여 가능 여부(무인증 phone8 스코프, 064)
//   apply의 popular_locked 게이트와 **동일 계산**(명의 기준): 크레딧 = 일반(비인기) 참여형 제출완료 수
//   − 인기 소비(제출확정 + 유효홀드). 만료·취소된 인기 건은 자동 환불(미계수).
//   ★ 라우트 등록 순서: GET '/:id' 보다 앞이어야 함 — 뒤에 두면 '/:id'가 'popular-status'를 id로 삼킨다.
router.get('/popular-status', applyLimiter, async (req, res, next) => {
  try {
    const p8 = String(req.query.phone8 || '').replace(/\D/g, '').slice(-8);
    if (p8.length !== 8) return res.status(400).json({ ok: false, error: 'phone8이 필요합니다.' });
    res.json({ ok: true, ...(await loadPopularCreditState(pool, p8)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/my-repurchase-status?phone8=&ids=id1,id2,… — 재참여(재구매) 기간 안내(무인증 phone8 스코프)
//   화면(카드 목록)의 "N일 후 재참여 가능"/"지금 재참여 가능" 썸네일 안내가 이 응답으로 채워진다.
//   판정 단일 출처 = utils/repurchaseGuard(apply 게이트와 같은 기준 — 카드는 열려 있는데 참여는
//   거부되는 불일치를 만들지 않는다). ★ 참여 이력이 아예 없는 공고는 응답 맵에 없다(=평소 카드).
//   ★ 라우트 등록 순서: GET '/:id' 보다 앞이어야 함 — 뒤에 두면 '/:id'가 이 경로를 id로 삼킨다.
router.get('/my-repurchase-status', applyLimiter, async (req, res, next) => {
  try {
    const p8 = String(req.query.phone8 || '').replace(/\D/g, '').slice(-8);
    if (p8.length !== 8) return res.status(400).json({ ok: false, error: 'phone8이 필요합니다.' });
    const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
    if (!ids.length) return res.json({ ok: true, status: {} });
    const { checkRepurchaseStatusForCampaigns } = require('../utils/repurchaseGuard');
    const map = await checkRepurchaseStatusForCampaigns(pool, { campaignIds: ids, phone8: p8 });
    const status = {};
    for (const [cid, v] of map) status[cid] = v;
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/:id — 캠페인 상세
//   ★ M1 보안: SELECT * 무인증 반환 제거. admin/master JWT면 전체(관리자 수정 모달 호환),
//     그 외에는 공개 화이트리스트(레거시/참여형 분기)만.
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    const _d = _decodeReq(req);
    if (_d && _d.via === 'reviewer_campaign') {
      // 리뷰어앱 공고수정 스코프 토큰 = 프리필 필요 필드만(민감/구조필드 미노출, 레드팀 #4)
      return res.json({ ok: true, data: _scopedEditorView(rows[0]) });
    }
    if (_isAdminReq(req)) {
      // 관리자: 전체 행 + 편집용 원본 옵션 목록(프리필) + 리뷰비 구간(082)
      const options = await _loadOptionsRaw(pool, id);
      const feeSchedules = await _loadFeeSchedules(pool, id);
      /* ★★ 혼합 조합 프리필 보완(2026-08-21) — `review_type_mix`(106)는 2026-08-20 에 생긴
         컬럼이고 **백필이 없다**. 그 전에 발행된 혼합 공고는 조합이 통째로 빈 배열이라
         수정 화면이 전부 0 으로 열리고, 혼합 저장 검증(두 유형 이상)에 막혀 손댈 수가 없다.
         → **연결 작업오더에 조합이 실려 있으면 그 값을 프리필 재료로 함께 내려준다.**
         ★ 저장값(`review_type_mix`)은 **덮지 않는다** — 별도 필드로 주고 화면이 "작업오더에서
           불러왔다"고 말한 뒤 사람이 저장할 때 반영된다(조용한 자동 적용 금지).
         ★ 공고에 이미 조합이 있으면 조회하지 않는다(공고가 언제나 이긴다).
         ★ fail-soft — 못 읽어도 수정 모달은 그대로 열린다. */
      let orderReviewTypeMix = null;
      let orderInflowType = null;
      /* ★ 연결 작업오더의 **시작일** — 대조 전용(저장값을 덮지 않는다).
         발행은 스냅샷이라 발행 뒤 오더 시작일이 바뀌어도 공고는 따라가지 않는데,
         그 사실을 확인할 창구가 어디에도 없었다(2026-08-21 신고: 오더 8/19 · 공고 8/12).
         ★ 시작일은 **저장값이 항상 있어** 유입방식·혼합 조합처럼 blank-only 폴백이 성립하지
           않는다 → 값을 바꾸지 않고 화면이 "다르다"고 말하기만 한다. */
      let orderStartDate = null;
      /* ★★ 차수 원장(095)이 있으면 **총모집 전송값을 서버가 무시한다**(`roundsLockRecruitTotal`).
         종전에는 그 사실을 저장한 **뒤**에야(`recruitTotalLocked` → 잠깐 뜨는 안내) 알 수 있어
         "총인원을 200 으로 고쳐 저장했는데 다시 열면 비어 있다"가 원인 불명으로 보였다
         (2026-08-21 신고). → 수정 모달이 **열 때부터** 그 사실을 말하고 칸을 잠그도록 재료를 준다.
         ★ 조회 실패·095 미적용 = **null(모름)** — 화면이 "잠금 없음"으로 꾸미지 않는다. */
      let roundsLock = null;
      try {
        const { rows: _rr } = await pool.query(
          `SELECT COUNT(*)::int AS n, COALESCE(SUM(slot_count), 0)::int AS total
             FROM campaign_rounds WHERE campaign_id = $1`, [id]);
        const _n = Number(_rr[0] && _rr[0].n) || 0;
        roundsLock = { locked: _n > 0, count: _n, total: Number(_rr[0] && _rr[0].total) || 0 };
      } catch (_) { /* 095 미적용·조회 실패 = 모름(null) */ }
      try {
        const cur = normalizeReviewTypeMix(rows[0].review_type_mix);
        const needMix = normalizeReviewType(rows[0].review_type) === 'mixed' && !(cur.mix || []).length;
        /* ★★ 유입방식은 리뷰어 화면(work-detail)이 **이미** 작업오더로 폴백하는데(_lookupInflowType)
           수정 모달만 저장값(work_detail.inflowType)만 봤다 → 값이 없으면 무조건 '링크유입'으로
           열리고, 그대로 저장하면 그 link 가 굳어 **리뷰어 화면의 폴백을 이긴다**
           (가이드유입 공고에 [상품 페이지 열기]가 노출 = 유입가이드 무력화). 모달도 같은 값을 보게 한다. */
        const needInflow = !_savedInflowType(rows[0].work_detail);
        // ★ 조회는 **한 번** — 세 값을 같은 오더에서 가져온다(같은 근거·쿼리 순증 0).
        //   시작일은 늘 필요해 조건 없이 조회한다(모달 열 때 1회 — 목록이 아니다).
        const { linkedWorkOrderForCampaign } = require('../services/linkedRecruitQuota.service');
        const wo = await linkedWorkOrderForCampaign(rows[0], ['review_type_mix', 'inflow_type', 'start_date']);
        if (needMix) {
          const woMix = normalizeReviewTypeMix(wo && wo.review_type_mix);
          if ((woMix.mix || []).length) orderReviewTypeMix = woMix.mix;
        }
        if (needInflow) {
          const v = String((wo && wo.inflow_type) || '');
          if (v === 'guide' || v === 'link') orderInflowType = v;
        }
        /* ★ 화면이 `(c.start_date||'').slice(0,10)` 로 읽는 것과 **같은 변환**을 쓴다 —
           양쪽을 다른 방식으로 자르면 같은 날짜가 다르게 보인다. */
        if (wo && wo.start_date) {
          const iso = new Date(wo.start_date).toISOString().slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) orderStartDate = iso;
        }
      } catch (e) {
        logger.warn(`[campaign] 작업오더 프리필(혼합 조합·유입방식·시작일) 실패 camp=${id}: ${e.message}`);
      }
      return res.json({ ok: true, data: rows[0], options, feeSchedules, orderReviewTypeMix, orderInflowType, orderStartDate, roundsLock });
    }
    const now = new Date();
    const row = rows[0];
    const countsMap = row.participation_mode ? await fetchCampaignCounts(pool, [id], now) : null;
    const schedMap = row.participation_mode ? await deriveSchedules(pool, tabsOfCampaigns([row]), now) : null;
    const view = _publicView(row, countsMap && countsMap.get(id), now, schedMap && scheduleFor(schedMap, row));
    _applyCurrentFee(view, await _loadFeeSchedules(pool, id), now);   // ★ 082: 오늘 구간 리뷰비
    // ★ D안 ①: 참여 전 상세에도 현금영수증 대상 여부(불리언만 — 상세 안내는 참여 후 work-detail)
    const _crm = await _cashReceiptFlags([row]);
    if (_crm) view.cashReceiptRequired = _crm.get(id) === true;
    if (row.participation_mode) {
      // 옵션명+잔여만 공개(금액 등 상세는 참여 후 work-detail에서)
      // ★ 목록과 같은 규칙 — 살아있는 옵션 0이면 옵션 구조 미노출(옵션 없는 공고로 보인다).
      const opts = await _loadOptionViews(pool, id, view, now);
      if (liveOptions(opts).length) view.options = opts.map(_publicOptionView);
    }
    res.json({ ok: true, data: view, serverNow: now.toISOString() });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/:id/applications — 참여 카운트 (공개)
//   ★ M1 보안: 신청자 실명 명단 무인증 반환 제거 — count만 반환(프론트 소비처 없음 확인).
//     전체 명단은 관리자 전용 GET /admin/:id/applications 사용.
router.get('/:id/applications', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'confirmed') AS legacy_count,
              COUNT(*) FILTER (WHERE status = 'submitted'
                               OR (status = 'applied' AND expires_at > NOW())) AS participation_count
         FROM campaign_applications
        WHERE campaign_id = $1`,
      [id]
    );
    const r = rows[0] || {};
    const count = (Number(r.legacy_count) || 0) + (Number(r.participation_count) || 0);
    res.json({ ok: true, data: [], count });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/:id/work-detail — 작업내용 (신청 게이트 뒤, PRD §03-E)
//   유효 홀드(시각 기준) 또는 제출확정 이력 + holdToken 일치 시에만 반환.
//   만료 403 — 유예 없음(당일 재신청 불가 정책과 함께 만료 화면에서 운영자 문의 안내).
router.get('/:id/work-detail', detailLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const p8 = String(req.query.phone8 || '').replace(/\D/g, '').slice(-8);
    const token = String(req.query.holdToken || '').trim();
    if (p8.length !== 8 || !token) {
      return res.status(400).json({ ok: false, error: 'phone8(8자리)과 holdToken이 필요합니다.' });
    }

    const { rows: camps } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
    if (camps.length === 0) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    const camp = camps[0];
    if (!camp.participation_mode) return res.status(404).json({ ok: false, error: '작업내용이 없는 공고입니다.' });

    // holdToken은 신청 시 발급된 1회성 열쇠 — phone8만 아는 제3자의 열람 차단(정확 일치)
    const { rows: apps } = await pool.query(
      `SELECT id, status, expires_at, applied_at, submitted_at, option_key, reject_reason, decided_at
         FROM campaign_applications
        WHERE campaign_id = $1 AND phone8 = $2 AND hold_token = $3 AND hold_token <> ''
        ORDER BY applied_at DESC
        LIMIT 1`,
      [id, p8, token]
    );
    if (apps.length === 0) {
      return res.status(403).json({ ok: false, error: '참여 내역이 없습니다.', reason: 'no_hold' });
    }
    const app = apps[0];
    /* ★ 127 블로그 승인제 — 대기/반려는 '만료'가 아니다. 별도 reason 으로 구분해 돌려준다.
       구버전 화면은 모르는 reason 을 재시도 경로로 처리해 홀드 토큰을 지우지 않는다(안전).
       신형 campaign.html 은 이 응답으로 대기/반려 화면을 그리고 30초 폴링으로 승인을 감지한다. */
    if (app.status === 'blog_pending') {
      return res.status(403).json({
        ok: false, reason: 'pending_approval',
        appliedAt: app.applied_at, serverNow: new Date().toISOString(),
        error: '신청이 접수되었어요. 관리자가 블로그를 확인하고 승인하면 구매를 진행할 수 있어요.',
      });
    }
    if (app.status === 'blog_rejected') {
      return res.status(403).json({
        ok: false, reason: 'apply_rejected',
        rejectReason: app.reject_reason || '', decidedAt: app.decided_at,
        error: '신청이 반려되었어요.' + (app.reject_reason ? ' 사유: ' + app.reject_reason : ''),
      });
    }
    const now = new Date();
    const validHold = app.status === 'applied' && app.expires_at && new Date(app.expires_at) > now;
    const isSubmitted = app.status === 'submitted';
    if (!validHold && !isSubmitted) {
      return res.status(403).json({
        ok: false, reason: 'expired',
        error: '참여가 만료되었어요. 구매양식을 제출하지 않았다면 다시 참여해서 새 구매양식을 열어주세요. 이미 구매하셨다면 운영자에게 문의해주세요.',
      });
    }

    // 유입방식: 모집공고에서 명시한 값(work_detail)이 진실원본이다.
    // 연결 작업오더 값은 과거 공고(work_detail 미기록)만 위한 폴백이다.
    const workDetail = sanitizeWorkDetail(camp.work_detail);
    const inflowType = (workDetail && workDetail.inflowType) || (await _lookupInflowType(camp.id, camp.source_work_order_id)) || '';

    // 상품옵션(참여 후 공개): 옵션 목록(금액 포함) + 내가 고른 옵션 + 변경 가능 여부
    let options = [], selectedOption = null;
    {
      const _sm = await deriveSchedules(pool, tabsOfCampaigns([camp]), now);
      const st = computeCampaignState(camp, (await fetchCampaignCounts(pool, [id], now)).get(id), now, scheduleFor(_sm, camp));
      options = await _loadOptionViews(pool, id, st, now);
      if (app.option_key) selectedOption = options.find(o => o.optKey === app.option_key) || { optKey: app.option_key, status: 'open' };
      options = _optionListForReviewer(options);   // ★ 고른 뒤에 덜어낸다(selectedOption 은 원본 유지)
    }
    // 옵션 변경은 유효 홀드(미제출) + 옵션 2개 이상일 때만 허용
    const canChangeOption = validHold && options.length >= 2;

    res.json({
      ok: true,
      serverNow: now.toISOString(),
      application: {
        id: app.id,
        status: app.status,
        appliedAt: app.applied_at,
        expiresAt: app.expires_at,
        submittedAt: app.submitted_at,
        optionKey: app.option_key || null,
      },
      options,               // [{ optKey, payAmount, remaining, todayRemaining, status, selectable, ... }]
      selectedOption,        // 내가 참여한 옵션(잠금표시·구매양식 고정용)
      canChangeOption,
      workDetail,                                                // HTML은 응답 직전 방어적 재정화
      inflowType,                                                 // 'guide' | 'link' | '' — 랜딩 버튼 게이트
      cashReceipt: await _cashReceiptInfo(camp),                  // 현영 탭만 {required, businessNo, guideImageUrl} — 아니면 null
      // 카톡 팀채팅방 URL은 제출확정 후에만 반환(화면 숨김을 API에서도 강제 — DevTools 우회 차단)
      chatUrl: isSubmitted ? (camp.chat_url || '') : '',
      landingUrl: camp.landing_url || '',
      form: {                                                     // 인라인 구매양식(iframe) 진입 파라미터
        sheetId: camp.linked_sheet_id || '',
        gid: camp.linked_tab_gid || '',
        tabName: camp.linked_tab_name || '',
        displayName: camp.title || '',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaign/:id/cancel — 본인 홀드 취소 (phone8+holdToken 이중 열쇠)
//   취소해도 당일 이력이 남아 같은 캠페인 당일 재신청은 불가(§03-C — 프론트 확인 다이얼로그에서 고지).
router.post('/:id/cancel', applyLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const p8 = String(req.body.phone8 || '').replace(/\D/g, '').slice(-8);
    const token = String(req.body.holdToken || '').trim();
    if (p8.length !== 8 || !token) {
      return res.status(400).json({ ok: false, error: 'phone8(8자리)과 holdToken이 필요합니다.' });
    }
    // status 조건부 UPDATE — 제출확정·스윕과의 경합에서도 원자적(이미 submitted면 0행)
    //   ★ 127: 블로그 승인 대기(blog_pending)도 리뷰어가 직접 취소할 수 있다(자리 미점유 상태라 무해).
    const { rows } = await pool.query(
      `UPDATE campaign_applications
          SET status = 'cancelled'
        WHERE campaign_id = $1 AND phone8 = $2 AND hold_token = $3 AND hold_token <> ''
          AND status IN ('applied', 'blog_pending')
        RETURNING id`,
      [id, p8, token]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '취소할 수 있는 참여가 없습니다.' });
    }
    logger.info(`[campaign/cancel] camp=${id} app=${rows[0].id} phone8=***${p8.slice(-4)}`);
    res.json({ ok: true, message: '참여가 취소되었습니다. 오늘은 이 캠페인에 다시 참여할 수 없어요.' });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaign/:id/change-option — 구매(제출) 전 옵션 변경 (phone8+holdToken 이중 열쇠, 061)
//   ★ 잠금 계층 = apply와 동일(recruit_campaigns 행 FOR UPDATE → 신청 행) → 소진 경합/교착 없음.
//   ★ 만료시각(expires_at)은 연장하지 않음(자리 갈아타기 악용 방지, PRD §07). 새 옵션 자리 확보 실패 시 기존 유지.
router.post('/:id/change-option', applyLimiter, async (req, res, next) => {
  const { id } = req.params;
  const p8 = String(req.body.phone8 || '').replace(/\D/g, '').slice(-8);
  const token = String(req.body.holdToken || '').trim();
  const newKey = _normOptKey(req.body.optionKey);
  if (p8.length !== 8 || !token) return res.status(400).json({ ok: false, error: 'phone8(8자리)과 holdToken이 필요합니다.' });
  if (!newKey) return res.status(400).json({ ok: false, error: '변경할 옵션을 선택해주세요.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!cRows.length || !cRows[0].participation_mode) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' }); }
    const camp = cRows[0];
    const now = new Date();

    // 내 유효 홀드(applied·미만료) 확인 — 제출완료면 변경 불가(관리자 정정 대상)
    const { rows: apps } = await client.query(
      `SELECT id, status, expires_at, option_key FROM campaign_applications
        WHERE campaign_id=$1 AND phone8=$2 AND hold_token=$3 AND hold_token<>'' ORDER BY applied_at DESC LIMIT 1 FOR UPDATE`,
      [id, p8, token]);
    if (!apps.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '참여 내역이 없습니다.' }); }
    const app = apps[0];
    if (app.status !== 'applied' || !app.expires_at || new Date(app.expires_at) <= now) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: 'not_changeable', error: '지금은 옵션을 변경할 수 없어요(제출 완료 또는 만료).' });
    }
    if (app.option_key === newKey) { await client.query('COMMIT'); return res.json({ ok: true, optionKey: newKey, unchanged: true }); }

    // 새 옵션: 활성 + 잔여/오늘 확인 (전환 대상은 자기 홀드를 포함하지 않음 = 기존 옵션에 계수돼 있음 → 순증 판정 정확)
    const { rows: optRows } = await client.query(
      `SELECT opt_key, pay_amount, recruit_total, daily_limit, status FROM campaign_options WHERE campaign_id=$1 AND opt_key=$2 LIMIT 1`,
      [id, newKey]);
    if (!optRows.length || optRows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, reason: 'option_invalid', error: '선택한 옵션을 찾을 수 없어요.' });
    }
    const st = computeCampaignState(camp, (await fetchCampaignCounts(client, [id], now)).get(id), now);
    const optCounts = await fetchOptionCounts(client, id, now);
    const ov = computeOptionView(optRows[0], optCounts.get(newKey), { state: 'open' }); // 변경은 캠페인 open 무관(이미 참여중)
    if (ov.status !== 'open') {
      await client.query('ROLLBACK');
      const reason = ov.status === 'soldout' ? 'option_soldout' : (ov.status === 'today_done' ? 'option_today_done' : 'option_closed');
      return res.status(409).json({ ok: false, reason, option: _publicOptionView(ov), error: '선택한 옵션은 마감되었어요. 다른 옵션을 선택해주세요.' });
    }

    // 원자 전환: 여전히 내 유효 홀드일 때만(경합 시 0행 → 기존 유지)
    const upd = await client.query(
      `UPDATE campaign_applications SET option_key=$4
        WHERE id=$1 AND campaign_id=$2 AND hold_token=$3 AND status='applied' AND expires_at > NOW()
        RETURNING id`,
      [app.id, id, token, newKey]);
    if (!upd.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, reason: 'not_changeable', error: '옵션 변경에 실패했어요. 다시 시도해주세요.' }); }
    await client.query('COMMIT');
    logger.info(`[campaign/change-option] camp=${id} app=${app.id} ${app.option_key || '∅'}→${newKey} phone8=***${p8.slice(-4)}`);
    return res.json({ ok: true, optionKey: newKey, previousOptionKey: app.option_key || null, option: ov });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    return next(err);
  } finally {
    client.release();
  }
});

// 참여형(홀드) 신청 — 원자 검사+홀드 생성 (레드-블루-심판 최종 구조)
//   잠금 계층(고정): ① recruit_campaigns 행 FOR UPDATE → ② owner advisory(xact) → ③ 명의 phone8 advisory(xact) → ④ INSERT.
//   주문확정(confirmHoldInTx)·수동확정도 ①을 먼저 잡으므로 write-skew(레드 #3)와 교착이 동시에 제거된다.
//   클래스 순서(캠페인 행 < owner < 명의)가 전역 고정 + tx당 클래스별 1락 = 순환 대기 불가.
// ★ 타계정 추가참여(063, PRD §09): subName/subPhone 존재 = 타계정 명의 참여. 홀드는 계속 "명의 phone8"로
//   키잉(uq_campaign_apps_active_hold 무변경 = §02 명의당 1건), 소유자 귀속은 owner_phone8 신설 컬럼.
async function _applyParticipation(req, res, next, campPre) {
  const id = campPre.id;
  const name = String(req.body.name || '').trim().slice(0, 100);
  const rawPhone = String(req.body.phone || '').trim().slice(0, 40);
  const p8 = rawPhone.replace(/\D/g, '').slice(-8);          // = 로그인 소유자 p8 (기존 의미 유지)
  if (!name) return res.status(400).json({ ok: false, error: '이름을 입력해주세요.' });
  if (p8.length !== 8) return res.status(400).json({ ok: false, error: '연락처를 정확히 입력해주세요.' });

  // ★ 타계정 참여 요청 신호(063): 서버가 소유자의 sub_accounts로 명의를 재검증(임의 명의 위조 차단)
  const subName = String(req.body.subName || '').trim().slice(0, 100);
  const subPhoneRaw = String(req.body.subPhone || '').trim().slice(0, 40);
  const isSubApply = !!(subName || subPhoneRaw);
  const subP8 = subPhoneRaw.replace(/\D/g, '').slice(-8);

  // ★★ 블로그체험단(101): 블로그 공고는 **블로그 주소가 참여의 조건**이다 — 그 값이 있어야
  //   담당자가 누구를 뽑았는지·어디에 글이 올라올지 알 수 있다. 리뷰체험단은 이 칸 자체가 없다.
  //   ★ 잠금(pool.connect) **앞**에서 막는다 = 자리 미점유(내정보 게이트와 같은 규율) + 커넥션 무점유.
  //   ★ 판정은 `workKindContext`(공고 > 탭, 60초 캐시) 단일 출처 — 규칙 사본 0.
  //   ★ **판정 실패·리뷰체험단은 종전 동작 그대로**(모르면 요구하지 않는다 — 멀쩡한 참여를 막는 쪽이 더 나쁘다).
  let blogUrlIns = null;
  let blogApply = false;   // ★ 127: 이 신청이 블로그체험단인가(승인제 분기의 근거)
  {
    let _kind = null;
    try {
      _kind = resolveWorkKind({
        campaignKind: campPre.work_kind,
        tabKind: await tabWorkKind({ sheetId: campPre.linked_tab_sheet_id, tabName: campPre.linked_tab_name }),
      });
    } catch (_) { _kind = null; }
    if (isBlogKind(_kind)) {
      blogApply = true;
      const raw = String(req.body.blogUrl || '').trim().slice(0, 500);
      if (!isPostUrl(raw)) {
        return res.status(403).json({
          ok: false, reason: 'blog_url_required',
          error: `블로그 주소를 입력해주세요 (${BLOG_URL_HINT})`,
        });
      }
      blogUrlIns = raw;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ① 캠페인 행 잠금 — 이 캠페인의 모든 신청/확정 쓰기 직렬화(READ COMMITTED write-skew 원천 차단)
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!cRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' }); }
    const camp = cRows[0];
    const now = new Date();
    const weekend = weekendPublicationState(camp, now);
    if (weekend.blocked) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        ok: false,
        reason: weekend.reason,
        resumesOn: weekend.resumesOn,
        error: weekend.message,
      });
    }

    // ★ 타계정 게이트 1(063): 공고 토글(§09-1 기본 불가) + 명의 형식 + 같은번호 배제(phone8=시스템 신원키 보호)
    if (isSubApply) {
      if (camp.multi_account_mode !== true) {
        await client.query('ROLLBACK');
        return res.status(403).json({ ok: false, reason: 'multi_disabled', error: '이 공고는 타계정 참여를 지원하지 않아요.' });
      }
      if (subP8.length !== 8 || !subName) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, reason: 'sub_invalid', error: '타계정 이름과 전화번호를 확인해주세요.' });
      }
      if (subP8 === p8) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, reason: 'sub_shares_owner_phone', error: '본계정과 같은 번호의 타계정은 별도 참여할 수 없어요.' });
      }
    }

    // 명의 신원(홀드 키) = 타계정이면 서브 p8, 아니면 본인 p8 — 이후 모든 명의-키 게이트가 이 값 사용
    const holdP8 = isSubApply ? subP8 : p8;

    // ② owner advisory(xact) — 소유자 합산 상한(§09-2 동시 10건)의 write-skew 차단.
    //   교차 캠페인 동시 apply도 소유자 단위로 직렬화(캠페인 행 락은 캠페인별이라 이 락이 필요).
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('camp_hold_owner:' || $1::text))`, [p8]);
    // ③ 명의 phone8 advisory(xact) — 교차 캠페인 명의 홀드 상한의 동시성(항상 owner 락 뒤 = 교착 불가)
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('camp_hold_phone:' || $1::text))`, [holdP8]);

    // 잠금 후 신선 재집계 → 상태 게이트(open만 통과; READ COMMITTED 문장별 새 스냅샷이 선행 커밋 반영)
    const countsMap = await fetchCampaignCounts(client, [id], now);
    // ★ 카드 표시와 동일한 일정을 참여 게이트에도 적용(불일치 = 오픈처럼 보이는데 참여 거부 / 그 반대).
    //   1분 캐시라 보통 추가 쿼리 없음. 잠금 커넥션(client)으로 읽어 커넥션 고갈 교착을 피한다.
    const schedMap = await deriveSchedules(client, tabsOfCampaigns([camp]), now);
    const st = computeCampaignState(camp, countsMap.get(id), now, scheduleFor(schedMap, camp));
    if (st.state !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: st.state, state: st, error: '지금은 신청할 수 없습니다.' });
    }

    // ★ 상품옵션 게이트(061): 옵션이 "등록된" 캠페인이면 선택 필수(전부 마감이어도 option_key=NULL 우회 금지, 리뷰 #3).
    //   옵션 미등록 캠페인만 현행 경로(NULL). 캠페인 행 FOR UPDATE 안이라 옵션 카운트도 직렬화 — 소진 경합 없음.
    let chosenOpt = null;
    {
      const { rows: allOpts } = await client.query(
        `SELECT opt_key, pay_amount, recruit_total, daily_limit, status
           FROM campaign_options WHERE campaign_id = $1 ORDER BY (status='closed'), sort_order, id`, [id]);
      // ★★ 옵션 공고 판정은 **살아있는 옵션 기준**(`liveOptions` 단일 출처, 2026-08-07 우레온 건).
      //   종전엔 closed 포함 `allOpts.length` 로 판정해, 관리자가 잘못 생긴 옵션을 정리(마감)하면
      //   그 코드로 **공고가 영구 잠겼다**(참여자 있는 옵션은 삭제 대신 closed 보존이라 되돌릴 방법이 없었다).
      //   closed 만 남은 공고 = 옵션 구조가 정리된 공고 → 옵션 없이 참여(chosenOpt=null).
      //   ★ soldout·today_done 은 activeOpts 에 그대로 남아 아래 게이트가 종전대로 차단한다(완화 아님).
      const activeOpts = liveOptions(allOpts);
      if (activeOpts.length) {
        const wantKey = _normOptKey(req.body.optionKey);
        if (!wantKey) {
          await client.query('ROLLBACK');
          return res.status(400).json({ ok: false, reason: 'option_required', error: '참여할 옵션을 선택해주세요.', options: activeOpts.map(o => o.opt_key) });
        }
        chosenOpt = activeOpts.find(o => o.opt_key === wantKey) || null;
        if (!chosenOpt) {
          await client.query('ROLLBACK');
          return res.status(400).json({ ok: false, reason: 'option_invalid', error: '선택한 옵션을 찾을 수 없어요. 새로고침 후 다시 선택해주세요.' });
        }
        const optCounts = await fetchOptionCounts(client, id, now);
        const ov = computeOptionView(chosenOpt, optCounts.get(chosenOpt.opt_key), st);
        if (ov.status !== 'open') {
          await client.query('ROLLBACK');
          const reason = ov.status === 'soldout' ? 'option_soldout' : (ov.status === 'today_done' ? 'option_today_done' : 'option_closed');
          return res.status(409).json({ ok: false, reason, option: _publicOptionView(ov), error: '선택한 옵션은 마감되었어요. 다른 옵션을 선택해주세요.' });
        }
      }
    }

    // 등록 리뷰어만(레드 #12) — 조회 대상은 항상 "소유자"(로그인 p8). ★ 063: sub_accounts 동봉(명의 검증용)
    const reg = await client.query(
      `SELECT name, phone, phone8, address, bank_name, bank_account, account_holder, sub_accounts
         FROM reviewers WHERE phone8 = $1 LIMIT 1`, [p8]);
    if (!reg.rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ ok: false, reason: 'not_registered', error: '리뷰어 등록 후 참여할 수 있어요.' });
    }

    // ★ 공고별 참여 리뷰어 게이트(091) — 홀드 생성 전 차단 = 자리 미점유·당일 참여권 무손실.
    //   판정 단일 출처 = utils/reviewerGate(공고별 allow > block > 전역 옵트인). 키는 소유자(로그인) p8 —
    //   타계정 명의 차단은 후속(문서화된 한계). 기존 홀드·확정 건은 건드리지 않는다(사용자 확정 Q1).
    //   ★★ SAVEPOINT 격리(082 규율): 테이블 부재·조회 실패가 tx 를 abort 시켜 참여를 죽이면 안 된다.
    //   fail-open — 막는 기능의 오류로 정상 참여가 막히는 쪽이 못 막는 것보다 나쁘다(신원게이트와 같은 규율).
    if (require('../utils/reviewerGate').gateEnabled()) {
      let gateDecision = null;
      try {
        await client.query('SAVEPOINT rg_gate');
        const { checkApplyGate } = require('../services/reviewerGate.service');
        gateDecision = await checkApplyGate(client, id, p8);
        await client.query('RELEASE SAVEPOINT rg_gate');
      } catch (e) {
        try { await client.query('ROLLBACK TO SAVEPOINT rg_gate'); } catch (_e) { /* noop */ }
        logger.warn('[reviewerGate] apply 판정 실패(fail-open): ' + e.message);
      }
      if (gateDecision && gateDecision.blocked) {
        await client.query('ROLLBACK');
        // gate:'closed' = 마감 위장(프론트가 실제 마감 화면과 동일 렌더) / 'policy' = 사유 고지
        return res.status(403).json({ ok: false, reason: 'reviewer_blocked', gate: gateDecision.gate, error: gateDecision.message });
      }
    }

    // ★ M2 변경①: 내정보 완비 게이트를 "참여 시점"으로 전진 — 구매양식 신원게이트(#272)가 제출 순간
    //   차단하면 리뷰어는 이미 결제 후 15분 홀드 안에서 막힌다(돈 쓴 뒤 좌절 + 당일 재참여 불가).
    //   여기서 미리 막으면 홀드 미생성 = 자리 미점유 = 당일 참여권 무손실. 제출 단계 검사는 안전망으로 유지.
    //   ★ 063: 판정 기준은 항상 "소유자"(타계정 프로필은 제출측 SUB 자동보강이 담당, §02 신원확인 재사용)
    {
      const { profileMissing } = require('../services/identity.service');
      const missing = profileMissing(reg.rows[0]);
      if (missing.length) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          ok: false, reason: 'profile_missing', missing,
          error: `내 정보를 먼저 등록해주세요: ${missing.join(', ')} — 참여 후 15분 안에 제출까지 끝나야 해서, 미리 등록이 필요해요.`,
        });
      }
    }

    // ★ 타계정 게이트 2(063): 명의가 소유자의 sub_accounts에 정확일치(이름+phone8)해야 함 — 서버 검증
    let subEntry = null;
    if (isSubApply) {
      const { findSubAccount } = require('../services/identity.service');
      const hit = findSubAccount(reg.rows[0].sub_accounts, subName, subP8);
      if (!hit) {
        await client.query('ROLLBACK');
        return res.status(403).json({ ok: false, reason: 'sub_not_registered',
          error: '등록된 타계정이 아니에요. 내정보 > 타계정에서 먼저 등록해주세요.' });
      }
      subEntry = hit.sub;

      // ★★ 방어 D1(사칭 차단): sub_accounts 는 "소유 증명"이 아니다 — 무인증
      //   POST /api/reviewer/profile{action:'saveSubAccounts'} 가 phone8 만 알면 배열을 통째로 덮어쓴다
      //   (번호 소유 증명 없음). 그래서 "이미 리뷰어로 직접 등록된 번호"는 타인의 명의로 못 쓰게 한다.
      //   ─ 피해자 = 자기 계정으로 참여하는 실존 리뷰어이므로 이 한 줄이 강탈 대상 전체를 덮는다.
      //   ─ 정당 사용자 손실 0: 그 번호의 본인이 자기 계정으로 직접 참여하면 된다.
      //   ─ reviewers.phone8 은 phone 파생 GENERATED 컬럼이고 유니크는 UNIQUE(phone)(원문)뿐 →
      //     같은 phone8 행이 복수 존재 가능하므로 행 동일성이 아니라 EXISTS 로 판정(idx_reviewers_phone8).
      //   ─ 완화: CAMPAIGN_SUB_REGISTERED_POLICY = block(기본) | warn(로그만) | allow(검사 자체 생략)
      const _subPolicy = String(process.env.CAMPAIGN_SUB_REGISTERED_POLICY || 'block').toLowerCase();
      if (_subPolicy !== 'allow') {
        const { rows: regHit } = await client.query(
          'SELECT 1 FROM reviewers WHERE phone8 = $1 LIMIT 1', [subP8]);
        if (regHit.length) {
          logger.warn(`[campaign/apply] 등록번호 명의 시도 camp=${id} owner=***${p8.slice(-4)} ` +
            `명의=***${subP8.slice(-4)} policy=${_subPolicy}`);
          if (_subPolicy === 'block') {
            await client.query('ROLLBACK');
            return res.status(409).json({ ok: false, reason: 'sub_is_registered_reviewer',
              error: '이 번호는 이미 리뷰어로 직접 등록되어 있어요. 해당 번호의 본인 계정으로 로그인해서 참여해주세요.' });
          }
        }
      }
    }

    const dayStartIso = kstDayStartUtc(now).toISOString();

    // 이력 선검사(23505 대신 명확한 사유, 심판 J8) — "참여하기" 홀드는 당일 제한을 소진하지 않는다.
    // 구매양식이 정상 제출되어 status='submitted'가 된 건만 참여 완료로 본다.
    //   신규 사유: blocked_by_other_owner(=남이 이 번호를 명의로 선점 = 사칭/오등록 신호),
    //             same_phone_other_name(=같은번호 다른명의 A안이 phone8 키잉으로 접힌 경우의 원인 설명).
    const holdNameCandidate = isSubApply ? String((subEntry && subEntry.name) || subName).trim() : name;
    const blk = await client.query(
      `SELECT status, applicant_name, owner_phone8
         FROM campaign_applications
        WHERE campaign_id = $1 AND phone8 = $2 AND status = 'submitted'
        ORDER BY submitted_at DESC NULLS LAST
        LIMIT 1`,
      [id, holdP8]);
    if (blk.rows.length) {
      const b0 = blk.rows[0];
      const blockedByOther = !!b0.owner_phone8 && String(b0.owner_phone8) !== p8;
      await client.query('ROLLBACK');
      if (blockedByOther) {
        logger.warn(`[campaign/apply] 타소유자 선점 차단 camp=${id} 명의=***${holdP8.slice(-4)} ` +
          `선점owner=***${String(b0.owner_phone8).slice(-4)} 요청owner=***${p8.slice(-4)} status=${b0.status}`);
        return res.status(409).json({ ok: false, reason: 'blocked_by_other_owner',
          error: '이 번호는 다른 계정에서 이미 참여 신청했어요. 본인 번호가 맞다면 고객센터로 알려주세요.' });
      }
      if (b0.status === 'submitted') {
        return res.status(409).json({ ok: false, reason: 'already_submitted', error: '이미 참여 완료한 캠페인이에요.' });
      }
      const { normName } = require('../services/identity.service');
      const usedBy = String(b0.applicant_name || '').trim();
      if (normName(usedBy) && normName(usedBy) !== normName(holdNameCandidate)) {
        // ★ 이름 공개는 "요청자가 그 번호에 대한 근거를 가진 경우"로 제한 —
        //   자기참여(그 번호로 로그인) 또는 내 소유로 귀속된 행. 레거시(owner NULL) 행을 타계정 명의로
        //   조회하는 경우엔 이름을 숨긴다(무인증 API로 남의 실명을 캐는 통로 차단).
        const nameSafe = !isSubApply || String(b0.owner_phone8 || '') === p8;
        return res.status(409).json({ ok: false, reason: 'same_phone_other_name',
          usedBy: nameSafe ? usedBy : undefined,
          error: nameSafe
            ? `같은 번호로 등록된 다른 명의(${usedBy})가 오늘 이미 참여했어요. 번호가 같은 명의는 하루 1건만 가능해요.`
            : '같은 번호로 등록된 다른 명의가 오늘 이미 참여했어요. 번호가 같은 명의는 하루 1건만 가능해요.' });
      }
      return res.status(409).json({ ok: false, reason: 'already_submitted', error: '이미 구매양식 제출까지 완료한 캠페인이에요.' });
    }

    // ★ 재참여(재구매) 기간 제한 — "같은 작업(탭)" 기준(사용자 확정 2026-08-24). 위 검사는 같은
    //   recruit_campaigns.id 안에서만 막지만, 공고가 재발행(차수)되거나 캠페인 연결 없이 외부모집으로
    //   등록되면 이 탭에서만 다시 잡아야 한다. 단일 출처 = utils/repurchaseGuard(외부모집 수동제출과 공용).
    //   ★ 하드 차단·예외 없음(리뷰어 셀프 참여는 관리자 확인 창구가 없다 — 관리자 대신등록만 예외 허용).
    //   조회 실패는 fail-open(막는 기능의 오류로 정상 참여를 막지 않는다 — 신원게이트와 같은 규율).
    if (camp.linked_sheet_id && camp.linked_tab_name) {
      try {
        const { checkRepurchaseWindow } = require('../utils/repurchaseGuard');
        const rw = await checkRepurchaseWindow(client, {
          sheetId: camp.linked_sheet_id, tabName: camp.linked_tab_name, phone8: holdP8,
        });
        if (rw.blocked) {
          await client.query('ROLLBACK');
          const dateStr = rw.availableFrom.toLocaleDateString('ko-KR', {
            timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short',
          });
          return res.status(409).json({
            ok: false, reason: 'repurchase_window', days: rw.days, availableFrom: rw.availableFrom,
            error: `이 작업은 최근 ${rw.days}일 안에 이미 참여한 이력이 있어요 — ${dateStr} 이후 다시 참여할 수 있어요.`,
          });
        }
      } catch (e) {
        logger.warn('[campaign/apply] 재참여 기간 판정 실패(fail-open): ' + e.message);
      }
    }

    // 만료 스윕은 정리 작업이지만, 부분 유니크 인덱스는 `status='applied'` 행을 즉시
    // 중복으로 본다. 스윕의 다음 실행 전(최대 1분)에 재참여하면 화면/카운트는 이미
    // 재참여 가능인데 INSERT만 duplicate_hold로 막히는 간극이 생긴다. 같은 grace 경계를
    // 적용 요청 안에서도 사용해 해당 명의의 실제 만료 홀드를 먼저 expired로 전이한다.
    // 캠페인 행 + 명의 advisory lock을 이미 확보했으므로 이 전이와 새 홀드 생성은 직렬화된다.
    const { HOLD_GRACE_SEC } = require('../services/campaignHold.service');
    await client.query(
      `UPDATE campaign_applications
          SET status = 'expired'
        WHERE campaign_id = $1 AND phone8 = $2
          AND status = 'applied'
          AND expires_at <= NOW() - make_interval(secs => $3)`,
      [id, holdP8, HOLD_GRACE_SEC]
    );

    // 명의별 전역 상한: 활성홀드 2건 + 당일 구매양식 제출완료 총량.
    const caps = await client.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'applied' AND expires_at > NOW()) AS active_holds,
              COUNT(*) FILTER (WHERE status = 'submitted' AND submitted_at >= $2) AS today_submitted
         FROM campaign_applications WHERE phone8 = $1`,
      [holdP8, dayStartIso]);
    if (Number(caps.rows[0].active_holds) >= (parseInt(process.env.CAMPAIGN_HOLD_CAP || '2', 10) || 2)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: 'hold_cap', error: '동시에 참여 가능한 캠페인은 2개까지예요.' });
    }
    if (Number(caps.rows[0].today_submitted) >= (parseInt(process.env.CAMPAIGN_DAILY_APPLY_CAP || '10', 10) || 10)) {
      await client.query('ROLLBACK');
      return res.status(429).json({ ok: false, reason: 'daily_apply_cap', error: '오늘 구매양식 제출까지 완료한 참여 횟수를 넘었어요.' });
    }

    // ★ 소유자 합산 동시홀드 상한(063, §09-2 동시 10건): COALESCE 귀속 — 레거시 NULL 행은 자기 phone8로 귀속
    const ownerCap = parseInt(process.env.CAMPAIGN_OWNER_HOLD_CAP || '10', 10) || 10;
    const own = await client.query(
      `SELECT COUNT(*) AS n FROM campaign_applications
        WHERE COALESCE(owner_phone8, phone8) = $1 AND status = 'applied' AND expires_at > NOW()`, [p8]);
    if (Number(own.rows[0].n) >= ownerCap) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: 'owner_hold_cap',
        error: `본인+타계정 합산 동시 ${ownerCap}건까지만 자리를 잡을 수 있어요.` });
    }

    // ★ 캠페인별 타계정 하루한도(063, §09-5): 구매양식 제출완료만 집계한다.
    if (isSubApply && Number(camp.multi_daily_limit) > 0) {
      const md = await client.query(
        `SELECT COUNT(*) AS n FROM campaign_applications
          WHERE campaign_id = $1 AND owner_phone8 = $2 AND phone8 <> owner_phone8
            AND status = 'submitted' AND submitted_at >= $3`,
        [id, p8, dayStartIso]);
      if (Number(md.rows[0].n) >= Number(camp.multi_daily_limit)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, reason: 'sub_daily_limit',
          error: `타계정 참여는 이 공고에서 하루 ${camp.multi_daily_limit}건까지예요(내일 가능).` });
      }
    }

    // ★ 인기상품 참여권: 동일 명의의 일반 모집 제출완료 1건당 인기상품 1건을 허용한다.
    //   기존 선행우선순위 데이터는 삭제하지 않고 무시해 롤백 가능성을 보존한다.
    if (camp.is_popular === true) {
      const creditState = await loadPopularCreditState(client, holdP8);
      if (!canUsePopularCredit(creditState)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ ok: false, reason: 'popular_locked', normalDone: creditState.normalDone, popularUsed: creditState.popularUsed,
          error: '인기 상품은 일반 모집 1건을 먼저 제출완료해야 참여할 수 있어요. (일반 1건 = 인기 1건)' });
      }
    }

    // 홀드 생성: expires_at = min(now+TTL, 오늘 window_end) — state=open이므로 closesAt는 유효·미래.
    // ★ 자율주문(시간창 미설정)은 closesAt이 null → TTL만 적용. ★ 063 §09-2: 타계정 건 TTL = sub_hold_ttl_min(기본 10분)
    const ttlMin = isSubApply ? (Number(camp.sub_hold_ttl_min) || 15) : (Number(camp.hold_ttl_min) || 30);
    const ttlMs = ttlMin * 60000;
    const closesAt = kstTodayAt(camp.window_end, now);
    const expiresAt = new Date(closesAt ? Math.min(now.getTime() + ttlMs, closesAt.getTime()) : now.getTime() + ttlMs);
    const holdToken = crypto.randomBytes(24).toString('base64url');
    // 명의 표기값은 서버 권위(등록된 sub_accounts 값 우선 — 요청 오타로 홀드/신원판별 표기가 갈라지는 것 방지)
    const insName = isSubApply ? String((subEntry && subEntry.name) || subName).trim() : name;
    const insPhone = isSubApply ? String((subEntry && subEntry.phone) || subPhoneRaw) : rawPhone;
    // ★ 082: 참여 시점 리뷰비를 이 건에 새긴다 = **리뷰어가 화면에서 본 금액**(사용자 확정: 기준일 = 참여일).
    //   이후 관리자가 구간표를 어떻게 고쳐도 이 건의 표기는 안 바뀐다.
    //   ★ 캠페인 행을 이미 잠근 안이라 저장 중간 상태를 볼 수 없다. 조회 실패는 null(=날짜 기준 폴백) — 참여를 막지 않는다.
    //   ★★ SAVEPOINT 필수: 트랜잭션 안에서는 **실패한 쿼리 하나가 tx 전체를 abort** 시킨다
    //      (구간 테이블이 아직 없는 배포 창 등) → 스냅샷 조회 실패가 참여 INSERT 를 통째로
    //      죽이는 것을 격리한다. 주문원장의 홀드확정 SAVEPOINT 와 같은 규율.
    let feeSnapshot = null;
    try {
      await client.query('SAVEPOINT fee_snap');
      const sched = await _loadFeeSchedules(client, id);
      if (sched.length) feeSnapshot = currentReviewFee(sched, camp.review_fee, now);
      await client.query('RELEASE SAVEPOINT fee_snap');
    } catch (_) {
      feeSnapshot = null;
      try { await client.query('ROLLBACK TO SAVEPOINT fee_snap'); } catch (_e) { /* noop */ }
    }
    /* ★★ 127 블로그 승인제(사용자 확정 2026-08-19): 블로그 공고의 신청은 홀드가 아니라
         **승인 대기(blog_pending)** 로 들어간다 — TTL 없음(expires_at NULL)·정원 미점유.
         관리자가 [승인]하면 그때 status='applied' + 구매기한(기본 24h)이 찍혀 기존 홀드
         파이프라인을 그대로 탄다. 킬스위치 BLOG_APPROVAL_FLOW=0 = 신규 신청만 종전
         즉시-홀드 경로(이미 대기 중인 신청은 승인 API 로 소화 — 되돌려도 고아 없음). */
    const blogApproval = blogApply && String(process.env.BLOG_APPROVAL_FLOW || '1') !== '0';
    const insStatus = blogApproval ? 'blog_pending' : 'applied';
    const insExpires = blogApproval ? null : expiresAt.toISOString();
    const ins = await client.query(
      `INSERT INTO campaign_applications
         (campaign_id, applicant_name, applicant_phone, phone8, owner_phone8, status, expires_at, hold_token, option_key, review_fee_snapshot, blog_url, is_popular_snapshot)
       VALUES ($1,$2,$3,$4,$5,$12,$6,$7,$8,$9,$10,$11)
       RETURNING id, status, expires_at, option_key`,
      [id, insName, insPhone, holdP8, p8, insExpires, holdToken, chosenOpt ? chosenOpt.opt_key : null, feeSnapshot, blogUrlIns, camp.is_popular === true, insStatus]);
    await client.query('COMMIT');
    logger.info(`[campaign/apply] 홀드 생성 camp=${id} app=${ins.rows[0].id} phone8=***${holdP8.slice(-4)}` +
      (isSubApply ? ` sub(owner=***${p8.slice(-4)})` : '') + (chosenOpt ? ' opt=' + chosenOpt.opt_key : ''));
    return res.json({
      ok: true, applicationId: ins.rows[0].id, holdToken,
      // ★ 127: pending=true = 승인 대기(구매 불가) — 프론트가 "승인 대기 중" 화면으로 분기
      pending: ins.rows[0].status === 'blog_pending',
      status: ins.rows[0].status,
      phone8: holdP8,   // ★ 계약(레드 #4): 응답 phone8 = "명의" p8 — 프론트 h.phone8 → work-detail/cancel/change-option/embed holdPhone8 전 경로 무수정 정합
      ownerPhone8: p8,  // 소유자(요청자 자신 — 유출 아님). 2단계 명의 배지·복원용
      participant: { type: isSubApply ? 'sub' : 'self', name: insName },
      expiresAt: ins.rows[0].expires_at, serverNow: now.toISOString(),
      optionKey: ins.rows[0].option_key || null,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (err.code === '23505') return res.status(409).json({ ok: false, reason: 'duplicate_hold', error: '이미 참여 중인 캠페인입니다.' }); // uq_campaign_apps_active_hold 백스톱
    return next(err);
  } finally {
    client.release();
  }
}

// POST /api/campaign/:id/apply — 참여 신청
router.post('/:id/apply', applyLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, inad } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ ok: false, error: '이름을 입력해주세요.' });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ ok: false, error: '연락처를 입력해주세요.' });
    }

    const trimName = name.trim();
    const trimPhone = phone.trim();
    const trimInad = (inad || '').trim();

    // 1. 캠페인 존재 + 상태 확인
    const { rows: campRows } = await pool.query(
      'SELECT * FROM recruit_campaigns WHERE id = $1',
      [id]
    );
    if (campRows.length === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    const camp = campRows[0];

    /* ★★ 130: 보관된 공고는 참여를 받지 않는다. 목록에는 안 보이는데 링크로는 참여되는
       상태를 만들지 않는다(085 리뷰어 숨김이 "링크를 알면 참여 가능"인 것과 의도적으로 다르다
       — 저쪽은 테스트용 비공개, 이쪽은 끝난 공고다). 레거시·참여형 분기보다 앞에 둔다. */
    if (camp.archived_at) {
      return res.status(403).json({ ok: false, reason: 'archived', error: '모집이 종료된 공고입니다.' });
    }

    const weekend = weekendPublicationState(camp);
    if (weekend.blocked) {
      return res.status(403).json({
        ok: false,
        reason: weekend.reason,
        resumesOn: weekend.resumesOn,
        error: weekend.message,
      });
    }

    // ★ 참여형 공고는 레거시 경로(슬롯 증가·시트 행 추가) 진입 금지 — 홀드 기반 신규 경로로 처리
    if (camp.participation_mode) {
      return _applyParticipation(req, res, next, camp);
    }

    if (camp.status !== 'active') {
      return res.status(400).json({ ok: false, error: '모집이 마감된 캠페인입니다.' });
    }

    // 2. 정원 초과 확인
    if (camp.max_slots > 0 && camp.current_slots >= camp.max_slots) {
      // 자동 마감 처리
      await pool.query("UPDATE recruit_campaigns SET status = 'closed', updated_at = NOW() WHERE id = $1", [id]);
      return res.status(400).json({ ok: false, error: '정원이 초과되어 모집이 마감되었습니다.' });
    }

    // 3. 중복 신청 확인
    const { rows: dupRows } = await pool.query(
      `SELECT id FROM campaign_applications 
       WHERE campaign_id = $1 AND applicant_name = $2 AND applicant_phone = $3 AND status = 'confirmed'`,
      [id, trimName, trimPhone]
    );
    if (dupRows.length > 0) {
      return res.status(400).json({ ok: false, error: '이미 참여 신청한 캠페인입니다.' });
    }

    // 4. 참여 기록 저장
    await pool.query(
      `INSERT INTO campaign_applications (campaign_id, applicant_name, applicant_phone, applicant_inad, status)
       VALUES ($1, $2, $3, $4, 'confirmed')`,
      [id, trimName, trimPhone, trimInad]
    );

    // 5. current_slots 증가
    const { rows: updatedRows } = await pool.query(
      `UPDATE recruit_campaigns SET current_slots = current_slots + 1, updated_at = NOW() WHERE id = $1 RETURNING current_slots, max_slots`,
      [id]
    );
    const updatedCamp = updatedRows[0];

    // 6. 정원 꽉 찬 경우 자동 마감
    if (updatedCamp.max_slots > 0 && updatedCamp.current_slots >= updatedCamp.max_slots) {
      await pool.query("UPDATE recruit_campaigns SET status = 'closed', updated_at = NOW() WHERE id = $1", [id]);
    }

    // 7. 스프레드시트에 행 자동 추가 (비동기 — 실패해도 참여 확정됨)
    if (camp.linked_sheet_id && camp.linked_tab_name) {
      setImmediate(async () => {
        try {
          await _addApplicationToSheet(camp, { name: trimName, phone: trimPhone, inad: trimInad });
          // 시트 추가 성공 기록
          await pool.query(
            `UPDATE campaign_applications SET sheet_row_added = TRUE 
             WHERE campaign_id = $1 AND applicant_name = $2 AND applicant_phone = $3`,
            [id, trimName, trimPhone]
          );
          logger.info(`[campaign/apply] 시트 행 추가 성공: ${camp.title} - ${trimName}`);
        } catch (sheetErr) {
          logger.error(`[campaign/apply] 시트 행 추가 실패: ${sheetErr.message}`);
        }
      });
    }

    res.json({
      ok: true,
      message: '참여 신청이 완료되었습니다!',
      currentSlots: updatedCamp.current_slots,
      maxSlots: updatedCamp.max_slots,
    });
  } catch (err) {
    // 유니크 제약 위반 (동시 요청 방어)
    if (err.code === '23505') {
      return res.status(400).json({ ok: false, error: '이미 참여 신청한 캠페인입니다.' });
    }
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 관리자 API (인증 필요)
// ═══════════════════════════════════════════════════════════

// GET /api/campaign/admin/list — 관리자 전체 목록 (draft 포함)
/**
 * 관리자 카드에만 필요한 운영 집계 — **지각 접수(late) 건수**.
 *   late_order_id = 홀드 만료/취소 뒤에 주문이 도착한 건. 리뷰어는 이미 결제했는데 자리가 없는 상태라
 *   수동확정(POST /admin/:id/confirm)이 유일한 구제 경로다 → 카드의 빨간 원이 이 수를 가리킨다.
 *   수동확정되면 status가 'submitted'로 바뀌므로 아래 필터에서 자동으로 빠진다(처리 즉시 원 소멸).
 *   ※ 만료·취소 자체는 세지 않는다 — 신청만 하고 구매하지 않은 건이라 자리가 이미 반환돼 할 일이 없다.
 *     매일 숫자가 떠 있으면 정작 급한 지각 건이 묻히므로 의도적으로 제외한다.
 */
/** 127: 공고별 승인 대기(blog_pending) 건수 — 카드 관제 버튼 배지 재료(지각 배지와 같은 규율:
 *  "반드시 눌러야 하는" 신호. blog 에서 그 신호는 승인 대기다). 실패는 호출부 fail-soft. */
async function _fetchBlogPendingCounts(pool, campaignIds) {
  const out = new Map();
  const ids = (campaignIds || []).filter(Boolean);
  if (!ids.length) return out;
  const { rows } = await pool.query(
    `SELECT campaign_id, COUNT(*) AS n
       FROM campaign_applications
      WHERE campaign_id = ANY($1) AND status = 'blog_pending'
      GROUP BY campaign_id`,
    [ids]
  );
  for (const r of rows) out.set(r.campaign_id, Number(r.n) || 0);
  return out;
}

async function _fetchLateCounts(pool, campaignIds) {
  const out = new Map();
  const ids = (campaignIds || []).filter(Boolean);
  if (!ids.length) return out;
  const { rows } = await pool.query(
    `SELECT campaign_id, COUNT(*) AS late
       FROM campaign_applications
      WHERE campaign_id = ANY($1)
        AND late_order_id IS NOT NULL
        AND status IN ('expired', 'cancelled')
        AND dismissed_at IS NULL
      GROUP BY campaign_id`,
    [ids]
  );
  for (const r of rows) out.set(r.campaign_id, Number(r.late) || 0);
  return out;
}

/**
 * 관리자 목록. 원본 행 전체 + **리뷰어 목록과 동일한 상태 계산**을 함께 내려준다.
 *   관리자 카드가 리뷰어 카드와 같은 컴포넌트로 그려지므로 같은 입력(state/dailyQuota/todayCount/
 *   opensAt/cutoffAt…)이 필요하다. 두 화면이 다른 계산을 쓰면 "카드는 모집중인데 참여는 거부" 같은
 *   불일치가 생기므로 계산 경로를 하나로 묶는다.
 *   ops = 관리자 전용 운영 수치(진행중 홀드·오늘 제출·누적 확정·지각) — 리뷰어 응답엔 없다.
 */
router.get('/admin/list', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    await _ensureTables();
    const now = new Date();
    /* ★ 130: 기본 목록은 **보관하지 않은 공고만**. `?archived=1` 이면 보관함(보관분만).
       거르는 곳이 두 갈래인 이유 = 보관함을 보여줄 화면이 필요하기 때문(서버가 통째로
       거르면 보관함이 영원히 빈다 — 088 마감 보관함과 같은 규율). */
    const _archivedView = String(req.query.archived || '') === '1';
    const { rows } = await pool.query(`
      SELECT * FROM recruit_campaigns
      WHERE archived_at IS ${_archivedView ? 'NOT NULL' : 'NULL'}
      ORDER BY
        ${_archivedView ? 'archived_at DESC,' : ''}
        CASE WHEN status = 'active' THEN 0 WHEN status = 'draft' THEN 1 ELSE 2 END,
        created_at DESC
    `);
    /* 보관함으로 넘어간 건수 — 목록에서 빠진 공고가 몇 건인지 화면이 말해야 한다
       (조용히 사라지면 "공고가 없어졌다"가 된다). 실패는 null = 표시 안 함. */
    let _archivedCount = null;
    try {
      const { rows: ac } = await pool.query('SELECT COUNT(*) AS n FROM recruit_campaigns WHERE archived_at IS NOT NULL');
      _archivedCount = Number(ac[0] && ac[0].n) || 0;
    } catch (e) { logger.warn(`[campaign] admin/list 보관 건수 조회 실패(표기 생략): ${e.message}`); }
    const partIds = rows.filter(r => r.participation_mode).map(r => r.id);
    // 실패해도 목록 자체는 떠야 한다(관리 기능 마비 방지) — 집계만 비우고 진행.
    // carrySumMap: null = 반영 합계 모름(조회 실패) → 잔량도 null(부풀린 칩 금지 — 코드리뷰 M3)
    let countsMap = new Map(), schedMap = null, lateMap = new Map(), roundsMap = new Map(), carrySumMap = null, blogPendingMap = new Map();
    try {
      const { fetchRoundsSummary, fetchCarryAppliedSums } = require('../services/campaignPlan.service');
      [countsMap, schedMap, lateMap, roundsMap, carrySumMap, blogPendingMap] = await Promise.all([
        fetchCampaignCounts(pool, partIds, now),
        deriveSchedules(pool, tabsOfCampaigns(rows), now),
        _fetchLateCounts(pool, partIds),
        fetchRoundsSummary(pool, partIds),   // 095: 카드 차수 칩 재료(자체 fail-soft = 빈 Map)
        fetchCarryAppliedSums(pool, partIds), // 098: 이월 반영 누적(보류 잔량 차감분, 자체 fail-soft)
        _fetchBlogPendingCounts(pool, partIds), // 127: 카드 관제 버튼 승인 대기 배지 재료
      ]);
    } catch (e) {
      logger.warn(`[campaign] admin/list 집계 실패 — 목록만 반환: ${e.message}`);
    }
    // ★ 표 기준 참여현황(사용자 확정 2026-08-10, B안) — 카드 게이지의 오늘 숫자.
    //   작업보드 툴바와 **같은 함수**를 쓴다(사본을 두면 "카드는 27, 툴바는 8"이 다시 생긴다).
    //   ★ 실패는 null 로 남긴다 — 0 으로 접으면 "오늘 아무도 안 들어왔다"는 거짓 신호가 된다.
    let _filled = null;
    try {
      const { todayFilledMap, KEY: _fKey } = require('../services/tabFilled.service');
      const _fr = await todayFilledMap(pool, rows
        .filter(r => r.participation_mode && r.linked_sheet_id && r.linked_tab_name)
        .map(r => ({ sheetId: r.linked_sheet_id, tabName: r.linked_tab_name })), now);
      if (_fr.ok) _filled = { map: _fr.map, key: _fKey };
    } catch (e) {
      logger.warn(`[campaign] admin/list 표 기준 집계 실패 — 종전(공고 기준) 표기로 폴백: ${e.message}`);
    }
    /* ★ 130: 보관 **제안** 재료 — 연결 작업표의 모든 줄이 채워졌는가(사용자 확정 조건).
       자동 보관은 하지 않는다. 화면이 배지로 제안하고 실행은 사람이 누른다.
       ★ null = 판정 실패 → 제안 없음(0/0 을 "다 찼다"로 읽지 않는다). */
    let _archiveSuggest = null;
    try {
      const { archiveSuggestions } = require('../services/campaignArchive.service');
      _archiveSuggest = await archiveSuggestions(pool, rows);
    } catch (e) { logger.warn(`[campaign] admin/list 보관 제안 실패(제안 없이 계속): ${e.message}`); }

    const { isCarryHold, heldCarry, kstTodayStr } = require('../services/campaignState.service');
    const _todayStr = kstTodayStr(now);
    const displayTotals = new Map();
    await Promise.all(rows.filter(r => Number(r.recruit_total) <= 0).map(async r => {
      try { displayTotals.set(r.id, await displayRecruitTotalForCampaign(r)); }
      catch (e) { logger.warn(`[campaign] admin/list 작업오더 모집인원 표시 대체 실패 camp=${r.id}: ${e.message}`); }
    }));
    /* ★★ 유입방식 폴백 재료 — 카드 칩이 리뷰어 화면(work-detail)과 **같은 값**을 보게 한다.
       종전엔 카드만 저장값(work_detail.inflowType)만 봐서, 값이 없는 옛 공고가 카드에서는
       '링크유입'인데 리뷰어 화면에서는 가이드유입으로 갈렸다.
       ★ **배치 1회**(N+1 금지) · 저장값이 없는 공고만 대상 · 실패 = 미부착 = 종전 동작(fail-soft).
       ★ `work_detail` 을 고쳐 내려보내지 않는다 — 별도 필드로만 준다(저장 시 굳지 않게). */
    const inflowFallback = new Map();
    try {
      const need = rows.filter(r => !_savedInflowType(r.work_detail)).map(r => r.id);
      if (need.length) {
        const { linkedWorkOrdersForCampaigns } = require('../services/linkedRecruitQuota.service');
        const m = await linkedWorkOrdersForCampaigns(pool, need, ['inflow_type']);
        for (const [cid, wo] of m) {
          const v = String((wo && wo.inflow_type) || '');
          if (v === 'guide' || v === 'link') inflowFallback.set(cid, v);
        }
      }
    } catch (e) {
      logger.warn(`[campaign] admin/list 유입방식 폴백 실패(칩 없이 계속): ${e.message}`);
    }
    const data = rows.map(r => {
      const displayTotal = displayTotals.get(r.id) || { total: Number(r.recruit_total) || 0, source: 'campaign' };
      const _sug = _archiveSuggest ? (_archiveSuggest.get(r.id) || null) : null;
      // archiveSuggest: {total, filled, full} — full=true 일 때만 화면이 [📦 보관 제안] 배지를 그린다.
      const _oif = inflowFallback.get(r.id) || null;
      if (!r.participation_mode) return { ...r, display_recruit_total: displayTotal.total, display_recruit_total_source: displayTotal.source, archiveSuggest: _sug, orderInflowType: _oif };
      const cnt = countsMap.get(r.id) || {
        activeHolds: 0, todayActiveHolds: 0, submittedAll: 0, todaySubmitted: 0, submittedBeforeToday: 0,
      };
      const _sch = schedMap ? scheduleFor(schedMap, r) : null;
      const st = computeCampaignState(r, cnt, now, _sch);
      /* ★ 주말 미게시(104)는 관리자 카드에도 그대로 보여준다 — 종전에는 공개 목록에만 적용돼
         토요일 관리자 카드가 "오늘 모집 0/30 · 모집중"으로 보였다(리뷰어는 신청 불가인데).
         카드 렌더러의 weekend 분기(_zeroQuotaNote·footer)가 이미 이 값을 기다리고 있었다. */
      const _weekend = weekendPublicationState(r, now);
      const _resume = _weekendResume(r, _weekend, cnt, now, _sch);
      return {
        ...r,
        archiveSuggest: _sug,
        // 카드 유입방식 칩 폴백(표시 전용) — 저장값이 없을 때만 채워진다.
        orderInflowType: _oif,
        // 카드 표기 전용 값. recruit_total 원본은 참여 제한/기존 정책을 위해 그대로 둔다.
        display_recruit_total: displayTotal.total,
        display_recruit_total_source: displayTotal.source,
        state: _weekend.blocked ? 'weekend_unpublished' : st.state,
        stateReason: _weekend.blocked ? _weekend.reason : (st.stateReason || null),
        stateMessage: _weekend.blocked ? _weekend.message : null,
        resumesOn: _resume ? _resume.date : _weekend.resumesOn,
        resumesAt: _resume ? _resume.iso : null,
        // 표(주문 원장) 기준 총량(2단계) — null = 집계 불가/연결 없음(카드는 표 기준 문구를 그리지 않는다)
        tableQuota: st.tableQuota || null,
        todayCount: st.todayCount, dailyQuota: st.dailyQuota,
        // 표 기준 오늘 참여 인원(B안) — null = 셀 수 없음(연결 탭 없음·조회 실패).
        //   화면은 이 값이 있으면 이것을 쓰고, 없으면 종전 todayCount 로 폴백하며 그 사실을 말한다.
        todayFilled: (_filled && r.linked_sheet_id && r.linked_tab_name)
          ? (_filled.map.has(_filled.key(r.linked_sheet_id, r.linked_tab_name))
            ? _filled.map.get(_filled.key(r.linked_sheet_id, r.linked_tab_name)) : null)
          : null,
        carryAdded: st.carryAdded || 0,   // 066: 전일 미달분 이월로 오늘 더 열린 수(관리자 표시용)
        // 095: 오늘 명시 조절값(카드 "조절" 칩) + 차수 요약(카드 "1차 200/200 · 2차 12/100" 칩)
        todayPlanned: st.todayPlanned != null ? st.todayPlanned : null,
        planAdjusted: st.planAdjusted === true,
        // 그날의 "평소 인원"(시트 공고 = 시트 행 수 / 그 외 = 일건수) — 카드 툴팁이 daily_limit 을
        // 기본이라고 말하면 시트 일정 공고에서 거짓말이 된다(코드리뷰 #5).
        todayBaseline: st.todayBaseline != null ? st.todayBaseline : null,
        rounds: roundsMap.get(r.id) || null,
        // 098: 이월 보류 — 카드 ⏸ 칩 재료. carryHeld null = 계산 불가(칩 미표시 — 0으로 위장 금지).
        //   반영 합계를 모르면(carrySumMap null) 잔량도 모름 — 이미 반영한 인원까지 다시 세면
        //   부풀린 칩이 원클릭 이중 반영을 유도한다(코드리뷰 M3).
        carryMode: isCarryHold(r) ? 'hold' : 'auto',
        //   ★ 시트 일정 공고는 heldCarry 가 null 을 돌려준다(보류 미적용 — 효과 없는 칩 금지).
        carryHeld: carrySumMap === null ? null : heldCarry(r, cnt, _todayStr, carrySumMap.get(r.id) || 0, _sch),
        opensAt: st.opensAt, closesAt: st.closesAt, cutoffAt: st.cutoffAt,
        allDay: st.allDay === true,
        startDate: st.startDate || null,
        endDate: st.endDate || null,
        nextWorkDate: st.nextWorkDate || null,
        reopensAt: st.reopensAt || null,
        ops: {
          holdNow: cnt.activeHolds,
          todayHold: cnt.todayActiveHolds,
          todaySubmitted: cnt.todaySubmitted,
          totalConfirmed: cnt.submittedAll,
          late: lateMap.get(r.id) || 0,
          blogPending: blogPendingMap.get(r.id) || 0,   // 127: 승인 대기(블로그) — 카드 관제 배지
        },
      };
    });
    res.json({ ok: true, data, serverNow: now.toISOString(), archivedView: _archivedView, archivedCount: _archivedCount });
  } catch (err) {
    next(err);
  }
});

/* POST /api/campaign/admin/:id/archive {archived:true|false} — 보관/보관 해제 (130)
   ★ 게이트는 adminOrMaster(정원·총량 변경과 같은 급 — 남의 업체 공고를 치울 수 있다).
   ★ 스코프 토큰(via:'reviewer_campaign')은 PUT /api/campaign/admin/:id 끝앵커로만 허용되므로
     이 POST 에 도달 불가(노출 권한 상승 차단 — flags 와 같은 규율). */
router.post('/admin/:id/archive', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const want = (req.body || {}).archived;
    if (typeof want !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'archived(true|false)를 명시하세요.' });
    }
    const svc = require('../services/campaignArchive.service');
    const by = (req.admin && req.admin.name) || null;
    const out = want ? await svc.archiveCampaign(pool, id, by) : await svc.unarchiveCampaign(pool, id);
    // ★ /list 5초 캐시 즉시 무효화 — 보관하자마자 리뷰어 목록에서 빠지게(flags 와 같은 처리).
    if (out.ok) _listCache = { at: 0, rows: null, countsMap: null, feeMap: null };
    if (!out.ok) {
      // 검증 실패는 400대로 — errorHandler 500 마스킹이면 담당자가 무엇을 고칠지 모른다.
      return res.status(out.code === 'not_found' ? 404 : 409).json(out);
    }
    res.json(out);
  } catch (err) {
    if (err && err.code === '42703') {
      logger.error(`[campaign] archived_at 컬럼 없음(migration 130 미적용): ${err.message}`);
      return res.status(503).json({ ok: false, code: 'not_ready', error: '보관 기능이 아직 준비되지 않았습니다(migration 130 미적용) — 관리자에게 알려주세요.' });
    }
    next(err);
  }
});

// POST /api/campaign/admin/:id/flags {popular} — 인기상품 ON/OFF.
//   과거 별표 우선노출 데이터(pinned_at)는 보존하되 더 이상 정렬·UI·API에서 사용하지 않는다.
//   ★ 스코프 토큰(via:'reviewer_campaign')은 authMiddleware가 PUT /api/campaign/admin/:id 끝앵커로만
//     허용하므로 이 POST에는 도달 불가(약한 신원의 노출순서·게이트 조작 차단).
router.post('/admin/:id/flags', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    if (b.popular === undefined) {
      return res.status(400).json({ ok: false, error: 'popular 값이 필요합니다.' });
    }
    const client = await pool.connect();
    let rows;
    try {
      await client.query('BEGIN');
      ({ rows } = await client.query(
        `UPDATE recruit_campaigns SET
           is_popular = $2::boolean,
           updated_at = NOW()
         WHERE id = $1
         RETURNING id, is_popular`,
        [id, b.popular === true]));
      if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' }); }

      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw e;
    } finally { client.release(); }
    // ★ /list 5초 캐시 즉시 무효화 — 토글 직후 인기 배지·참여 게이트 안내가 즉시 바뀌게.
    _listCache = { at: 0, rows: null, countsMap: null, feeMap: null };
    res.json({ ok: true, isPopular: rows[0].is_popular });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaign/admin/create — 캠페인 생성
router.post('/admin/create', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const {
      title, channel, channel_custom, manager, time_range,
      delivery_type, review_fee, badges, notes, chat_url,
      status, sort_order, max_slots, deadline, description,
      linked_sheet_id, linked_tab_name, linked_tab_gid, linked_tab_mode,
      // ★ M2 변경②: 참여형 발행 필드
      participation_mode, thumbnail_url, landing_url, daily_limit, recruit_total,
      window_start, window_end, close_buffer_min, hold_ttl_min, work_detail, source_work_order_id,
      start_date, // ★ 062: 시작일(YYYY-MM-DD) — 시작일 전 게시 시 오픈예정 카운트다운
      multi_account_mode, multi_daily_limit, sub_hold_ttl_min, // ★ 063: 타계정 추가참여(§09-1·5·2)
      options, // ★ 061: 상품옵션 목록(참여형)
      fee_schedules, // ★ 082: 기간별 리뷰비 구간(배열 전달 시에만 저장, 미전달=변경 없음)
      reviewer_hidden, // ★ 085: 리뷰어 미노출(비공개/테스트 공고) — 목록에서만 숨김, 참여는 정상
      transfer_bank, transfer_memo, // ★ 086: 입금 이체은행(kbank|hana, 빈 값=자동)·받는분 통장표시
      review_type, review_type_mix, // 혼합 시 유형별 수량을 함께 저장(합계=총인원)
      carry_mode, // ★ 098: 이월 반영 방식 — 발행 시 세그먼트 선택이 조용히 'auto'로 떨어지지 않게(코드리뷰 M1)
      work_kind, // ★ 099: 체험단 종류(review|blog) — 빈 값=리뷰체험단(기존 동작). 블로그면 리뷰타입 미사용
      cash_receipt_required, // 모집공고 직접 설정 — 무시트 공고도 구매 안내·배지에 반영
      // ★ 135: 회수·혼합 부속정보. 배송유형이 그 기본형일 때만 저장하고, 아니면 비운다
      //   (작업오더 접수의 _deliveryMixJson·_recallFields 와 같은 규율 — 유형을 바꾸면
      //    옛 조합이 남아 작업표가 유령 배분을 돈다).
      delivery_type_mix, recall_courier, recall_product,
    } = req.body;

    const requestedSkipWeekends = req.body.skip_weekends === true;
    if (!title || !title.trim()) {
      return res.status(400).json({ ok: false, error: '공고 제목을 입력해주세요.' });
    }
    if (start_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(start_date))) {
      return res.status(400).json({ ok: false, error: '시작일 형식이 올바르지 않습니다. (YYYY-MM-DD)' });
    }
    const normalizedReviewType = normalizeReviewType(review_type);
    const reviewMixState = normalizeReviewTypeMix(review_type_mix);
    const reviewMixError = validateReviewTypeMix(normalizedReviewType, reviewMixState, recruit_total, { requireWhenMixed: true });
    if (reviewMixError) return res.status(400).json({ ok: false, error: reviewMixError });
    // ★ 135: 배송 부속정보 — 리뷰 혼합과 같은 모양(합계 = 총 건수).
    const deliveryBase = deliveryBaseType(delivery_type);
    const deliveryMixState = normalizeDeliveryTypeMix(delivery_type_mix);
    const deliveryMixError = validateDeliveryTypeMix(deliveryBase, deliveryMixState, recruit_total, { requireWhenMixed: true });
    if (deliveryMixError) return res.status(400).json({ ok: false, error: deliveryMixError });
    // ★ 기본형이 아니면 비운다 — "혼합으로 저장했다가 실배송으로 바꾼" 공고에 옛 조합이 남으면
    //   작업표 열 보장이 있지도 않은 배분을 돌린다(order.routes 와 같은 규율).
    const storeDeliveryMix = deliveryBase === '혼합' ? (deliveryMixState.mix || []) : [];
    const storeRecallCourier = deliveryBase === '회수' ? String(recall_courier || '').trim() : '';
    const storeRecallProduct = deliveryBase === '회수' ? String(recall_product || '').trim() : '';
    const normOpts = _normalizeOptionsInput(options);
    if (normalizedReviewType !== 'mixed' && normOpts) normOpts.forEach(option => { option.reviewTypeMix = []; });
    const optionReviewMixError = validateOptionReviewTypeMix(normalizedReviewType, normOpts);
    if (optionReviewMixError) return res.status(400).json({ ok: false, error: optionReviewMixError });
    const normalizedBadges = normalizeRecruitBadges(badges, {
      cashReceiptRequired: cash_receipt_required === true,
      channel: channel || '',
      reviewType: normalizedReviewType || '',
      reviewTypeMix: reviewMixState.mix || [],
    });

    // ★ 연결 탭 자동 보정 — 폼에서 못 골랐어도 작업오더의 작업시트탭으로 채운다(빈 값일 때만).
    //   게이트 판정 **전에** 채워야 "탭 미연결"로 게시가 막히는 것을 실제로 막을 수 있다.
    const intentionallyUnlinked = linked_tab_mode === 'unlinked';
    let lSheet = intentionallyUnlinked ? '' : linked_sheet_id;
    let lTab = intentionallyUnlinked ? '' : linked_tab_name;
    let lGid = intentionallyUnlinked ? '' : linked_tab_gid;
    const sourceWorkOrder = await _linkedTabFromWorkOrder(source_work_order_id);
    if (!intentionallyUnlinked && (!lSheet || !lTab)) {
      const wo = sourceWorkOrder;
      if (wo) {
        lSheet = lSheet || wo.sheetId; lTab = lTab || wo.tabName; lGid = lGid || wo.tabGid;
        logger.info(`[campaign] 연결탭 자동 보정(생성): wo=${source_work_order_id} → ${wo.tabName}`);
      }
    }
    const effectiveSkipWeekends = sourceWorkOrder
      ? sourceWorkOrder.skipWeekends
      : requestedSkipWeekends;

    /* ★ 127: 블로그 공고의 일건수 정규화 — 블로그는 '그날 정원' 개념이 없다(구매일 미정·승인제).
       일건수가 비면 총모집(무제한이면 9999)으로 채워 활성화 게이트·상태엔진(daily_done 판정)이
       블로그 모집을 조용히 막지 않게 한다. **상태엔진은 무수정**(가장 위험한 경로 무접촉) —
       daily=총원이면 일일 마감이 총원 마감보다 먼저 올 수 없어 리뷰 규칙 위에서 안전하다. */
    let effDailyLimit = Number(daily_limit) || 0;
    if (isBlogKind(workKindForStore(work_kind)) && effDailyLimit <= 0) {
      effDailyLimit = (Number(recruit_total) || 0) > 0 ? Number(recruit_total) : 9999;
    }

    // 참여형을 active로 "생성"하는 것도 활성화 게이트 통과 필요(status 라우트 우회 방지)
    if (participation_mode && (status === 'active')) {
      const errs = _participationActivationErrors({
        linked_sheet_id: lSheet, linked_tab_name: lTab, linked_tab_gid: lGid, window_start, window_end, daily_limit: effDailyLimit,
      });
      if (errs.length) return res.status(400).json({ ok: false, error: '참여형 활성화 불가: ' + errs.join(', ') });
    }

    const { rows } = await pool.query(
      `INSERT INTO recruit_campaigns
       (id, title, channel, channel_custom, manager, time_range, delivery_type,
        review_fee, badges, notes, chat_url, status, sort_order,
        max_slots, deadline, description, linked_sheet_id, linked_tab_name, linked_tab_gid,
        created_by,
        participation_mode, thumbnail_url, landing_url, daily_limit, recruit_total,
        window_start, window_end, close_buffer_min, hold_ttl_min, work_detail, source_work_order_id,
        start_date, multi_account_mode, multi_daily_limit, sub_hold_ttl_min, reviewer_hidden,
        transfer_bank, transfer_memo, review_type, review_type_mix, carry_mode, work_kind, skip_weekends, cash_receipt_required,
        delivery_type_mix, recall_courier, recall_product)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,
               $45,$46,$47)
       RETURNING *`,
      [
        _genCampaignId(),
        title.trim(),
        channel || '',
        channel_custom || '',
        manager || '',
        time_range || '',
        delivery_type || '',
        review_fee || 0,
        JSON.stringify(normalizedBadges),
        notes || '',
        chat_url || '',
        status || 'draft',
        sort_order || 0,
        max_slots || 0,
        deadline || null,
        description || '',
        lSheet || '',
        lTab || '',
        lGid || '',
        req.admin?.name || '',
        participation_mode === true,
        thumbnail_url || '',
        landing_url || '',
        effDailyLimit,
        Number(recruit_total) || 0,
        window_start || null,
        window_end || null,
        Number.isFinite(Number(close_buffer_min)) && close_buffer_min !== null && close_buffer_min !== undefined && close_buffer_min !== '' ? Number(close_buffer_min) : 10,
        Number.isFinite(Number(hold_ttl_min)) && hold_ttl_min !== null && hold_ttl_min !== undefined && hold_ttl_min !== '' ? Number(hold_ttl_min) : 30,
        _prepWorkDetail(work_detail) ?? null,
        source_work_order_id || '',
        start_date || null,
        multi_account_mode === true,                            // ★ 063 §09-1: 기본 [불가]
        Math.max(0, Number(multi_daily_limit) || 0),            // ★ 063 §09-5: 0=무제한
        (sub_hold_ttl_min === undefined || sub_hold_ttl_min === null || sub_hold_ttl_min === '')
          ? 15 : Math.max(1, Number(sub_hold_ttl_min) || 15),   // ★ 063 §09-2: 타계정 15분(133, ≥1 클램프 — 0=즉시만료 footgun 차단)
        reviewer_hidden === true,                               // ★ 085: 기본 FALSE(공개) — 명시로만 숨김
        _normTransferBank(transfer_bank),                       // ★ 086: 빈 값=NULL(작업오더 물건비에서 자동 판정)
        (transfer_memo === undefined || transfer_memo === null) ? null : String(transfer_memo).trim(), // ★ 086
        normalizedReviewType,                                   // ★ 087: 판정 불가·미전송=NULL(기존 동작)
        JSON.stringify(normalizedReviewType === 'mixed' ? (reviewMixState.mix || []) : []),
        carry_mode === 'hold' ? 'hold' : 'auto',                // ★ 098: auto/hold 만 — 그 외 전부 기본 auto(현행)
        workKindForStore(work_kind),                            // ★ 099: 체험단 종류. 미전송=''(=리뷰)로 저장 — 기존 동작 불변
        effectiveSkipWeekends,
        cash_receipt_required === true,
        JSON.stringify(storeDeliveryMix),                       // ★ 135: 혼합이 아니면 [] (유형 전환 시 옛 조합 잔류 차단)
        storeRecallCourier,                                     // ★ 135: 회수가 아니면 '' — NOT NULL 컬럼이라 null 금지
        storeRecallProduct,
      ]
    );
    // ★ 061: 상품옵션 저장(제공 시). 원자 저장(캠페인 락) — 실패 시 응답에 경고 표면화(조용한 정원 오염 방지, 레드 #7).
    let optionsWarning = null;
    if (normOpts) { try { await _saveCampaignOptions(rows[0].id, normOpts); } catch (e) { optionsWarning = '옵션 저장 실패: ' + e.message; logger.warn('[campaign/create] ' + optionsWarning); } }
    if (normOpts) await _ensureLinkedWorktableOptionColumn(rows[0].id, 'create');   // 옵션 2종+ → 연결 작업표에 옵션 칸 보장(fail-soft)
    if (normOpts) await _ensureLinkedWorktableProductColumn(rows[0].id, 'create');  // ★ 138: 상품 2종+ → 「상품」 칸 보장·소급(fail-soft)
    await _ensureLinkedWorktableDeliveryColumns(rows[0].id, 'create');   // ★ 135: 회수·혼합 → 연결 작업표에 부속 열 보장(fail-soft)
    // 작업오더와 모집공고는 별도 값이 아니라 같은 목표 인원이다. 생성 시에도 서버가
    // 역방향 링크와 작업오더 정원을 함께 저장해, 프론트 후속 호출 실패로 드리프트하지 않게 한다.
    let quotaSync = null;
    try { quotaSync = await syncCampaignRecruitTotal({ campaignId: rows[0].id, recruitTotal: rows[0].recruit_total }); }
    catch (e) { logger.error('[campaign/create] 작업오더 정원 동기화 실패: ' + e.message); throw e; }
    // ★ 082: 기간별 리뷰비 구간 저장(제공 시). 실패해도 공고 생성은 유지하고 경고만 표면화한다 —
    //   조용히 삼키면 "저장했는데 구간이 없다"가 되고, throw 하면 멀쩡한 공고 발행이 통째로 막힌다.
    const normFees = normalizeFeeSchedules(fee_schedules);
    let feeWarning = null;
    if (normFees) { try { await _saveFeeSchedules(rows[0].id, normFees); } catch (e) { feeWarning = '리뷰비 구간 저장 실패: ' + e.message; logger.warn('[campaign/create] ' + feeWarning); } }
    /* ★★ D3-a(탈 구글시트 W2-b): 연결 탭이 **무시트**면 작업표의 날짜 분배를 달력에 프리필한다.
       무시트 작업은 시트 일정 파생 대상이 아니므로(달력이 진실원본), 이게 없으면 그날 정원이
       발행폼 `daily_limit` 하나로만 돌아가 작업표 계획과 어긋난다.
       ★ 이미 있는 날짜는 덮지 않고(사람이 조절해 둔 값 보존) 지난 날짜는 넣지 않는다.
       ★ fail-soft — 실패해도 공고 발행은 성공(달력은 [📅 인원] 모달에서 채울 수 있다). */
    let planPrefill = null;
    if (participation_mode === true && lSheet && lTab) {
      try {
        const isSl = await require('../utils/sheetlessScope').isSheetless(pool, lSheet, lTab);
        if (isSl) {
          planPrefill = await require('../services/sheetlessDailyPlan.service').prefillFromWorktable({
            campaignId: rows[0].id, sheetId: lSheet, tabName: lTab, by: req.admin?.name || 'admin' });
        }
      } catch (e) {
        planPrefill = { ok: false, reason: 'exception', message: e.message };
        logger.warn('[campaign/create] 달력 프리필 실패(공고는 발행됨): ' + e.message);
      }
    }
    res.json({ ok: true, data: rows[0], options: await _loadOptionsRaw(pool, rows[0].id),
      feeSchedules: await _loadFeeSchedules(pool, rows[0].id),
      ...(optionsWarning ? { optionsWarning } : {}), ...(feeWarning ? { feeWarning } : {}),
      ...(quotaSync ? { quotaSync } : {}),
      ...(planPrefill ? { planPrefill } : {}) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/campaign/admin/:id — 캠페인 수정
router.put('/admin/:id', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    // ★ 리뷰어앱 공고수정 스코프 토큰은 전용 화이트리스트 핸들러로 격리(레드팀 #2/#3/#6)
    //   ★ 옵션(정원·금액) 편집도 이 조기 반환으로 차단됨 — _scopedCampaignEdit는 options를 읽지 않는다
    //     (레드 #4 검토: 약한 신원 리뷰어앱 토큰이 옵션 정원/지급액을 변조하는 파괴표면 차단).
    if (req.admin && req.admin.via === 'reviewer_campaign') {
      return await _scopedCampaignEdit(req, res);
    }
    const { id } = req.params;
    const {
      title, channel, channel_custom, manager, time_range,
      delivery_type, review_fee, badges, notes, chat_url,
      status, sort_order, max_slots, deadline, description,
      linked_sheet_id, linked_tab_name, linked_tab_gid, linked_tab_mode,
      // ★ M2 변경②: 참여형 발행 필드(전부 optional — 미전달 시 기존값 유지)
      participation_mode, thumbnail_url, landing_url, daily_limit, recruit_total,
      window_start, window_end, close_buffer_min, hold_ttl_min, work_detail, source_work_order_id,
      start_date, // ★ 062: undefined/null=유지, ''=시작일 제거, 'YYYY-MM-DD'=설정
      // ★ 063: 타계정 추가참여(전부 optional — 미전달 시 COALESCE로 기존값 유지).
      //   ※ 아래 UPDATE의 $33~$35가 이 이름들을 참조하므로 구조분해 누락 = 수정 저장 전면 ReferenceError(500).
      multi_account_mode, multi_daily_limit, sub_hold_ttl_min,
      options, // ★ 061: 상품옵션 목록(배열 전달 시에만 교체, 미전달=변경 없음)
      fee_schedules, // ★ 082: 기간별 리뷰비 구간(배열 전달 시에만 교체, 미전달=변경 없음)
      reviewer_hidden, // ★ 085: 리뷰어 미노출(비공개/테스트) — undefined=유지, true/false=명시 변경
      transfer_bank, transfer_memo, // ★ 086: undefined=유지 / ''=자동으로 되돌림
      review_type, review_type_mix, // undefined=유지 / mixed면 유형별 수량을 함께 갱신
      work_kind,   // ★ 099: undefined=유지 / ''=해제
      carry_mode, // ★ 098: 이월 반영 방식 'auto'|'hold' — undefined=유지
      cash_receipt_required, // undefined=유지 / true·false=모집공고 직접 설정
      skip_weekends, // undefined=유지 / true·false=주말 게시 직접 설정
      // ★ 135: 회수·혼합 부속정보 — undefined=유지(부속 칸 없는 화면이 저장해도 안 지워진다).
      delivery_type_mix, recall_courier, recall_product,
    } = req.body;

    if (start_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(start_date))) {
      return res.status(400).json({ ok: false, error: '시작일 형식이 올바르지 않습니다. (YYYY-MM-DD)' });
    }

    // ★ 062: 시간창 유효값 — ''=비움(자율주문 전환), null/undefined=유지, 'HH:MM'=설정.
    //   auto_order=true(카드 인라인 편집기)는 강제 비움 — 종전엔 스코프 라우트만 해석해
    //   관리자 토큰의 인라인 자율주문 전환이 조용히 무시되던 갭 봉합.
    const _wsEff = (req.body.auto_order === true) ? '' : window_start;
    const _weEff = (req.body.auto_order === true) ? '' : window_end;

    // 혼합 구성은 총인원과 함께 원자적으로 검증한다. 클라이언트가 오래되었거나 우회 호출돼도
    // '포토 10 + 텍스트 3 / 총 15명' 같은 불일치 공고가 저장되지 않는다.
    let reviewMixForStore = null;
    let reviewMixCurrent = null;
    let effectiveReviewTypeForOptions = null;
    let normOpts = _normalizeOptionsInput(options);
    if (review_type !== undefined || review_type_mix !== undefined || recruit_total !== undefined) {
      const { rows: currentReviewRows } = await pool.query(
        'SELECT review_type, review_type_mix, recruit_total FROM recruit_campaigns WHERE id = $1', [id]
      );
      const currentReview = currentReviewRows[0];
      if (!currentReview) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
      const effectiveReviewType = review_type === undefined || review_type === null
        ? (normalizeReviewType(currentReview.review_type) || '')
        : (normalizeReviewType(review_type) || '');
      effectiveReviewTypeForOptions = effectiveReviewType;
      const reviewMixState = normalizeReviewTypeMix(
        review_type_mix === undefined ? currentReview.review_type_mix : review_type_mix
      );
      const effectiveRecruitTotal = (recruit_total === undefined || recruit_total === null || recruit_total === '')
        ? currentReview.recruit_total
        : recruit_total;
      const reviewMixError = validateReviewTypeMix(effectiveReviewType, reviewMixState, effectiveRecruitTotal, {
        requireWhenMixed: review_type !== undefined || recruit_total !== undefined,
      });
      if (reviewMixError) return res.status(400).json({ ok: false, error: reviewMixError });
      // 타입을 단일/미지정으로 바꾸면 남아 있던 혼합 조합을 함께 지운다.
      if (effectiveReviewType !== 'mixed') reviewMixForStore = [];
      else if (reviewMixState.provided) reviewMixForStore = reviewMixState.mix;
      reviewMixCurrent = { reviewType: effectiveReviewType, reviewTypeMix: reviewMixState.mix || [] };
    }

    /* ★ 135: 배송 부속정보 — 리뷰 혼합과 **같은 모양**(현재값 병합 → 검증 → 기본형 아니면 비움).
       null 을 넣으면 아래 CASE 센티널이 "유지"로 읽는다(미전송 = 변경 없음). */
    let deliveryMixForStore = null;
    let recallCourierForStore = null;
    let recallProductForStore = null;
    if (delivery_type !== undefined || delivery_type_mix !== undefined
        || recall_courier !== undefined || recall_product !== undefined || recruit_total !== undefined) {
      const { rows: curDvRows } = await pool.query(
        `SELECT delivery_type, delivery_type_mix, recall_courier, recall_product, recruit_total
           FROM recruit_campaigns WHERE id = $1`, [id]
      );
      const curDv = curDvRows[0];
      if (!curDv) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
      const effDeliveryBase = deliveryBaseType(
        (delivery_type === undefined || delivery_type === null) ? curDv.delivery_type : delivery_type
      );
      const dvMixState = normalizeDeliveryTypeMix(
        delivery_type_mix === undefined ? curDv.delivery_type_mix : delivery_type_mix
      );
      const effTotal = (recruit_total === undefined || recruit_total === null || recruit_total === '')
        ? curDv.recruit_total
        : recruit_total;
      const dvMixError = validateDeliveryTypeMix(effDeliveryBase, dvMixState, effTotal, {
        requireWhenMixed: delivery_type !== undefined || recruit_total !== undefined,
      });
      if (dvMixError) return res.status(400).json({ ok: false, error: dvMixError });
      // ★ 기본형을 벗어나면 남아 있던 부속정보를 함께 지운다(리뷰 혼합과 같은 규율).
      if (effDeliveryBase !== '혼합') deliveryMixForStore = [];
      else if (dvMixState.provided) deliveryMixForStore = dvMixState.mix;
      if (effDeliveryBase !== '회수') { recallCourierForStore = ''; recallProductForStore = ''; }
      else {
        if (recall_courier !== undefined) recallCourierForStore = String(recall_courier || '').trim();
        if (recall_product !== undefined) recallProductForStore = String(recall_product || '').trim();
      }
    }

    if (normOpts) {
      if (effectiveReviewTypeForOptions === null) {
        const { rows: currentOptionReviewRows } = await pool.query(
          'SELECT review_type FROM recruit_campaigns WHERE id = $1', [id]
        );
        if (!currentOptionReviewRows[0]) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
        effectiveReviewTypeForOptions = normalizeReviewType(currentOptionReviewRows[0].review_type) || '';
      }
      if (effectiveReviewTypeForOptions !== 'mixed') normOpts.forEach(option => { option.reviewTypeMix = []; });
      const optionReviewMixError = validateOptionReviewTypeMix(effectiveReviewTypeForOptions, normOpts);
      if (optionReviewMixError) return res.status(400).json({ ok: false, error: optionReviewMixError });
    }

    // 자동 배지는 어떤 저장 경로에서도 같은 조건으로 계산한다. 그래서 오래된 화면이나 API 직접 호출이
    // 현영건·로켓와우·리뷰타입 배지를 수동으로 남기거나 지울 수 없다.
    let badgesForStore = null;
    if (badges !== undefined || channel !== undefined || review_type !== undefined || review_type_mix !== undefined || cash_receipt_required !== undefined) {
      const { rows: badgeRows } = await pool.query(
        'SELECT badges, channel, review_type, review_type_mix, cash_receipt_required FROM recruit_campaigns WHERE id = $1', [id]
      );
      const currentBadge = badgeRows[0];
      if (!currentBadge) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
      const effectiveReviewType = reviewMixCurrent?.reviewType
        ?? (review_type === undefined || review_type === null
          ? (normalizeReviewType(currentBadge.review_type) || '')
          : (normalizeReviewType(review_type) || ''));
      const effectiveReviewMix = reviewMixForStore
        ?? (reviewMixCurrent?.reviewTypeMix || normalizeReviewTypeMix(currentBadge.review_type_mix).mix || []);
      badgesForStore = normalizeRecruitBadges(badges === undefined ? currentBadge.badges : badges, {
        cashReceiptRequired: cash_receipt_required === undefined || cash_receipt_required === null
          ? currentBadge.cash_receipt_required === true : cash_receipt_required === true,
        channel: channel === undefined || channel === null ? currentBadge.channel : channel,
        reviewType: effectiveReviewType,
        reviewTypeMix: effectiveReviewMix,
      });
    }

    // ★ 연결 탭 자동 보정(수정) — 이미 저장된 공고가 "시트 탭 미연결"이면 작업오더 값으로 채운다.
    //   공고를 열어 저장하기만 하면 복구되는 경로(관리자가 탭을 직접 고르면 그 값이 우선).
    //   ★ 비어 있을 때만 — 본문에 값이 있거나 DB에 이미 연결돼 있으면 건드리지 않는다.
    const intentionallyUnlinked = linked_tab_mode === 'unlinked';
    let lSheet = intentionallyUnlinked ? '' : linked_sheet_id;
    let lTab = intentionallyUnlinked ? '' : linked_tab_name;
    let lGid = intentionallyUnlinked ? '' : linked_tab_gid;
    if (!intentionallyUnlinked && (!lSheet || !lTab)) {
      try {
        const { rows: cur0 } = await pool.query(
          'SELECT linked_sheet_id, linked_tab_name, linked_tab_gid, source_work_order_id FROM recruit_campaigns WHERE id = $1',
          [id]
        );
        const c0 = cur0[0];
        if (c0 && !c0.linked_sheet_id && !c0.linked_tab_name) {
          // 정방향 링크가 없으면 역방향(work_orders.linked_campaign_id)으로도 찾는다 —
          // 옛 경로로 만든 공고는 source_work_order_id 가 비어 있을 수 있다.
          let woId = source_work_order_id || c0.source_work_order_id || '';
          if (!woId) {
            const { rows: back } = await pool.query(
              `SELECT id FROM work_orders
                WHERE linked_campaign_id = $1 AND deleted_at IS NULL
                ORDER BY created_at ASC LIMIT 1`, [id]
            );
            woId = back[0]?.id || '';
          }
          const wo = await _linkedTabFromWorkOrder(woId);
          if (wo) {
            lSheet = lSheet || wo.sheetId; lTab = lTab || wo.tabName; lGid = lGid || wo.tabGid;
            logger.info(`[campaign] 연결탭 자동 보정(수정): camp=${id} → ${wo.tabName}`);
          }
        }
      } catch (e) {
        logger.warn(`[campaign] 연결탭 보정 조회 실패(무시): ${e.message}`);
      }
    }

    // ★ 참여형 활성화 게이트(심판 J7): COALESCE 편집으로 status='active' 우회 방지.
    //   이 라우트가 바꿀 수 있는 게이트 입력(연결탭·시간창·일일건수)을 본문값으로 병합해 판정.
    if (status === 'active') {
      const { rows: cur } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
      if (cur.length && (cur[0].participation_mode || participation_mode === true)) {
        const pick = (v, curV) => (v === undefined || v === null) ? curV : v;
        const eff = {
          ...cur[0],
          linked_sheet_id: intentionallyUnlinked ? '' : pick(lSheet, cur[0].linked_sheet_id),
          linked_tab_name: intentionallyUnlinked ? '' : pick(lTab, cur[0].linked_tab_name),
          linked_tab_gid: intentionallyUnlinked ? '' : pick(lGid, cur[0].linked_tab_gid),
          window_start: pick(_wsEff, cur[0].window_start),
          window_end: pick(_weEff, cur[0].window_end),
          daily_limit: pick(daily_limit, cur[0].daily_limit),
        };
        const errs = _participationActivationErrors(eff);
        if (errs.length) return res.status(400).json({ ok: false, error: '참여형 활성화 불가: ' + errs.join(', ') });
      }
    }

    const wdPrepared = _prepWorkDetail(work_detail); // undefined=유지, null=비움, 문자열=교체

    // ★ 095: 차수 원장이 있는 공고의 총모집(recruit_total)은 차수 합계가 진실원본 —
    //   수정 모달 재전송(진행상품 표 파생 hidden 값)이 차수 추가분을 조용히 되돌리지 않게
    //   여기서 무시한다(null = COALESCE 유지). 총량 변경은 [📅 인원조절]의 차수 추가/제거로만.
    //   fail-soft: 테이블 부재·조회 실패 = 잠금 없음(기존 동작).
    let _rtEff = recruit_total;
    let _rtLocked = false;   // 응답에 실어 화면이 "무시했다"를 말하게(조용한 누락 금지 — 코드리뷰 M2)
    try {
      const { roundsLockRecruitTotal } = require('../services/campaignPlan.service');
      if (await roundsLockRecruitTotal(id)) {
        _rtLocked = recruit_total !== undefined && recruit_total !== null && recruit_total !== '';
        _rtEff = null;
      }
    } catch (_) { /* 기존 동작 */ }

    /* 총인원을 줄일 때는 실제 작업보드에 이미 채워진 행도 함께 검사한다.
       이 검사를 UPDATE 앞에 두어, 저장은 실패했는데 공고 정원만 낮아지는 반쪽 상태를 막는다.

       ★★ 검사·동기화는 **총정원이 이번 저장에서 실제로 달라졌을 때만** 한다(2026-08-24 사용자 확정).
         종전에는 전송만 되면(수정 모달은 진행상품 표 파생 hidden 값을 늘 재전송한다) 같은
         값이어도 검사가 돌아, 채워진 줄이 정원보다 많은 **초과 상태 공고**에서는 제목·리뷰비만
         고쳐도 저장이 실패로 보였다(본섭 실측 13개 작업). 게다가 그 throw 는 UPDATE·옵션·리뷰비가
         모두 커밋된 **뒤**라 "저장은 됐는데 실패로 보고"였다. 초과는 감추지 않고 표시하는 것이
         확정 정책이므로(41/40), 그 상태를 "저장 불가"로 대접하지 않는다.
       ★ **줄이려는 조작은 종전대로 막는다** — 값이 달라질 때만 게이트를 건너뛰지 않는다.
       ★ 이전 값을 못 읽으면(조회 실패·행 없음) **검사하는 쪽으로 접는다**(fail-closed). */
    let _rtPrev = null;
    try {
      const { rows: prevRt } = await pool.query('SELECT recruit_total FROM recruit_campaigns WHERE id = $1', [id]);
      if (prevRt.length) _rtPrev = Number(prevRt[0].recruit_total) || 0;
    } catch (_) { _rtPrev = null; }
    const _rtSent = _rtEff !== undefined && _rtEff !== null && _rtEff !== '';
    const _rtChanged = _rtSent && (_rtPrev === null || (Number(_rtEff) || 0) !== _rtPrev);
    if (_rtChanged) {
      await assertCampaignRecruitTotal({ campaignId: id, recruitTotal: Number(_rtEff) || 0 });
    }

    const { rows } = await pool.query(
      `UPDATE recruit_campaigns SET
        title = COALESCE($2, title),
        channel = COALESCE($3, channel),
        channel_custom = COALESCE($4, channel_custom),
        manager = COALESCE($5, manager),
        time_range = COALESCE($6, time_range),
        delivery_type = COALESCE($7, delivery_type),
        review_fee = COALESCE($8, review_fee),
        badges = COALESCE($9, badges),
        notes = COALESCE($10, notes),
        chat_url = COALESCE($11, chat_url),
        status = COALESCE($12, status),
        sort_order = COALESCE($13, sort_order),
        max_slots = COALESCE($14, max_slots),
        deadline = $15,
        description = COALESCE($16, description),
        linked_sheet_id = CASE WHEN $45::boolean THEN '' ELSE COALESCE($17, linked_sheet_id) END,
        linked_tab_name = CASE WHEN $45::boolean THEN '' ELSE COALESCE($18, linked_tab_name) END,
        linked_tab_gid = CASE WHEN $45::boolean THEN '' ELSE COALESCE($19, linked_tab_gid) END,
        participation_mode = COALESCE($20, participation_mode),
        thumbnail_url = COALESCE($21, thumbnail_url),
        landing_url = COALESCE($22, landing_url),
        daily_limit = COALESCE($23, daily_limit),
        recruit_total = COALESCE($24, recruit_total),
        window_start = CASE WHEN $25::text IS NULL THEN window_start
                            WHEN $25::text = '' THEN NULL
                            ELSE $25::time END,
        window_end = CASE WHEN $26::text IS NULL THEN window_end
                          WHEN $26::text = '' THEN NULL
                          ELSE $26::time END,
        close_buffer_min = COALESCE($27, close_buffer_min),
        hold_ttl_min = COALESCE($28, hold_ttl_min),
        work_detail = CASE WHEN $29::boolean THEN $30::jsonb ELSE work_detail END,
        source_work_order_id = COALESCE($31, source_work_order_id),
        start_date = CASE WHEN $32::text IS NULL THEN start_date
                          WHEN $32::text = '' THEN NULL
                          ELSE $32::date END,
        multi_account_mode = COALESCE($33, multi_account_mode),
        multi_daily_limit = COALESCE($34, multi_daily_limit),
        sub_hold_ttl_min = COALESCE($35, sub_hold_ttl_min),
        reviewer_hidden = COALESCE($36, reviewer_hidden),   -- ★ 085: 미전달=유지(옵션표와 같은 원칙)
        -- ★ 086: 이체 설정. null=유지 / ''=자동(작업오더 물건비 판정) 로 되돌리기.
        --   시작일(start_date)과 같은 CASE 센티널 방식 — '지우기'와 '미전달'을 구분해야 한다.
        transfer_bank = CASE WHEN $37::text IS NULL THEN transfer_bank
                             WHEN $37::text = '' THEN NULL ELSE $37::text END,
        transfer_memo = CASE WHEN $38::text IS NULL THEN transfer_memo
                             WHEN $38::text = '' THEN NULL ELSE $38::text END,
        -- ★ 087: 리뷰타입. null=유지 / ''=미지정으로 되돌리기 — 위 CASE 센티널과 같은 방식.
        --   ★ 리뷰타입 UI 가 없는 화면(리뷰어앱 인라인 수정 등)은 아예 전송하지 않으므로
        --     '미전달=유지'가 곧 "옛 화면이 저장해도 값이 안 지워진다"의 보장이다(옵션표와 같은 원칙).
        review_type = CASE WHEN $39::text IS NULL THEN review_type
                           WHEN $39::text = '' THEN NULL ELSE $39::text END,
        review_type_mix = CASE WHEN $40::jsonb IS NULL THEN review_type_mix ELSE $40::jsonb END,
        carry_mode = COALESCE($41, carry_mode),
        -- ★ 099: 체험단 종류. null=유지 / ''=미지정으로 해제 — 리뷰타입과 같은 CASE 센티널.
        --   ★ 체험단 종류 UI 가 없는 화면(리뷰어앱 인라인 수정 등)이 저장해도 설정이 안 풀린다.
        work_kind = CASE WHEN $42::text IS NULL THEN work_kind ELSE $42::text END,
        skip_weekends = CASE WHEN $43::boolean IS NULL THEN skip_weekends ELSE $43::boolean END,
        cash_receipt_required = COALESCE($44::boolean, cash_receipt_required),
        -- ★ 135: 회수·혼합 부속정보. null=유지 — 부속 칸이 없는 화면(리뷰어앱 인라인 수정 등)이
        --   저장해도 값이 조용히 지워지지 않는다(리뷰 혼합·옵션표와 같은 원칙).
        --   NOT NULL 컬럼이라 '지움'은 빈 배열·빈 문자열로 표현한다.
        delivery_type_mix = CASE WHEN $46::jsonb IS NULL THEN delivery_type_mix ELSE $46::jsonb END,
        recall_courier = CASE WHEN $47::text IS NULL THEN recall_courier ELSE $47::text END,
        recall_product = CASE WHEN $48::text IS NULL THEN recall_product ELSE $48::text END,
        updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        title, channel, channel_custom, manager, time_range,
        delivery_type, review_fee || 0,
        badgesForStore === null ? null : JSON.stringify(badgesForStore),
        notes, chat_url, status, sort_order || 0,
        max_slots || 0, deadline || null, description,
        lSheet, lTab, lGid,   // ★ 자동 보정값(빈 값이면 COALESCE로 기존값 유지 — 종전과 동일)
        (participation_mode === undefined || participation_mode === null) ? null : participation_mode === true,
        thumbnail_url ?? null,
        landing_url ?? null,
        (daily_limit === undefined || daily_limit === null || daily_limit === '') ? null : Number(daily_limit) || 0,
        (_rtEff === undefined || _rtEff === null || _rtEff === '') ? null : Number(_rtEff) || 0,
        // ★ 062: ''=시간창 비움(자율주문 전환), null/undefined=유지 — 구 COALESCE는 비움 불가였음
        (_wsEff === undefined || _wsEff === null) ? null : String(_wsEff),
        (_weEff === undefined || _weEff === null) ? null : String(_weEff),
        (close_buffer_min === undefined || close_buffer_min === null || close_buffer_min === '') ? null : Number(close_buffer_min),
        (hold_ttl_min === undefined || hold_ttl_min === null || hold_ttl_min === '') ? null : Number(hold_ttl_min),
        wdPrepared !== undefined,          // $29: work_detail 교체 여부(undefined=유지)
        wdPrepared === undefined ? null : wdPrepared, // $30: 새 값(null=비움)
        source_work_order_id ?? null,
        (start_date === undefined || start_date === null) ? null : String(start_date), // $32: null=유지, ''=제거, 날짜=설정
        (multi_account_mode === undefined || multi_account_mode === null) ? null : multi_account_mode === true, // $33 ★ 063: null=유지
        (multi_daily_limit === undefined || multi_daily_limit === null || multi_daily_limit === '') ? null : Math.max(0, Number(multi_daily_limit) || 0), // $34
        (sub_hold_ttl_min === undefined || sub_hold_ttl_min === null || sub_hold_ttl_min === '') ? null : Math.max(1, Number(sub_hold_ttl_min) || 15), // $35
        (reviewer_hidden === undefined || reviewer_hidden === null) ? null : reviewer_hidden === true, // $36 ★ 085: null=유지
        (transfer_bank === undefined || transfer_bank === null) ? null : (_normTransferBank(transfer_bank) || ''), // $37 ★ 086
        (transfer_memo === undefined || transfer_memo === null) ? null : String(transfer_memo).trim(),            // $38 ★ 086
        // $39 ★ 087: undefined/null=유지. ''=미지정으로 해제. 판정 불가값도 ''(=해제) —
        //   모르는 문자열을 그대로 저장하면 화면·검수가 각자 다르게 해석한다.
        (review_type === undefined || review_type === null) ? null : (normalizeReviewType(review_type) || ''),
        // $40: undefined=유지, []=혼합 해제, 배열=검증된 유형별 수량.
        reviewMixForStore === null ? null : JSON.stringify(reviewMixForStore),
        // $41 ★ 098: 이월 반영 방식 — undefined/null/알 수 없는 값 = 유지(COALESCE), 'auto'|'hold'만 설정.
        //   세그먼트 UI 없는 화면은 아예 전송하지 않으므로 옛 화면 저장이 설정을 되돌리지 않는다.
        ['auto', 'hold'].includes(carry_mode) ? carry_mode : null,
        // $42 ★ 099: undefined/null=유지. ''=미지정으로 해제. 파정 불가값도 ''(=해제)로 접지 않고
        //   workKindForStore 가 review 로 정규화한다(모르는 문자열이 blog 로 승격되는 일 없음).
        (work_kind === undefined || work_kind === null) ? null : workKindForStore(work_kind),
        (skip_weekends === undefined || skip_weekends === null) ? null : skip_weekends === true,
        (cash_receipt_required === undefined || cash_receipt_required === null) ? null : cash_receipt_required === true,
        intentionallyUnlinked,                                   // $45
        // $46~$48 ★ 135: null=유지 / []·''=해제(기본형을 벗어나면 위에서 그렇게 정해진다).
        deliveryMixForStore === null ? null : JSON.stringify(deliveryMixForStore),
        recallCourierForStore,
        recallProductForStore,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    // ★ 061: 상품옵션 교체(배열 전달 시에만). 원자 저장(캠페인 락), 참여자 있는 옵션은 삭제 대신 closed(기록 보호).
    let optionsWarning = null;
    if (normOpts) { try { await _saveCampaignOptions(id, normOpts); } catch (e) { optionsWarning = '옵션 저장 실패: ' + e.message; logger.warn('[campaign/update] ' + optionsWarning); } }
    if (normOpts) await _ensureLinkedWorktableOptionColumn(id, 'update');   // 옵션 2종+ → 연결 작업표에 옵션 칸 보장(fail-soft)
    if (normOpts) await _ensureLinkedWorktableProductColumn(id, 'update');  // ★ 138: 상품 2종+ → 「상품」 칸 보장·소급(fail-soft)
    await _ensureLinkedWorktableDeliveryColumns(id, 'update');   // ★ 135: 회수·혼합 → 연결 작업표에 부속 열 보장(fail-soft)
    // ★ 082: 기간별 리뷰비 구간 교체(배열 전달 시에만 — 미전달=기존 구간 유지).
    //   구간표 UI 가 없는 화면(리뷰어앱 인라인 편집 등)이 저장해도 구간이 사라지지 않는다.
    const normFees = normalizeFeeSchedules(fee_schedules);
    let feeWarning = null;
    if (normFees) { try { await _saveFeeSchedules(id, normFees); } catch (e) { feeWarning = '리뷰비 구간 저장 실패: ' + e.message; logger.warn('[campaign/update] ' + feeWarning); } }
    // ★ 095(Codex P1): 잠금 검사(pool)와 UPDATE 사이에 "첫 차수 추가"가 끼면 낡은 총모집이
    //   차수 합계를 덮을 수 있다 — 총모집을 실제로 썼다면 사후 자가치유(차수 있으면 합계로 복원).
    if (_rtEff !== undefined && _rtEff !== null && _rtEff !== '') {
      try {
        const { repairRecruitTotalFromRounds } = require('../services/campaignPlan.service');
        const fixed = await repairRecruitTotalFromRounds(id);
        if (fixed !== null) { rows[0].recruit_total = fixed; _rtLocked = true; }
      } catch (_) { /* fail-soft */ }
    }
    // 차수 합계 보정까지 끝난 최종 정원을 연결 작업오더에도 즉시 반영한다.
    // 이 호출이 공고 수정 → 작업오더 동기화의 단일 진입점이다.
    let quotaSync = null;
    // ★ 정원이 안 바뀐 저장에서는 작업보드 슬롯 맞추기를 건너뛴다(위 게이트와 같은 판정).
    //   역방향 링크 백필은 그대로 수행된다. 차수 보정이 값을 바꿨을 수 있으므로 최종값으로 비교한다.
    const _rtSkipWorktable = _rtPrev !== null && (Number(rows[0].recruit_total) || 0) === _rtPrev;
    try { quotaSync = await syncCampaignRecruitTotal({ campaignId: id, recruitTotal: rows[0].recruit_total, skipWorktable: _rtSkipWorktable }); }
    catch (e) { logger.error('[campaign/update] 작업오더 정원 동기화 실패: ' + e.message); throw e; }
    res.json({ ok: true, data: rows[0], options: await _loadOptionsRaw(pool, id),
      feeSchedules: await _loadFeeSchedules(pool, id),
      ...(optionsWarning ? { optionsWarning } : {}), ...(feeWarning ? { feeWarning } : {}),
      ...(quotaSync ? { quotaSync } : {}),
      // ★ 095: 차수 공고라 총모집 전송값을 무시했음을 화면에 알린다(진행상품 표 hidden 재전송 케이스)
      ...(_rtLocked ? { recruitTotalLocked: true } : {}) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/campaign/admin/:id — 캠페인 삭제
router.delete('/admin/:id', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    /* ★★ 130: 참여 이력이 있는 공고는 삭제하지 않는다 — 보관으로 안내한다.
       이 DELETE 는 FK CASCADE 로 campaign_applications(참여 이력) · campaign_options ·
       campaign_fee_schedules(참여 시점 리뷰비 스냅샷) · campaign_rounds ·
       campaign_daily_plans · campaign_reviewer_gates 를 **함께 지우고**,
       payment_batch_items.campaign_id 는 SET NULL 로 입금 회차의 공고 연결까지 끊는다.
       → 리뷰어의 리뷰 내역·누적 금액·정산 근거가 조용히 사라진다.
       삭제는 **발행 직후 오발행분**(참여 0건)에만 남긴다. force 우회는 두지 않는다. */
    let _apps = null;
    try {
      const { rows: ac } = await pool.query(
        'SELECT COUNT(*) AS n FROM campaign_applications WHERE campaign_id = $1', [id]);
      _apps = Number(ac[0] && ac[0].n) || 0;
    } catch (e) {
      // ★ 세지 못하면 지우지 않는다(fail-closed — 모르는 채로 파괴하지 않는다).
      logger.warn(`[campaign] 삭제 전 참여 이력 조회 실패 — 삭제 보류 camp=${id}: ${e.message}`);
      return res.status(503).json({ ok: false, code: 'unknown_history',
        error: '참여 이력을 확인하지 못해 삭제를 보류했습니다. 잠시 후 다시 시도하거나 [보관]을 이용하세요.' });
    }
    if (_apps > 0) {
      return res.status(409).json({ ok: false, code: 'has_applications', count: _apps,
        error: `참여 이력이 ${_apps}건 있어 삭제할 수 없습니다 — 대신 [📦 보관]으로 목록에서 내리세요(데이터는 그대로 남고 언제든 되돌릴 수 있습니다).` });
    }
    const result = await pool.query('DELETE FROM recruit_campaigns WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    res.json({ ok: true, message: '삭제되었습니다.' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/campaign/admin/:id/status — 상태 변경 (active/closed/draft)
router.put('/admin/:id/status', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['draft', 'active', 'closed'].includes(status)) {
      return res.status(400).json({ ok: false, error: '유효하지 않은 상태입니다.' });
    }
    // ★ 참여형 활성화 게이트(레드 #6·#10): gid·시간창·일일건수 없이 발행되면
    //   상태엔진이 closed(window_invalid)로만 보여 "발행했는데 안 보임" 무신호 장애가 된다 → 선차단.
    if (status === 'active') {
      const { rows: cur } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
      if (!cur.length) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
      if (cur[0].participation_mode) {
        const errs = _participationActivationErrors(cur[0]);
        if (errs.length) return res.status(400).json({ ok: false, error: '참여형 활성화 불가: ' + errs.join(', ') });
      }
    }
    const { rows } = await pool.query(
      `UPDATE recruit_campaigns SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, status]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    }
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/admin/:id/applications — 관리자: 참여자 전체 목록
router.get('/admin/:id/applications', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    // ★ M3 리뷰 #11: hold_token(열람·취소 열쇠)은 관제에 불필요 — 브라우저로 내리지 않음(컬럼 화이트리스트)
    const { rows } = await pool.query(
      `SELECT id, campaign_id, applicant_name, applicant_phone, applicant_inad,
              status, sheet_row_added, applied_at, phone8, expires_at, submitted_at,
              order_submission_id, late_order_id, option_key, owner_phone8, dismissed_at,
              dismissed_by, blog_url, reject_reason, decided_at, decided_by
       FROM campaign_applications
       WHERE campaign_id = $1
       ORDER BY applied_at ASC`,
      [id]
    );
    // 🧩 옵션별 현황(061 3단계 관제): 옵션 뷰(정원·잔여·상태) + 금액 포함(관리자 전용)
    let options = [];
    try {
      const { rows: camps } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
      if (camps.length && camps[0].participation_mode) {
        const now = new Date();
        const _sm = await deriveSchedules(pool, tabsOfCampaigns([camps[0]]), now);
        const st = computeCampaignState(camps[0], (await fetchCampaignCounts(pool, [id], now)).get(id), now, scheduleFor(_sm, camps[0]));
        options = await _loadOptionViews(pool, id, st, now);
      }
    } catch (optErr) { logger.warn('[campaign/admin/applications] 옵션 집계 실패: ' + optErr.message); }

    // 📋 시트 대조(관제 진단) — "시트엔 100행인데 확정은 99" 같은 누락을 그 자리에서 보이게.
    //   ★ 읽기 전용·fail-soft. 상태 계산·참여 흐름에 일절 영향 없음(관제 창에서만 호출).
    let sheetInfo = null;
    try {
      const { rows: cs } = await pool.query(
        `SELECT linked_sheet_id, linked_tab_name, linked_tab_gid FROM recruit_campaigns WHERE id = $1`, [id]
      );
      const c0 = cs[0];
      if (c0 && c0.linked_sheet_id && c0.linked_tab_name) {
        // 로스터 = 인덱스에 잡힌 행(이름이 있는 행). 시트의 실제 참여자 자리 수와 같다.
        const { rows: ri } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM review_index WHERE sheet_id = $1 AND tab_name = $2`,
          [c0.linked_sheet_id, c0.linked_tab_name]
        );
        const confirmed = rows.filter(r => r.status === 'submitted').length;
        const rosterRows = Number(ri[0]?.n) || 0;
        /* ★ 차이가 있을 때만 "어느 행이 확정에 없는지"를 찾는다(평상시 쿼리 0).
           ★★ 대조는 **세 키를 모두** 본다 — 종전처럼 명의 phone8 정확일치 하나만 보면
              정상 확정이 무더기로 "미확정"으로 뜬다(실측 2026-08-19 위프 800건: 196건 중
              17건이 이 사유였고, 같은 건들이 반대편에서는 "확정인데 줄이 없음"으로 또 세어졌다).
              ㉮ 명의 `phone8`
              ㉯ 소유자 `owner_phone8` — 타계정 참여에서 **작업표 연락처 칸에 소유자 번호**가
                 적히는 정상 케이스(홀드 명의와 구매양식 연락처는 원래 다를 수 있다)
              ㉰ ★ **주문 링크** — 그 줄의 `order_submission_id` 가 확정 홀드의 것과 같으면 확정이다.
                 연락처 오타(끝 4자리 1글자 차이)·수취인 번호 기입은 번호로는 **영원히** 못 짝지어지는데,
                 주문 id 는 이름·연락처·줄 번호가 바뀌어도 불변이다(리뷰어 홈 dedup 과 같은 규율).
           ★★ 남은 미확정을 **한 덩어리로 보여주지 않는다**: 홀드 이력이 아예 없는 줄은
              "공고를 거치지 않은 제출"이라 **만료·취소 목록에 애초에 없다** — 종전 화면은 그것까지
              "[수동확정]하세요"로 안내해, 담당자가 찾을 수 없는 건을 찾게 만들었다(위프 800건에서
              196건 중 163건이 그랬다). `hasHold`/`hasOrder` 로 갈라 세고 목록도 조치 대상을 먼저 낸다.
           ★ 판정은 여전히 **관측 전용**이다 — 여기서 무엇이 나오든 캠페인 상태·정원을 바꾸지 않는다. */
        let unmatched = [];
        let unmatchedCounts = null;
        if (rosterRows > confirmed) {
          const { rows: um } = await pool.query(
            `WITH sub AS (
                SELECT phone8, owner_phone8, order_submission_id
                  FROM campaign_applications
                 WHERE campaign_id = $3 AND status = 'submitted'
              ), un AS (
                SELECT ri.row_index AS row, ri.reviewer_name AS name, ri.phone8,
                       EXISTS (
                         SELECT 1 FROM campaign_applications ca
                          WHERE ca.campaign_id = $3 AND COALESCE(ri.phone8, '') <> ''
                            AND (ca.phone8 = ri.phone8 OR ca.owner_phone8 = ri.phone8)
                       ) AS has_hold,
                       EXISTS (
                         SELECT 1 FROM order_submissions os
                          WHERE os.sheet_id = $1 AND os.tab_name = $2
                            AND COALESCE(ri.phone8, '') <> ''
                            AND right(regexp_replace(COALESCE(os.phone, ''), '\\D', '', 'g'), 8) = ri.phone8
                       ) AS has_order
                  FROM review_index ri
                 WHERE ri.sheet_id = $1 AND ri.tab_name = $2
                   AND NOT EXISTS (SELECT 1 FROM sub s WHERE s.phone8 <> '' AND s.phone8 = ri.phone8)
                   AND NOT EXISTS (SELECT 1 FROM sub s WHERE COALESCE(s.owner_phone8, '') <> '' AND s.owner_phone8 = ri.phone8)
                   AND NOT EXISTS (
                         SELECT 1 FROM campaign_participants cp
                           JOIN sub s ON s.order_submission_id = cp.order_submission_id
                          WHERE cp.sheet_id = $1 AND cp.tab_name = $2
                            AND cp.seq = ri.row_index AND cp.deleted_at IS NULL
                       )
              )
              SELECT un.*,
                     count(*) OVER ()::int AS total_cnt,
                     (count(*) FILTER (WHERE has_hold) OVER ())::int AS hold_cnt,
                     (count(*) FILTER (WHERE NOT has_hold AND has_order) OVER ())::int AS order_only_cnt
                FROM un
               ORDER BY has_hold DESC, has_order ASC, row
               LIMIT 30`,
            [c0.linked_sheet_id, c0.linked_tab_name, id]
          );
          unmatched = um.map(r => ({
            row: r.row, name: r.name || '',
            phone4: String(r.phone8 || '').replace(/\D/g, '').slice(-4),
            noPhone: !String(r.phone8 || '').trim(),
            hasHold: r.has_hold === true,
            hasOrder: r.has_order === true,
          }));
          const total = um.length ? Number(um[0].total_cnt) || 0 : 0;
          const hold = um.length ? Number(um[0].hold_cnt) || 0 : 0;
          const orderOnly = um.length ? Number(um[0].order_only_cnt) || 0 : 0;
          // ★ 세 칸의 합 ≡ total (화면이 나머지를 스스로 빼서 계산하지 않게 한다)
          unmatchedCounts = { total, hold, orderOnly, neither: Math.max(0, total - hold - orderOnly) };
        }
        /* ★ 어휘 재료 — 이 작업이 무시트(작업표)인지 시트 기반인지. 화면은 **이 값으로만**
           "시트/작업표" 어휘를 가른다(ID 모양(`wt_`)으로 추측하지 않는다 — 이관된 작업은
           진짜 시트 ID 를 그대로 쓰면서 무시트가 된다).
           ★ 판정 단일 출처 = `sheetlessScope.isSheetless`(이름 → gid 폴백). 그 함수는 조회
             실패를 false 로 접으므로 **모르면 종전(시트) 어휘**가 된다 — 표시 계층이라
             그 방향이 안전하다(무시트 작업에 "시트"라고 적는 쪽이, 시트 작업에 "작업표"라고
             적어 담당자가 시트를 안 보게 되는 쪽보다 덜 위험하다). */
        let sheetless = false;
        try {
          sheetless = await require('../utils/sheetlessScope')
            .isSheetless(pool, c0.linked_sheet_id, c0.linked_tab_name);
        } catch (slErr) { sheetless = false; }
        sheetInfo = {
          tabName: c0.linked_tab_name,
          sheetless,
          rosterRows,
          confirmed,
          diff: rosterRows > 0 ? rosterRows - confirmed : null,
          unmatched,
          unmatchedCounts,
          schedule: await describeTabDates(pool, c0.linked_sheet_id, c0.linked_tab_gid, new Date()),
        };
      }
    } catch (siErr) { logger.warn('[campaign/admin/applications] 시트 대조 실패: ' + siErr.message); }

    res.json({ ok: true, data: rows, count: rows.length, options, sheetInfo });
  } catch (err) {
    next(err);
  }
});

// GET /api/campaign/admin/:id/preview — 관리자: 리뷰어 참여 화면 미리보기 (읽기 전용)
//   ★ 격리 원칙: 무인증 리뷰어 경로 `GET /:id/work-detail` 은 **일절 미변경**. 관리자 전용 별도 라우트로
//     같은 shape을 합성해 돌려준다(리뷰어 게이트에 관리자 분기를 심지 않음 = 폭발반경 0).
//   ★ 부작용 0: campaign_applications INSERT/UPDATE 없음 — 홀드·정원·일일한도 카운터 무오염.
//     application 은 화면 렌더용 **가짜 객체**(id:'preview')이며 DB에 존재하지 않는다.
//   ★ 마감(closed)·오픈전 공고도 열람 가능(관리자가 진행 화면을 확인하는 것이 목적).
//   ★ 접근 제어: authMiddleware + adminOrMaster. 리뷰어앱 스코프 토큰(via:'reviewer_campaign')은
//     PUT /api/campaign/admin/:id 끝앵커로만 허용되므로 이 경로(GET + /preview 하위)엔 도달 불가.
router.get('/admin/:id/preview', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: camps } = await pool.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
    if (camps.length === 0) return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' });
    const camp = camps[0];
    if (!camp.participation_mode) {
      return res.status(400).json({ ok: false, error: '참여형 공고가 아닙니다. (리뷰어 참여 화면이 없는 공고)' });
    }

    const now = new Date();
    const st = computeCampaignState(camp, (await fetchCampaignCounts(pool, [id], now)).get(id), now);
    const optionsRaw = await _loadOptionViews(pool, id, st, now);
    // 미리보기용 대표 옵션 — 선택 가능한 첫 옵션(없으면 첫 옵션). 실제 선택이 아니라 화면 예시.
    const sample = optionsRaw.find(o => o.selectable) || optionsRaw[0] || null;
    const options = _optionListForReviewer(optionsRaw);   // ★ 실제 리뷰어 응답과 같은 모양(미리보기 ≠ 실화면 금지)
    /**
     * ★★ 미리보기 전용 재료 — 선택지별 유입가이드 맵(optKey → {html, images}).
     *
     * 위 `options` 는 실제 리뷰어 응답과 같은 모양이라 선택지별 가이드가 **덜어져 있다**
     * (고르지도 않은 선택지의 안내 HTML·사진을 리뷰어에게 통째로 보내지 않는 규칙).
     * 그런데 미리보기 화면은 옵션을 고를 때 그 목록에서 선택지를 다시 찾으므로,
     * 재료가 없으면 **고르는 순간 가이드가 사라진다**(2026-08-25 실측 — 미리보기는 항상
     * 옵션을 고르고 들어가는 흐름이라 선택지 전 건이 "등록된 유입가이드가 없어요"로 보였다).
     *
     * ★ 목록의 모양은 그대로 두고(계약 불변) 재료만 따로 싣는다.
     * ★ 이 경로는 adminOrMaster 게이트 뒤 — 관리자는 그 값을 편집하는 주체다.
     * ★ 리뷰어 경로(`/work-detail`)는 무접촉: 거기는 서버가 고른 selectedOption 이 원본이라 정상이다.
     */
    const optionGuides = {};
    for (const o of optionsRaw) {
      if (!o || !o.optKey) continue;
      optionGuides[o.optKey] = {
        inflowGuideHtml: o.inflowGuideHtml || '',
        inflowGuideImages: Array.isArray(o.inflowGuideImages) ? o.inflowGuideImages : [],
      };
    }
    const workDetail = sanitizeWorkDetail(camp.work_detail);
    // 미리보기에도 모집공고 직접 설정을 우선 적용한다.
    const inflowType = (workDetail && workDetail.inflowType) || (await _lookupInflowType(camp.id, camp.source_work_order_id)) || '';
    const ttlMin = Number(camp.hold_ttl_min) || 30;

    res.json({
      ok: true,
      preview: true,                        // 프론트 배너·가드의 단일 신호
      serverNow: now.toISOString(),
      state: st.state,                      // 실제 캠페인 상태(마감/오픈전 등 — 배너에 표기)
      application: {                        // ★ 가짜(미저장) — 화면 렌더 전용
        id: 'preview',
        status: 'applied',
        appliedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMin * 60000).toISOString(),
        submittedAt: null,
        optionKey: sample ? sample.optKey : null,
      },
      options,
      selectedOption: sample,
      optionGuides,                         // 미리보기에서 고른 선택지의 유입가이드 재료(가산 필드)
      canChangeOption: false,               // 미리보기에서는 옵션 변경 불가(서버 상태 무변경)
      workDetail,
      inflowType,
      cashReceipt: await _cashReceiptInfo(camp),   // 미리보기 = 실제 화면(현영 안내 카드 포함)
      chatUrl: camp.chat_url || '',         // 관리자는 원래 카톡 URL을 설정·조회하는 주체
      landingUrl: camp.landing_url || '',
      form: {
        sheetId: camp.linked_sheet_id || '',
        gid: camp.linked_tab_gid || '',
        tabName: camp.linked_tab_name || '',
        displayName: camp.title || '',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/campaign/admin/:id/confirm {applicationId} — 만료+기구매(late) 구제의 유일 경로 (admin/master)
//   유예 정책 제거에 따라, 만료 후 도착한 제출(late_order_id)은 이 수동확정으로만 자리 확정된다.
//   잠금 계층 apply·주문확정과 동일: 캠페인 행 FOR UPDATE → 신청 행 FOR UPDATE. 동일 phone8 applied 선-취소(레드 #7).
router.post('/admin/:id/confirm', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  const { id } = req.params;
  const appId = parseInt(req.body.applicationId, 10);
  if (!appId) return res.status(400).json({ ok: false, error: 'applicationId 필수' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!cRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' }); }
    if (!cRows[0].participation_mode) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, error: '참여형 공고가 아닙니다.' }); }
    const { rows: t } = await client.query(
      `SELECT * FROM campaign_applications WHERE id = $1 AND campaign_id = $2 FOR UPDATE`, [appId, id]);
    if (!t.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '신청을 찾을 수 없습니다.' }); }
    const a = t[0];
    if (a.status === 'submitted') { await client.query('ROLLBACK'); return res.json({ ok: true, already: true }); } // 멱등
    if (!['applied', 'expired', 'cancelled'].includes(a.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: `'${a.status}' 상태는 확정 대상이 아닙니다(레거시 오확정 방지).` });
    }
    // 레드 #7: 같은 (campaign, phone8)의 다른 활성행 정리 — submitted 존재 시 이중확정 거부, applied는 선-취소
    const { rows: dup } = await client.query(
      `SELECT id FROM campaign_applications WHERE campaign_id = $1 AND phone8 = $2 AND id <> $3 AND status = 'submitted' LIMIT 1`,
      [id, a.phone8, appId]);
    if (dup.length) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, error: `이미 확정된 참여(#${dup[0].id})가 있습니다.` }); }
    await client.query(
      `UPDATE campaign_applications SET status = 'cancelled'
        WHERE campaign_id = $1 AND phone8 = $2 AND id <> $3 AND status = 'applied'`, [id, a.phone8, appId]);
    // 레드 #8②: submitted_at 소급 — late 주문의 제출시각(order_submissions.submitted_at = 생성시각; created_at 컬럼 없음, 심판 J5)
    //   → 없으면 applied_at → NOW(). 과거시각 소급 = 오늘 쿼터 미소비("일 시작 고정" 약속 보존).
    await client.query(
      `UPDATE campaign_applications ca
          SET status = 'submitted',
              dismissed_at = NULL, dismissed_by = NULL,
              submitted_at = COALESCE(
                (SELECT os.submitted_at FROM order_submissions os WHERE os.id = ca.late_order_id),
                ca.applied_at, NOW()),
              order_submission_id = COALESCE(ca.order_submission_id, ca.late_order_id)
        WHERE ca.id = $1`, [appId]);
    const { maybePersistClosed } = require('../services/campaignHold.service');
    await maybePersistClosed(client, id); // 레드 #8③: 수동 경로도 closed 영속 복제
    await client.query('COMMIT');
    logger.info(`[campaign/confirm] 수동확정 camp=${id} app=${appId} by=${req.admin && req.admin.name}`);
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (err.code === '23505') return res.status(409).json({ ok: false, error: '동일 리뷰어의 활성 참여와 충돌 — 새로고침 후 재시도하세요.' });
    next(err);
  } finally {
    client.release();
  }
});

/* ═══ 127 블로그 승인제 — 승인/반려 (사용자 확정 2026-08-19) ═══
   승인 = blog_pending → 'applied' + expires_at=NOW()+구매기한(기본 24h = BLOG_PURCHASE_TTL_MIN)
     → 그 뒤로는 **기존 홀드 파이프라인 그대로**(카운트·스윕(만료→expired)·확정·late 구제·work-detail).
   반려 = blog_pending → 'blog_rejected' + 사유(필수 — 리뷰어 화면에 그대로 표시) → 즉시 재신청 가능.
   ★ 승인 시점에 정원 재검사(사용자 확정 ① "승인한 사람만 센다" — 대기는 미점유이므로 승인이 소비 시점).
     잠금 계층 = confirm 과 동일(캠페인 행 FOR UPDATE → 신청 행 FOR UPDATE).
   ★ 알림(사용자 확정 ④ 둘 다): 공고 페이지 상태 표시(work-detail reason) + 1:1 문의 자동 메시지
     (csBridge.postAdminNotice — COMMIT 뒤 fail-soft, 통지 실패가 승인/반려를 되돌리지 않는다). */
const BLOG_PURCHASE_TTL_MIN = () => {
  const v = parseInt(process.env.BLOG_PURCHASE_TTL_MIN || '1440', 10);
  return (Number.isFinite(v) && v > 0) ? v : 1440;
};

async function _notifyBlogDecision(camp, app, text, by) {
  // 1:1 문의 자동 메시지 — 스레드 키는 연결 탭(sheetId||tabName). 무시트 공고도 가상 시트ID 로 성립.
  // ★ 절대 throw 하지 않는다(csBridge 규율). 연결 탭 없는 공고는 통지 생략(스레드 키가 없다).
  try {
    if (!camp.linked_tab_sheet_id || !camp.linked_tab_name) return;
    await require('../services/csBridge.service').postAdminNotice({
      sheetId: camp.linked_tab_sheet_id, tabName: camp.linked_tab_name,
      reviewerName: app.applicant_name, phone8: app.phone8, message: text, by,
    });
  } catch (e) { logger.warn(`[campaign/blog-decide] 1:1 통지 실패(무해): ${e.message}`); }
}

// POST /api/campaign/admin/:id/blog-approve {applicationId}
router.post('/admin/:id/blog-approve', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  const { id } = req.params;
  const appId = parseInt(req.body.applicationId, 10);
  if (!appId) return res.status(400).json({ ok: false, error: 'applicationId 필수' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!cRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' }); }
    const camp = cRows[0];
    const { rows: t } = await client.query(
      `SELECT * FROM campaign_applications WHERE id = $1 AND campaign_id = $2 FOR UPDATE`, [appId, id]);
    if (!t.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '신청을 찾을 수 없습니다.' }); }
    const a = t[0];
    if (a.status === 'applied') { await client.query('ROLLBACK'); return res.json({ ok: true, already: true, expiresAt: a.expires_at }); } // 멱등(더블클릭)
    if (a.status !== 'blog_pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: 'not_pending', status: a.status,
        error: `'${a.status}' 상태는 승인 대상이 아닙니다(승인 대기 건만 승인할 수 있어요).` });
    }
    /* ★ 정원 재검사 — 승인이 정원 소비 시점(사용자 확정 ①). 총원 0 = 무제한.
       사용량 = 제출확정 + 유효홀드(승인분 포함) — fetchCampaignCounts 와 같은 판정 시각 기준. */
    const total = Number(camp.recruit_total) || 0;
    if (total > 0) {
      const { rows: u } = await client.query(
        `SELECT COUNT(*) FILTER (WHERE status='submitted') AS sub,
                COUNT(*) FILTER (WHERE status='applied' AND expires_at > NOW()) AS holds
           FROM campaign_applications WHERE campaign_id = $1`, [id]);
      const used = (Number(u[0].sub) || 0) + (Number(u[0].holds) || 0);
      if (used >= total) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, reason: 'capacity_full', used, total,
          error: `정원이 가득 찼어요(확정+진행 ${used} / 총 ${total}). 총모집을 늘리거나 다른 신청을 정리한 뒤 승인하세요.` });
      }
    }
    /* ★ 옵션 정원 재검사 — 신청이 고른 옵션이 이미 소진됐으면 승인 불가(자리 없는 승인 금지). */
    if (a.option_key) {
      const { rows: opt } = await client.query(
        `SELECT recruit_total FROM campaign_options WHERE campaign_id = $1 AND opt_key = $2 LIMIT 1`, [id, a.option_key]);
      const optTotal = opt.length ? (Number(opt[0].recruit_total) || 0) : 0;
      if (optTotal > 0) {
        const { rows: ou } = await client.query(
          `SELECT COUNT(*) FILTER (WHERE status='submitted') AS sub,
                  COUNT(*) FILTER (WHERE status='applied' AND expires_at > NOW()) AS holds
             FROM campaign_applications WHERE campaign_id = $1 AND option_key = $2`, [id, a.option_key]);
        const optUsed = (Number(ou[0].sub) || 0) + (Number(ou[0].holds) || 0);
        if (optUsed >= optTotal) {
          await client.query('ROLLBACK');
          return res.status(409).json({ ok: false, reason: 'option_full', optionKey: a.option_key,
            error: `선택한 옵션(${a.option_key})의 정원이 가득 찼어요(${optUsed}/${optTotal}).` });
        }
      }
    }
    const ttlMin = BLOG_PURCHASE_TTL_MIN();
    const { rows: up } = await client.query(
      `UPDATE campaign_applications
          SET status = 'applied',
              expires_at = NOW() + make_interval(mins => $2),
              decided_at = NOW(), decided_by = $3, reject_reason = NULL
        WHERE id = $1 AND status = 'blog_pending'
        RETURNING expires_at`, [appId, ttlMin, String((req.admin && req.admin.name) || 'admin').slice(0, 100)]);
    if (!up.length) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, error: '상태가 바뀌었어요. 새로고침 후 다시 시도하세요.' }); }
    await client.query('COMMIT');
    logger.info(`[campaign/blog-approve] camp=${id} app=${appId} ttl=${ttlMin}m by=${req.admin && req.admin.name}`);
    const hours = Math.round(ttlMin / 60);
    await _notifyBlogDecision(camp, a,
      `블로그체험단 참여가 승인되었어요! 🎉\n공고 페이지에서 ${hours}시간 안에 구매를 진행하고 구매양식을 제출해주세요. 기한이 지나면 자리가 자동 취소됩니다.`,
      (req.admin && req.admin.name) || 'admin');
    res.json({ ok: true, expiresAt: up[0].expires_at });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (err.code === '23505') return res.status(409).json({ ok: false, error: '같은 명의의 활성 참여와 충돌 — 새로고침 후 재시도하세요.' });
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/campaign/admin/:id/blog-reject {applicationId, reason}
router.post('/admin/:id/blog-reject', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  const { id } = req.params;
  const appId = parseInt(req.body.applicationId, 10);
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  if (!appId) return res.status(400).json({ ok: false, error: 'applicationId 필수' });
  // ★ 사유 필수 — 리뷰어 화면·1:1 문의에 그대로 전달된다(사유 없는 반려는 리뷰어가 고칠 방법을 모른다).
  if (!reason) return res.status(400).json({ ok: false, error: '반려 사유를 입력해주세요(리뷰어에게 그대로 전달됩니다).' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!cRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' }); }
    const camp = cRows[0];
    const { rows: t } = await client.query(
      `SELECT * FROM campaign_applications WHERE id = $1 AND campaign_id = $2 FOR UPDATE`, [appId, id]);
    if (!t.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '신청을 찾을 수 없습니다.' }); }
    const a = t[0];
    if (a.status === 'blog_rejected') { await client.query('ROLLBACK'); return res.json({ ok: true, already: true }); } // 멱등
    if (a.status !== 'blog_pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, reason: 'not_pending', status: a.status,
        error: `'${a.status}' 상태는 반려 대상이 아닙니다(승인 대기 건만 반려할 수 있어요).` });
    }
    await client.query(
      `UPDATE campaign_applications
          SET status = 'blog_rejected', reject_reason = $2, decided_at = NOW(), decided_by = $3
        WHERE id = $1 AND status = 'blog_pending'`,
      [appId, reason, String((req.admin && req.admin.name) || 'admin').slice(0, 100)]);
    await client.query('COMMIT');
    logger.info(`[campaign/blog-reject] camp=${id} app=${appId} by=${req.admin && req.admin.name}`);
    await _notifyBlogDecision(camp, a,
      `블로그체험단 참여 신청이 반려되었어요.\n사유: ${reason}\n블로그 주소를 확인한 뒤 공고 페이지에서 바로 다시 신청할 수 있어요.`,
      (req.admin && req.admin.name) || 'admin');
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/campaign/admin/:id/dismiss {applicationId} — 취소확정(미참여) (admin/master)
//   만료·취소된 참여를 관리자가 "미참여로 취소 확정" → dismissed_at 기록.
//   이후 관제 수동확정 버튼·지각(late) 빨간 배지·만료 집계에서 제외돼 "다시 알림이 뜨지 않는다".
//   ★ 이미 자리를 반환한 종료 상태(expired/cancelled)에만 붙는 마커라 quota/유효홀드 불변.
//     order_submissions·시트는 건드리지 않는다(주문 취소는 별도 [주문취소] 경로).
//   잠금 계층은 confirm과 동일: 캠페인 행 FOR UPDATE → 신청 행 FOR UPDATE(동일행 confirm↔dismiss 직렬화).
router.post('/admin/:id/dismiss', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  const { id } = req.params;
  const appId = parseInt(req.body.applicationId, 10);
  if (!appId) return res.status(400).json({ ok: false, error: 'applicationId 필수' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cRows } = await client.query('SELECT id, participation_mode FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!cRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '캠페인을 찾을 수 없습니다.' }); }
    if (!cRows[0].participation_mode) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, error: '참여형 공고가 아닙니다.' }); }
    const { rows: t } = await client.query(
      `SELECT id, status, dismissed_at FROM campaign_applications WHERE id = $1 AND campaign_id = $2 FOR UPDATE`, [appId, id]);
    if (!t.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: '신청을 찾을 수 없습니다.' }); }
    const a = t[0];
    if (a.dismissed_at) { await client.query('ROLLBACK'); return res.json({ ok: true, already: true }); } // 멱등
    if (a.status === 'submitted') {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: '이미 제출확정된 참여입니다(취소는 [주문취소]로 처리하세요).' });
    }
    if (!['expired', 'cancelled'].includes(a.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: `'${a.status}' 상태는 취소확정 대상이 아닙니다(만료·취소 건만).` });
    }
    // status='cancelled'로 통일 + dismissed_at 기록. quota/유효홀드 불변(종료 상태 마커).
    await client.query(
      `UPDATE campaign_applications SET status = 'cancelled', dismissed_at = NOW(), dismissed_by = 'admin'
        WHERE id = $1`, [appId]);
    await client.query('COMMIT');
    logger.info(`[campaign/dismiss] 취소확정 camp=${id} app=${appId} by=${req.admin && req.admin.name}`);
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    next(err);
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════
// 내부: 시트 행 자동 추가
// ═══════════════════════════════════════════════════════════

/**
 * 캠페인 참여 시 연결된 시트 탭에 행 추가
 * 헤더를 읽어서 매핑 후 appendSheet 사용
 */
async function _addApplicationToSheet(campaign, applicant) {
  const { linked_sheet_id, linked_tab_name, linked_tab_gid } = campaign;
  if (!linked_sheet_id || !linked_tab_name) return;

  /* 이관된 작업(무시트)은 시트에 쓰지 않고 작업표에 넣는다 — 그 시트는 아무도 읽지 않으므로
     여기서 append 하면 참여자가 명단에서 통째로 사라진다. 실패는 throw 로 드러난다
     (호출부가 catch 해 sheet_row_added 를 안 세우고 로그를 남긴다). */
  const _sl = await require('../services/sheetlessApplicant.service')
    .addApplicantRow({ sheetId: linked_sheet_id, tabName: linked_tab_name, applicant });
  if (_sl && _sl.handled) return;

  const opts = linked_tab_gid ? { gid: linked_tab_gid } : {};
  const escapedTab = linked_tab_name.replace(/'/g, "''");

  // 상위 50행 읽어서 헤더 탐색
  const allRows = await readSheet(linked_sheet_id, `'${escapedTab}'!A1:ZZ50`, opts);
  if (!allRows || allRows.length === 0) {
    throw new Error('시트 데이터를 읽을 수 없습니다.');
  }

  // 헤더 행 감지 — 키워드 표도 utils/applicantColumns 단일 출처(사본을 두면 두 경로가 다른 줄을 헤더로 본다).
  const { isApplicantHeaderRow } = require('../utils/applicantColumns');
  let headerRow = null;
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(allRows.length, 50); i++) {
    const cells = (allRows[i] || []).map(c => String(c || '').trim());
    if (isApplicantHeaderRow(cells)) { headerRow = cells; headerRowIdx = i; break; }
  }

  if (!headerRow) {
    throw new Error('시트에서 헤더 행을 감지할 수 없습니다.');
  }

  // 헤더 매핑: 이름/연락처/인애드명 컬럼 찾기
  // 열 판정은 utils/applicantColumns 단일 출처 — 무시트 경로와 **같은 별칭·같은 매칭**이라야
  // "시트 작업은 연락처가 들어가는데 이관된 작업은 빈칸"처럼 갈리지 않는다.
  const _ac = require('../utils/applicantColumns').resolveApplicantColumns(headerRow);
  const nameColIdx = _ac.name;
  const phoneColIdx = _ac.phone;
  const inadColIdx = _ac.inad;
  const numColIdx = _ac.num;

  if (nameColIdx < 0) {
    throw new Error('시트에서 이름 컬럼을 찾을 수 없습니다.');
  }

  // 현재 데이터 행 수 파악 (번호 자동 부여용)
  const dataRows = allRows.slice(headerRowIdx + 1);
  const nextNum = dataRows.length + 1;

  // 새 행 구성 (헤더 길이만큼 빈 셀로 채운 후 매핑)
  const newRow = new Array(headerRow.length).fill('');
  
  if (numColIdx >= 0) newRow[numColIdx] = nextNum;
  newRow[nameColIdx] = applicant.name;
  if (phoneColIdx >= 0 && applicant.phone) newRow[phoneColIdx] = applicant.phone;
  if (inadColIdx >= 0 && applicant.inad) newRow[inadColIdx] = applicant.inad;

  // appendSheet로 행 추가
  await appendSheet(
    linked_sheet_id,
    `'${escapedTab}'!A1`,
    [newRow],
    opts
  );

  logger.info(`[campaign/sheet] 행 추가 완료: ${linked_tab_name} - ${applicant.name} (행 ${headerRowIdx + 1 + nextNum})`);
}

module.exports = router;
