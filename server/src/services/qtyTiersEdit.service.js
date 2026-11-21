'use strict';
/**
 * ★★ 결정 392(R1) — 접수된 오더의 구매수량 단계를 「이 오더에서」 고칠 수 있나. 읽기 전용 · 실패 = 못 고침(fail-closed).
 *
 *   같은 함수를 두 곳이 부른다(사본 0 · 결정 163·332 모양):
 *     ① GET /api/order/intake/source/:id/shared — 인트라넷 수정 창이 열 때(잠금 없음 · 응답 `qty_tiers_edit`)
 *     ② 공유 저장(applySharedPatch) — L1 → 작업오더 행 → 탭 잠금 → 공고 행 잠금 **뒤** 같은 트랜잭션에서(잠근 공고 행을 넘긴다)
 *
 *   「신청 0」 = 결정 254 판정과 같은 범위(workTabDelete.campaignUseCounts — 작업보드 전체 · 보관 공고 포함 · 취소·만료 포함 · Q3 ㉠)
 *     + 그 공고 자체(작업보드 연결이 없는 공고 대비). 254 의 다른 사유(사람이 연 열·참여 링크·메모)는 쓰지 않는다(레드 24).
 *   ★ 연결 상태는 `/shared` 가 이미 계산한 `active`(bidir_state='on' && 스위치 in2rw='apply' — 비상 스위치는 readBidirSwitch 가 이미 접는다) 하나만 받는다(N1 · 식 사본 0).
 *   ★ 숫자를 0 으로 꾸미지 않는다 — 조회 실패면 applicants/filled_rows = null + 사유 check_failed.
 *   사유 순서 = 화면 문구 우선순위. 저장 409 의 code = 사유 첫 번째.
 */
const REASON = Object.freeze({
  not_active: 'bidir_not_active',        // 연결 off·diverged · in2rw≠apply · 비상 스위치
  old_window: 'tiers_not_capable',       // 창이 단계 고치기를 모름(caps/bidir.tiers 없음)
  tiers_off: 'quantity_tiers_off',       // CAMPAIGN_QTY_TIERS=0
  kind: 'kind_no_tiers',                 // 블로그·Q&A(Q1 ㉠)
  dual: 'dual_channel',                  // 동시진행(정규화가 이미 400 — 화면 안내용)
  no_campaign: 'no_campaign',            // 공고 없는 접수 오더(정책 ⑤)
  archived: 'quantity_tiers_archived',   // 살아 있는 공고 없음 + 보관 공고 있음(정책 ⑥)
  shared_tab: 'shared_worktable',        // 같은 작업보드에 살아 있는 공고 2+
  rounds: 'rounds_exist',                // 차수 운영 공고
  in_use: 'quantity_tiers_in_use',       // 신청 기록·공고 주문 > 0 (정책 ①)
  filled: 'worktable_filled',            // 작업보드 채운 줄 > 0 (정책 ①)
  failed: 'check_failed',
});

/** 저장 거절 코드 → 한국어 문구(인트라넷이 서버 error 를 그대로 보여 준다 · 결정 163). */
function tierRejectText(code, v = {}) {
  const tail = ' 단계를 원래대로 두고 저장하면 나머지 수정은 전달됩니다.';
  switch (code) {
    case 'bidir_not_active': return '리뷰웹과 연결이 꺼져 있거나 맞추는 중인 오더라 구매수량 단계를 바꿀 수 없습니다.' + tail;
    case 'tiers_not_capable': return '이 수정 창은 구매수량 단계 고치기를 모르는 옛 화면입니다. 창을 닫고 다시 열어 주세요.';
    case 'quantity_tiers_off': return '지금은 구매수량 단계 기능이 꺼져 있어 바꿀 수 없습니다.' + tail;
    case 'kind_no_tiers': return '블로그·Q&A 체험단은 구매수량 단계를 쓰지 않습니다.' + tail;
    case 'dual_channel': return '동시진행(네이버+쿠팡) 상품은 구매수량 단계를 쓸 수 없습니다.' + tail;
    case 'no_campaign': return '아직 모집공고가 없는 오더라 이 창에서는 구매수량 단계를 바꿀 수 없습니다.' + tail;
    case 'quantity_tiers_archived': return '이 오더의 모집공고가 보관돼 있어 구매수량 단계를 바꿀 수 없습니다.' + tail;
    case 'shared_worktable': return '같은 작업보드를 쓰는 모집공고가 여럿이라 구매수량 단계를 바꿀 수 없습니다. 담당자에게 문의해 주세요.';
    case 'rounds_exist': return '차수로 운영하는 모집공고라 구매수량 단계를 바꿀 수 없습니다. 담당자에게 문의해 주세요.';
    case 'quantity_tiers_in_use': return `이 작업의 모집공고에 이미 신청한 분이 ${Number(v.applicants) || 0}명 있어(취소·만료 포함) 구매수량 단계를 바꿀 수 없습니다.` + tail;
    case 'worktable_filled': return `작업보드에 이미 주문·이름이 들어간 줄이 ${Number(v.filled_rows) || 0}개 있어 구매수량 단계를 바꿀 수 없습니다.` + tail;
    case 'check_failed': return '신청한 분이 있는지 확인하지 못해 구매수량 단계를 바꾸지 않았습니다. 잠시 뒤 다시 저장해 주세요.';
    case 'quantity_tiers_stale_base': return '수정 창을 연 뒤 리뷰웹에서 상품 구성이 바뀌어 구매수량 단계를 저장하지 않았습니다. 창을 닫고 다시 열어 저장해 주세요.';
    case 'quantity_tiers_with_structure': return '구매수량 단계는 상품·옵션 더하기·지우기·이름 바꾸기와 따로 저장해 주세요.';
    case 'quantity_tiers_pay_missing': return '구매수량 단계를 바꿨는데 결제합계가 함께 오지 않아 저장하지 않았습니다. 창을 닫고 다시 열어 저장해 주세요.';
    case 'quantity_tiers_option_counts': return '구매수량 단계를 고치는 저장에서는 아직 옵션별 인원을 함께 바꿀 수 없습니다(작업보드 빈 줄의 옵션 표시가 어긋납니다). 옵션 인원은 그대로 두고 총원·단계만 바꿔 주세요.';
    case 'option_rows_review_mix': return '리뷰타입(포토·텍스트) 수량을 섞어 쓰는 작업이라 옵션별 인원을 바꾸면 작업보드 줄의 리뷰옵션이 어긋납니다. 옵션 인원은 그대로 두고 저장해 주세요.';
    case 'link_changed_retry': return '연결 공고가 방금 바뀌었습니다. 잠시 뒤 다시 저장해 주세요.';
    default: return '구매수량 단계를 바꿀 수 없어 저장하지 않았습니다.' + tail;
  }
}

/** 단계를 처음 넣으면 그때부터 구조(상품·옵션 더하기/지우기·리뷰타입)가 잠기나 — 규칙 단일 출처 structurePermanentlyLocked(Q4 ㉠ · 화면 확인창 재료). */
function locksStructure(wo) {
  const sp = require('./sharedPatch.service');   // 순환 require — 함수 안에서(기존 관행)
  const st = sp.readSharedState(wo || {});
  let list = [];
  try { list = JSON.parse(st.product_options_json || '[]'); } catch (_) { return false; }
  if (!Array.isArray(list)) return false;
  const { isEmptyQtyTiers } = require('./productOptions.service');
  if (list.some(p => p && typeof p === 'object' && !isEmptyQtyTiers(p.qty_tiers))) return false;   // 이미 단계 있음 = 이미 잠김
  const noTiers = { ...st, product_options_json: JSON.stringify(list.map(p => { if (!p || typeof p !== 'object') return p; const c = { ...p }; delete c.qty_tiers; return c; })) };
  return !sp.structurePermanentlyLocked(noTiers);
}

/**
 * @param q        (sql, params) => Promise<{rows}>  — 읽기는 pool, 저장은 같은 트랜잭션 client
 * @param wo       작업오더 행
 * @param camp     undefined = 찾는다(읽기) · null/행 = 호출부가 잠근 살아 있는 공고(저장)
 * @param tiersCapable 창이 단계 고치기를 아는가
 * @param active   /shared 의 active 와 같은 값(저장 경로는 이미 on+apply 로 들어왔다 = true)
 * @returns {{allowed:boolean, reasons:string[], applicants:number|null, filled_rows:number|null, campaign_id:string|null, locks_structure:boolean}}
 */
async function qtyTiersEditVerdict(q, { wo, camp = undefined, tiersCapable, active }) {
  const out = { allowed: false, reasons: [], applicants: 0, filled_rows: 0, campaign_id: null, locks_structure: false };
  try {
    const reasons = out.reasons;
    if (!wo || active !== true) reasons.push(REASON.not_active);
    if (tiersCapable !== true) reasons.push(REASON.old_window);
    const qt = require('./campaignQtyTiers.service');
    const { CANON } = require('../utils/sharedFields');
    const kind = CANON.workKind(wo && wo.work_kind);
    if (!qt.enabled()) reasons.push(REASON.tiers_off);
    else if (!qt.copiesFor(kind)) reasons.push(REASON.kind);
    if (require('../utils/dualChannel').rawHasDualChannels(wo && wo.product_options_json)) reasons.push(REASON.dual);
    if (wo) {
      if (camp === undefined) {
        const live = await require('./linkedRecruitQuota.service').liveCampaignForWorkOrders({ query: q }, [wo.id]);
        camp = live ? ((await q('SELECT * FROM recruit_campaigns WHERE id = $1', [live.id])).rows[0] || null) : null;
      }
      if (!camp) {
        const { rows: arch } = await q(`SELECT 1 FROM recruit_campaigns WHERE archived_at IS NOT NULL
            AND (id = NULLIF($1, '') OR NULLIF(source_work_order_id, '') = $2) LIMIT 1`, [String(wo.linked_campaign_id || ''), String(wo.id)]);
        reasons.push(arch.length ? REASON.archived : REASON.no_campaign);
      } else {
        out.campaign_id = camp.id;
        const sheet = String(camp.linked_sheet_id || ''), tab = String(camp.linked_tab_name || '');
        if (sheet && tab) {
          const { rows: sh } = await q(`SELECT COUNT(*)::int AS n FROM recruit_campaigns WHERE archived_at IS NULL AND linked_sheet_id = $1 AND linked_tab_name = $2 AND id <> $3`, [sheet, tab, camp.id]);
          if (Number(sh[0] && sh[0].n) > 0) reasons.push(REASON.shared_tab);
        }
        // 차수 표가 없는 DB 도 있다 — 트랜잭션을 깨지 않게 먼저 표가 있는지 본다(실패 쿼리는 같은 트랜잭션을 망가뜨린다)
        const { rows: hasRounds } = await q(`SELECT to_regclass('public.campaign_rounds') IS NOT NULL AS x`);
        if (hasRounds[0] && hasRounds[0].x) {
          const { rows: rd } = await q('SELECT 1 FROM campaign_rounds WHERE campaign_id = $1 LIMIT 1', [camp.id]);
          if (rd.length) reasons.push(REASON.rounds);
        }
        // ★ 「신청 0」 = 결정 254 범위 한 벌(작업보드 단위) + 이 공고 자체
        const u = sheet && tab ? await require('./workTabDelete.service').campaignUseCounts(q, sheet, tab) : { applications: 0, campaignOrders: 0, filledRows: 0 };
        const { rows: own } = await q(`SELECT (SELECT COUNT(*) FROM campaign_applications WHERE campaign_id = $1)::int AS a,
            (SELECT COUNT(*) FROM order_submissions WHERE sheet_id = 'campaign:' || $1)::int AS o`, [camp.id]);
        out.applicants = Math.max(u.applications, Number(own[0].a) || 0) + Math.max(u.campaignOrders, Number(own[0].o) || 0);
        out.filled_rows = u.filledRows;
        if (out.applicants > 0) reasons.push(REASON.in_use);
        if (out.filled_rows > 0) reasons.push(REASON.filled);
      }
    }
    out.reasons = [...new Set(reasons)];
    out.allowed = out.reasons.length === 0;
    out.locks_structure = locksStructure(wo);
  } catch (e) {
    require('../utils/logger').logger.warn(`[qty-tiers-edit] ${wo && wo.id} 판정 실패(못 고침으로 접음): ${e.message}`);
    return { allowed: false, reasons: [REASON.failed], applicants: null, filled_rows: null, campaign_id: null, locks_structure: false };
  }
  return out;
}

/** 읽기 판정 상한(/shared 8초 안 · 넘으면 이 판정만 check_failed = 잠금). 결정 332 종류 판정에는 씌우지 않는다(N5). */
const VERDICT_DEADLINE_MS = 2500;
function withDeadline(promise, ms = VERDICT_DEADLINE_MS) {
  const fallback = { allowed: false, reasons: [REASON.failed], applicants: null, filled_rows: null, campaign_id: null, locks_structure: false };
  let t;
  return Promise.race([promise, new Promise(res => { t = setTimeout(() => res(fallback), ms); })]).finally(() => clearTimeout(t));
}

module.exports = { qtyTiersEditVerdict, tierRejectText, locksStructure, withDeadline, VERDICT_DEADLINE_MS, REASON };
